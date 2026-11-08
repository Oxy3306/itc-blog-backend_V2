import { Router } from 'express';
import { signReview, requireRole } from '../auth.js';
import { transaction } from '../db.js';
import { ARTICLE_COLUMNS, ARTICLE_JOINS, toArticle, toArticleWithBody } from '../serialize.js';
import { average, badRequest, conflict, hoursBetween, notFound, nowIso, queryString, round1, validator } from '../util.js';

const ASSIGNMENT_STATUSES = ['assigned', 'completed', 'returned'];

// Reviewer workspace: Review Queue + Review Article pages.
export function reviewRoutes({ db, config, auth }) {
  const router = Router();
  router.use(auth.requireAuth, requireRole('reviewer', 'admin'));

  const assignmentJson = (a) => ({
    id: a.assignment_id,
    // e.g. ITC-2026-084-AWQ (shown on the Review Article page)
    dispatchId: `ITC-${a.assigned_at.slice(0, 4)}-${String(a.assignment_id).padStart(3, '0')}-${a.ref_code.split('-')[0]}`,
    status: a.assignment_status,
    priority: a.priority,
    revision: a.assignment_revision,
    assignedAt: a.assigned_at,
    dueAt: a.due_at,
    overdue: a.assignment_status === 'assigned' && Date.parse(a.due_at) < Date.now(),
    completedAt: a.completed_at,
    returnedAt: a.returned_at,
    cancelledByAdmin: a.cancelled_by !== null && a.cancelled_by !== undefined,
  });

  const ASSIGNMENT_COLUMNS = `
    ra.id AS assignment_id, ra.status AS assignment_status, ra.priority, ra.revision AS assignment_revision,
    ra.assigned_at, ra.due_at, ra.completed_at, ra.returned_at, ra.cancelled_by`;

  // Reviewers only ever see their own assignments; anything else is a plain 404.
  const getMine = (id, userId) => {
    const row = /^\d+$/.test(String(id))
      ? db
          .prepare(
            `SELECT ${ASSIGNMENT_COLUMNS}, ${ARTICLE_COLUMNS}, a.body
             FROM review_assignments ra JOIN articles a ON a.id = ra.article_id ${ARTICLE_JOINS}
             WHERE ra.id = ? AND ra.reviewer_id = ?`,
          )
          .get(Number(id), userId)
      : undefined;
    if (!row) throw notFound('Assignment');
    return row;
  };

  // Review Queue: stat cards + assigned manuscripts (urgent first, then by deadline).
  router.get('/queue', (req, res) => {
    const status = queryString(req.query, 'status') ?? 'assigned';
    if (!ASSIGNMENT_STATUSES.includes(status)) {
      throw badRequest('Validation failed', { status: `must be one of: ${ASSIGNMENT_STATUSES.join(', ')}` });
    }
    const rows = db
      .prepare(
        `SELECT ${ASSIGNMENT_COLUMNS}, ${ARTICLE_COLUMNS}
         FROM review_assignments ra JOIN articles a ON a.id = ra.article_id ${ARTICLE_JOINS}
         WHERE ra.reviewer_id = ? AND ra.status = ?
         ORDER BY (ra.priority = 'high') DESC, ra.due_at ASC, ra.id ASC`,
      )
      .all(req.user.id, status);

    const mine = db.prepare('SELECT priority, status, assigned_at, completed_at FROM review_assignments WHERE reviewer_id = ?').all(req.user.id);
    const startOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const completed = mine.filter((a) => a.status === 'completed');
    const turnaround = completed.map((a) => hoursBetween(a.assigned_at, a.completed_at));

    res.json({
      reviewerCode: req.user.public_code,
      stats: {
        pending: mine.filter((a) => a.status === 'assigned').length,
        urgent: mine.filter((a) => a.status === 'assigned' && a.priority === 'high').length,
        reviewedThisMonth: completed.filter((a) => a.completed_at >= startOfMonth).length,
        avgTurnaroundHours: turnaround.length ? round1(average(turnaround)) : null,
        slaHours: config.reviewSlaHours,
      },
      items: rows.map((r) => ({ assignment: assignmentJson(r), article: toArticle(r) })),
    });
  });

  // Review Article page: the manuscript plus feedback from earlier rounds.
  router.get('/assignments/:id', (req, res) => {
    const row = getMine(req.params.id, req.user.id);
    const own = db.prepare('SELECT decision, feedback, created_at FROM reviews WHERE assignment_id = ?').get(row.assignment_id);
    const myReview = own ? { decision: own.decision, feedback: own.feedback, createdAt: own.created_at } : null;

    // Once the assignment is closed (finished, returned, cancelled or withdrawn) the reviewer keeps their own record,
    // but no longer sees the manuscript: the author may have edited it since, and it is private until published.
    if (row.assignment_status !== 'assigned') {
      return res.json({
        reviewerCode: req.user.public_code,
        assignment: assignmentJson(row),
        article: { ...toArticle(row), bodyHidden: true },
        previousReviews: [],
        myReview,
      });
    }

    const previous = db
      .prepare('SELECT revision, decision, feedback, created_at FROM reviews WHERE article_id = ? ORDER BY id')
      .all(row.id)
      .map((r) => ({ revision: r.revision, decision: r.decision, feedback: r.feedback, createdAt: r.created_at }));
    res.json({
      reviewerCode: req.user.public_code,
      assignment: assignmentJson(row),
      article: toArticleWithBody(row),
      previousReviews: previous,
      myReview: null,
    });
  });

  // Approve, or request changes (feedback is mandatory for change requests).
  router.post('/assignments/:id/decision', (req, res) => {
    const data = validator(req.body)
      .oneOf('decision', ['approve', 'request_changes'])
      .string('feedback', { max: 5000, required: false })
      .done();
    const feedback = data.feedback ?? '';
    if (data.decision === 'request_changes' && feedback.length < 10) {
      throw badRequest('Validation failed', { feedback: 'is required (at least 10 characters) when requesting changes' });
    }

    const row = getMine(req.params.id, req.user.id);
    const decision = data.decision === 'approve' ? 'approved' : 'changes_requested';
    const createdAt = nowIso();

    const reviewId = transaction(db, () => {
      const fresh = db.prepare('SELECT status FROM review_assignments WHERE id = ?').get(row.assignment_id);
      const article = db.prepare('SELECT status, revision FROM articles WHERE id = ?').get(row.id);
      if (fresh.status !== 'assigned') throw conflict(`This assignment is already "${fresh.status}"`, 'assignment_closed');
      if (article.status !== 'pending_review' || article.revision !== row.assignment_revision) {
        throw conflict('This manuscript is no longer waiting for this review', 'assignment_closed');
      }
      const signature = signReview(config, {
        assignmentId: row.assignment_id, articleId: row.id, revision: row.assignment_revision,
        reviewerId: req.user.id, decision, feedback, createdAt,
      });
      const result = db
        .prepare(
          `INSERT INTO reviews (assignment_id, article_id, reviewer_id, revision, decision, feedback, signature, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(row.assignment_id, row.id, req.user.id, row.assignment_revision, decision, feedback, signature, createdAt);
      db.prepare(`UPDATE review_assignments SET status = 'completed', completed_at = ? WHERE id = ?`).run(createdAt, row.assignment_id);
      db.prepare('UPDATE articles SET status = ?, updated_at = ? WHERE id = ?').run(
        decision === 'approved' ? 'approved' : 'changes_requested', createdAt, row.id,
      );
      return Number(result.lastInsertRowid);
    });

    res.status(201).json({
      review: { id: reviewId, decision, feedback, reviewerCode: req.user.public_code, createdAt },
      articleStatus: decision === 'approved' ? 'approved' : 'changes_requested',
    });
  });

  // "Outside My Expertise // Reassign": NOT a rejection. The article goes back to the admin queue.
  router.post('/assignments/:id/return', (req, res) => {
    const data = validator(req.body)
      .string('reason', { min: 10, max: 2000 })
      .string('suggestedExpertise', { max: 200, required: false })
      .done();
    const row = getMine(req.params.id, req.user.id);

    transaction(db, () => {
      const fresh = db.prepare('SELECT status FROM review_assignments WHERE id = ?').get(row.assignment_id);
      if (fresh.status !== 'assigned') throw conflict(`This assignment is already "${fresh.status}"`, 'assignment_closed');
      db.prepare(
        `UPDATE review_assignments SET status = 'returned', returned_at = ?, return_reason = ?, suggested_expertise = ? WHERE id = ?`,
      ).run(nowIso(), data.reason, data.suggestedExpertise ?? null, row.assignment_id);
    });

    res.json({ returned: true, articleStatus: 'pending_review', message: 'The manuscript is back in the admin queue for reassignment.' });
  });

  return router;
}
