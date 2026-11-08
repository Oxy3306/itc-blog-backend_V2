import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { hashPassword, requireRole, reviewSignatureIsValid } from '../auth.js';
import { transaction } from '../db.js';
import { PRIORITIES, ROLES } from '../constants.js';
import { ARTICLE_COLUMNS, ARTICLE_FROM, ARTICLE_JOINS, toArticle, toUser } from '../serialize.js';
import { REF_CODE_PATTERN, badRequest, conflict, escapeLike, notFound, nowIso, queryString, slugify, validator } from '../util.js';

// Editorial board tools. The design has no admin screens, but the review flow needs these actions
// ("manual administrator reassignment", "authorized by the editorial board").
export function adminRoutes({ db, config, auth }) {
  const router = Router();
  router.use(auth.requireAuth, requireRole('admin'));

  const getArticle = (id) => {
    const row = /^\d+$/.test(String(id)) ? db.prepare('SELECT * FROM articles WHERE id = ?').get(Number(id)) : undefined;
    if (!row) throw notFound('Article');
    return row;
  };
  const articleJson = (id) =>
    toArticle(db.prepare(`SELECT ${ARTICLE_COLUMNS} FROM ${ARTICLE_FROM} WHERE a.id = ?`).get(id));

  // Articles waiting for a reviewer (including ones a reviewer sent back) + what is being reviewed right now.
  router.get('/queue', (req, res) => {
    const unassigned = db
      .prepare(
        `SELECT ${ARTICLE_COLUMNS} FROM ${ARTICLE_FROM}
         WHERE a.status = 'pending_review'
           AND NOT EXISTS (SELECT 1 FROM review_assignments ra WHERE ra.article_id = a.id AND ra.status = 'assigned')
         ORDER BY a.submitted_at ASC, a.id ASC`,
      )
      .all();
    const lastReturn = db.prepare(
      `SELECT ra.id, ra.reviewer_id, ru.public_code AS reviewer_code, ra.return_reason, ra.suggested_expertise, ra.returned_at, ra.cancelled_by
       FROM review_assignments ra JOIN users ru ON ru.id = ra.reviewer_id WHERE ra.article_id = ? AND ra.revision = ? AND ra.status = 'returned'
       ORDER BY ra.id DESC LIMIT 1`,
    );
    const inReview = db
      .prepare(
        `SELECT ra.id AS assignment_id, ra.priority, ra.assigned_at, ra.due_at, ra.reviewer_id, ru.name AS reviewer_name, ru.public_code AS reviewer_code,
                ${ARTICLE_COLUMNS}
         FROM review_assignments ra JOIN users ru ON ru.id = ra.reviewer_id
         JOIN articles a ON a.id = ra.article_id ${ARTICLE_JOINS}
         WHERE ra.status = 'assigned' ORDER BY ra.due_at ASC`,
      )
      .all();

    res.json({
      unassigned: unassigned.map((row) => {
        const ret = lastReturn.get(row.id, row.revision);
        return {
          article: toArticle(row),
          lastReturn: ret
            ? {
                reviewerId: ret.reviewer_id,
                reviewerCode: ret.reviewer_code,
                cancelled: ret.cancelled_by !== null, // true when an admin or the author took the assignment back
                reason: ret.return_reason,
                suggestedExpertise: ret.suggested_expertise,
                returnedAt: ret.returned_at,
              }
            : null,
        };
      }),
      inReview: inReview.map((r) => ({
        assignmentId: r.assignment_id,
        priority: r.priority,
        assignedAt: r.assigned_at,
        dueAt: r.due_at,
        overdue: Date.parse(r.due_at) < Date.now(),
        reviewer: { id: r.reviewer_id, name: r.reviewer_name, code: r.reviewer_code },
        article: toArticle(r),
      })),
    });
  });

  // People who can be given a manuscript, with their current workload.
  router.get('/reviewers', (req, res) => {
    const rows = db
      .prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM review_assignments ra WHERE ra.reviewer_id = u.id AND ra.status = 'assigned') AS open_assignments
         FROM users u WHERE u.role IN ('reviewer', 'admin') ORDER BY u.name`,
      )
      .all();
    res.json({ reviewers: rows.map((r) => ({ ...toUser(r), openAssignments: r.open_assignments })) });
  });

  router.post('/articles/:id/assign', (req, res) => {
    const data = validator(req.body)
      .int('reviewerId')
      .oneOf('priority', PRIORITIES, { required: false })
      .done();
    const article = getArticle(req.params.id);
    const reviewer = db.prepare('SELECT id, role FROM users WHERE id = ?').get(data.reviewerId);
    if (!reviewer || reviewer.role === 'author') {
      throw badRequest('Validation failed', { reviewerId: 'must be the id of a user with the reviewer (or admin) role' });
    }

    const assignmentId = transaction(db, () => {
      const fresh = db.prepare('SELECT status, revision, submitted_at, author_id FROM articles WHERE id = ?').get(article.id);
      if (fresh.status !== 'pending_review') {
        throw conflict(`Only articles waiting for review can be assigned (this one is "${fresh.status}")`, 'invalid_status');
      }
      if (fresh.author_id === reviewer.id) {
        throw conflict('A reviewer cannot review their own article', 'conflict_of_interest');
      }
      if (db.prepare(`SELECT 1 FROM review_assignments WHERE article_id = ? AND status = 'assigned'`).get(article.id)) {
        throw conflict('This article already has an active reviewer', 'already_assigned');
      }
      const now = new Date();
      const result = db
        .prepare(
          `INSERT INTO review_assignments (article_id, reviewer_id, assigned_by, revision, submitted_at, priority, assigned_at, due_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          article.id, reviewer.id, req.user.id, fresh.revision, fresh.submitted_at, data.priority ?? 'normal',
          now.toISOString(), new Date(now.getTime() + config.reviewSlaHours * 3_600_000).toISOString(),
        );
      return Number(result.lastInsertRowid);
    });

    const a = db.prepare('SELECT * FROM review_assignments WHERE id = ?').get(assignmentId);
    res.status(201).json({
      assignment: {
        id: a.id, articleId: a.article_id, reviewerId: a.reviewer_id, priority: a.priority,
        assignedAt: a.assigned_at, dueAt: a.due_at, status: a.status,
      },
    });
  });

  // A reviewer went quiet? Take the manuscript back so it can be given to someone else.
  router.post('/assignments/:id/cancel', (req, res) => {
    const { reason } = validator(req.body).string('reason', { max: 500, required: false }).done();
    const assignment = /^\d+$/.test(req.params.id) ? db.prepare('SELECT * FROM review_assignments WHERE id = ?').get(Number(req.params.id)) : undefined;
    if (!assignment) throw notFound('Assignment');
    if (assignment.status !== 'assigned') throw conflict(`This assignment is already "${assignment.status}"`, 'assignment_closed');
    db.prepare(
      `UPDATE review_assignments SET status = 'returned', returned_at = ?, return_reason = ?, suggested_expertise = NULL, cancelled_by = ?
       WHERE id = ? AND status = 'assigned'`,
    ).run(nowIso(), `Cancelled by the editorial board${reason ? `: ${reason}` : ''}`, req.user.id, assignment.id);
    res.json({ cancelled: true, articleStatus: 'pending_review', message: 'The manuscript is back in the admin queue.' });
  });

  router.post('/articles/:id/publish', (req, res) => {
    const article = getArticle(req.params.id);
    if (article.status !== 'approved') {
      throw conflict(`Only approved articles can be published (this one is "${article.status}")`, 'invalid_status');
    }
    const now = nowIso();
    db.prepare(`UPDATE articles SET status = 'published', published_at = ?, updated_at = ?, held_at = NULL, hold_reason = '' WHERE id = ?`).run(now, now, article.id);
    res.json({ article: articleJson(article.id) });
  });

  // Editorial reference codes such as "RFC-1049-DZ" or "AWQ-821" (the code shown on cards and in the review queue).
  router.patch('/articles/:id/ref-code', (req, res) => {
    const { refCode: raw } = validator(req.body).string('refCode', { min: 3, max: 40 }).done();
    const refCode = raw.toUpperCase();
    if (!REF_CODE_PATTERN.test(refCode)) {
      throw badRequest('Validation failed', { refCode: 'use letters and digits in groups separated by dashes, e.g. RFC-1049-DZ' });
    }
    const article = getArticle(req.params.id);
    const taken = db.prepare('SELECT id FROM articles WHERE ref_code = ? AND id != ?').get(refCode, article.id);
    if (taken) throw conflict('Another article already uses this reference code', 'ref_code_taken');
    db.prepare('UPDATE articles SET ref_code = ? WHERE id = ?').run(refCode, article.id);
    res.json({ article: articleJson(article.id) });
  });

  // Takes a published article offline and keeps it offline: it becomes "approved" but marked as taken down, so only an
  // admin can publish it again (the author sees the reason). Optional body: { "reason": "..." }.
  router.post('/articles/:id/unpublish', (req, res) => {
    const { reason } = validator(req.body).string('reason', { max: 500, required: false }).done();
    const article = getArticle(req.params.id);
    if (article.status !== 'published') throw conflict(`Only published articles can be unpublished (this one is "${article.status}")`, 'invalid_status');
    const now = nowIso();
    db.prepare(
      `UPDATE articles SET status = 'approved', published_at = NULL, is_featured = 0, held_at = ?, hold_reason = ?, updated_at = ? WHERE id = ?`,
    ).run(now, reason ?? '', now, article.id);
    res.json({ article: articleJson(article.id) });
  });

  router.post('/articles/:id/feature', (req, res) => {
    const { featured } = validator(req.body).boolean('featured').done();
    const article = getArticle(req.params.id);
    if (article.status !== 'published') throw conflict('Only published articles can be featured', 'invalid_status');
    db.prepare('UPDATE articles SET is_featured = ? WHERE id = ?').run(featured ? 1 : 0, article.id);
    res.json({ article: articleJson(article.id) });
  });

  router.post('/categories', (req, res) => {
    const { name } = validator(req.body).string('name', { min: 2, max: 60 }).done();
    const slug = slugify(name);
    if (db.prepare('SELECT 1 FROM categories WHERE slug = ? OR name = ? COLLATE NOCASE').get(slug, name)) {
      throw conflict('A topic with this name already exists', 'category_exists');
    }
    const result = db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').run(name, slug);
    res.status(201).json({ category: { id: Number(result.lastInsertRowid), name, slug } });
  });

  // For members who forgot their password (there is no email service): returns a one-time temporary password
  // to hand over in person. All their sessions are signed out; they should change it right away.
  router.post('/users/:id/reset-password', async (req, res) => {
    const user = /^\d+$/.test(req.params.id) ? db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id)) : undefined;
    if (!user) throw notFound('User');
    if (user.id === req.user.id) throw conflict('Use "change password" for your own account', 'self_reset');
    const temporaryPassword = randomBytes(9).toString('base64url');
    db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(await hashPassword(temporaryPassword), nowIso(), user.id);
    res.json({ user: toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)), temporaryPassword });
  });

  // Recomputes the signature of every stored review (or of one article's reviews with ?articleId=).
  // "invalid" lists reviews that were changed after they were written, or signed with a different key.
  router.get('/reviews/verify', (req, res) => {
    const articleId = queryString(req.query, 'articleId');
    if (articleId !== undefined && !/^\d+$/.test(articleId)) throw badRequest('Validation failed', { articleId: 'must be an article id' });
    const rows = articleId
      ? db.prepare('SELECT * FROM reviews WHERE article_id = ? ORDER BY id').all(Number(articleId))
      : db.prepare('SELECT * FROM reviews ORDER BY id').all();
    const invalid = rows
      .filter((r) => !reviewSignatureIsValid(config, r))
      .map((r) => ({ reviewId: r.id, articleId: r.article_id, assignmentId: r.assignment_id, decision: r.decision, createdAt: r.created_at }));
    res.json({ checked: rows.length, valid: rows.length - invalid.length, invalid });
  });

  router.get('/users', (req, res) => {
    const where = [];
    const params = [];
    const role = queryString(req.query, 'role');
    if (role) {
      if (!ROLES.includes(role)) throw badRequest('Validation failed', { role: `must be one of: ${ROLES.join(', ')}` });
      where.push('role = ?');
      params.push(role);
    }
    const search = queryString(req.query, 'search');
    if (search) {
      const like = `%${escapeLike(search.slice(0, 100))}%`;
      where.push(`(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')`);
      params.push(like, like);
    }
    const rows = db.prepare(`SELECT * FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name`).all(...params);
    res.json({ users: rows.map(toUser) });
  });

  // Promote a member to reviewer / admin (or demote). Admins cannot change their own role (no lock-outs).
  router.patch('/users/:id', (req, res) => {
    const data = validator(req.body)
      .oneOf('role', ROLES, { required: false })
      .string('title', { max: 120, required: false })
      .done();
    if (Object.keys(data).length === 0) throw badRequest('Send at least one of: role, title');
    const user = /^\d+$/.test(req.params.id) ? db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id)) : undefined;
    if (!user) throw notFound('User');
    if (data.role && data.role !== user.role && user.id === req.user.id) {
      throw conflict('You cannot change your own role', 'self_role_change');
    }
    const canReview = (role) => role === 'reviewer' || role === 'admin';
    transaction(db, () => {
      db.prepare('UPDATE users SET role = ?, title = ? WHERE id = ?').run(data.role ?? user.role, data.title ?? user.title, user.id);
      // Someone who can no longer review must not keep manuscripts: take them back so the admin queue shows them again.
      if (data.role && canReview(user.role) && !canReview(data.role)) {
        db.prepare(
          `UPDATE review_assignments SET status = 'returned', returned_at = ?, return_reason = ?, suggested_expertise = NULL, cancelled_by = ?
           WHERE reviewer_id = ? AND status = 'assigned'`,
        ).run(nowIso(), 'Reviewer role was removed by the editorial board', req.user.id, user.id);
      }
    });
    res.json({ user: toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
  });

  return router;
}
