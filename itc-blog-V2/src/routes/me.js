import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { Router } from 'express';
import { transaction } from '../db.js';
import { ALLOWED_IMAGE_TYPES, detectImageType, uploadUrl } from '../uploads.js';
import { ARTICLE_COLUMNS, ARTICLE_FROM, toArticle, toArticleWithBody, toReviewForAuthor } from '../serialize.js';
import { EDITABLE_STATUSES, KINDS, RESERVED_SLUGS, STATUSES } from '../constants.js';
import {
  HttpError, average, badRequest, conflict, escapeLike, hoursBetween, normalizeNodeCode, notFound, nowIso, parsePaging, queryString, refCodeFor,
  round1, slugify, startOfQuarterIso, textStats, validator,
} from '../util.js';

// Everything an author does with their own articles: write, save, submit, publish, delete.
export function meRoutes({ db, config, auth }) {
  const router = Router();
  router.use(auth.requireAuth);

  const getOwn = (id, userId) => {
    const row = /^\d+$/.test(String(id))
      ? db
          .prepare(`SELECT ${ARTICLE_COLUMNS}, a.body FROM ${ARTICLE_FROM} WHERE a.id = ? AND a.author_id = ?`)
          .get(Number(id), userId)
      : undefined;
    if (!row) throw notFound('Article'); // also used for other people's articles: don't reveal they exist
    return row;
  };

  const ownDetail = (id, userId) => {
    const row = getOwn(id, userId);
    const reviews = db
      .prepare('SELECT r.*, u.public_code AS reviewer_code FROM reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.article_id = ? ORDER BY r.id')
      .all(row.id);
    return { article: toArticleWithBody(row), reviews: reviews.map(toReviewForAuthor) };
  };

  const assertCategory = (categoryId) => {
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) {
      throw badRequest('Validation failed', { categoryId: 'does not exist' });
    }
  };

  const uniqueSlug = (title) => {
    let base = slugify(title);
    if (RESERVED_SLUGS.has(base)) base = `${base}-article`;
    let slug = base;
    for (let n = 2; db.prepare('SELECT 1 FROM articles WHERE slug = ?').get(slug); n++) slug = `${base}-${n}`;
    return slug;
  };

  // Saves always produce a strictly newer "updatedAt", so two quick saves can never look identical to the conflict check.
  const nextStamp = (previous) => {
    const now = nowIso();
    return now > previous ? now : new Date(Date.parse(previous) + 1).toISOString();
  };

  // Reference codes must be unique (admins can also set their own, so the automatic one may be taken).
  const uniqueRefCode = (base) => {
    let code = base;
    for (let n = 2; db.prepare('SELECT 1 FROM articles WHERE ref_code = ?').get(code); n++) code = `${base}-${n}`;
    return code;
  };

  const assertOwnUpload = (uploadId, userId) => {
    if (!db.prepare('SELECT 1 FROM uploads WHERE id = ? AND owner_id = ?').get(uploadId, userId)) {
      throw badRequest('Validation failed', { coverImageId: 'must be the id of an image you uploaded' });
    }
  };

  // My Articles: list + status counts + the three stats cards.
  router.get('/articles', (req, res) => {
    const { page, limit, offset } = parsePaging(req.query, { defaultLimit: 20, maxLimit: 100 });
    const where = ['a.author_id = ?'];
    const params = [req.user.id];

    const status = queryString(req.query, 'status');
    if (status) {
      if (!STATUSES.includes(status)) throw badRequest('Validation failed', { status: `must be one of: ${STATUSES.join(', ')}` });
      where.push('a.status = ?');
      params.push(status);
    }
    const search = queryString(req.query, 'search');
    if (search) {
      const like = `%${escapeLike(search.slice(0, 100))}%`;
      where.push(`(a.title LIKE ? ESCAPE '\\' OR a.subtitle LIKE ? ESCAPE '\\' OR a.tags LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like);
    }
    const whereSql = where.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) AS n FROM ${ARTICLE_FROM} WHERE ${whereSql}`).get(...params).n;
    const rows = db
      .prepare(
        `SELECT ${ARTICLE_COLUMNS},
                (SELECT COUNT(*) FROM reviews rv WHERE rv.article_id = a.id AND rv.feedback != '') AS reviewer_notes
         FROM ${ARTICLE_FROM} WHERE ${whereSql} ORDER BY a.updated_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM articles WHERE author_id = ? GROUP BY status').all(req.user.id)) {
      counts[r.status] = r.n;
    }

    // Stats cards. Each is null when there is nothing to measure yet.
    const firstDecisions = db
      .prepare(
        `SELECT rv.decision FROM reviews rv WHERE rv.id IN (
           SELECT MIN(r2.id) FROM reviews r2 JOIN articles a2 ON a2.id = r2.article_id
           WHERE a2.author_id = ? GROUP BY r2.article_id)`,
      )
      .all(req.user.id);
    const firstPass = firstDecisions.filter((d) => d.decision === 'approved').length;
    const latencies = db
      .prepare(
        `SELECT ra.submitted_at, rv.created_at FROM reviews rv
         JOIN review_assignments ra ON ra.id = rv.assignment_id
         JOIN articles a ON a.id = rv.article_id WHERE a.author_id = ?`,
      )
      .all(req.user.id)
      .map((r) => hoursBetween(r.submitted_at, r.created_at));
    const reads = db
      .prepare(
        `SELECT COUNT(*) AS n FROM article_views v JOIN articles a ON a.id = v.article_id
         WHERE a.author_id = ? AND a.status = 'published' AND v.first_viewed_at >= ?`,
      )
      .get(req.user.id, startOfQuarterIso()).n;

    res.json({
      items: rows.map((r) => ({ ...toArticle(r), reviewerNotes: r.reviewer_notes })),
      page,
      limit,
      total,
      hasMore: offset + rows.length < total,
      counts,
      stats: {
        // share of reviewed manuscripts whose FIRST review was an approval
        publishRate: firstDecisions.length ? round1((firstPass * 100) / firstDecisions.length) : null,
        firstPassApproved: firstPass,
        reviewedManuscripts: firstDecisions.length,
        // average hours between submitting and receiving a decision
        avgReviewHours: latencies.length ? round1(average(latencies)) : null,
        // unique readers whose first visit to one of my published articles happened this quarter
        communityReads: reads,
        reviewTargetHours: config.reviewTargetHours,
      },
    });
  });

  // Editor: create a draft. Only the title is needed to start.
  router.post('/articles', (req, res) => {
    const data = validator(req.body)
      .string('title', { min: 3, max: 200 })
      .string('subtitle', { max: 400, required: false })
      .string('body', { max: 200_000, required: false, trim: false })
      .int('categoryId', { required: false })
      .stringArray('tags', { maxItems: 8, maxLength: 30 })
      .oneOf('kind', KINDS, { required: false })
      .int('coverImageId', { required: false })
      .string('coverCaption', { max: 200, required: false })
      .string('targetNode', { min: 3, max: 40, required: false })
      .done();
    if (data.categoryId !== undefined) assertCategory(data.categoryId);
    if (data.coverImageId !== undefined) assertOwnUpload(data.coverImageId, req.user.id);
    const targetNode = data.targetNode !== undefined ? normalizeNodeCode(data.targetNode) : config.defaultTargetNode;

    const body = data.body ?? '';
    const stats = textStats(body);
    const now = nowIso();
    const id = transaction(db, () => {
      const result = db
        .prepare(
          `INSERT INTO articles (slug, author_id, category_id, kind, title, subtitle, body, tags,
                                 word_count, code_blocks, read_minutes, cover_upload_id, cover_caption, target_node, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          uniqueSlug(data.title), req.user.id, data.categoryId ?? null, data.kind ?? 'article', data.title,
          data.subtitle ?? '', body, JSON.stringify(data.tags ?? []),
          stats.wordCount, stats.codeBlocks, stats.readMinutes, data.coverImageId ?? null, data.coverCaption ?? '', targetNode, now, now,
        );
      const newId = Number(result.lastInsertRowid);
      db.prepare('UPDATE articles SET ref_code = ? WHERE id = ?').run(uniqueRefCode(refCodeFor(data.title, newId)), newId);
      return newId;
    });
    res.status(201).json(ownDetail(id, req.user.id));
  });

  router.get('/articles/:id', (req, res) => {
    res.json(ownDetail(req.params.id, req.user.id));
  });

  // Editor: "Save Draft". Only while the article is a draft or has changes requested.
  router.patch('/articles/:id', (req, res) => {
    const current = getOwn(req.params.id, req.user.id);
    if (!EDITABLE_STATUSES.includes(current.status)) {
      throw conflict(`This article cannot be edited while it is "${current.status}"`, 'article_locked');
    }
    const clearCover = req.body?.coverImageId === null; // send "coverImageId": null to remove the cover image
    const { baseUpdatedAt, ...data } = validator(req.body)
      .string('title', { min: 3, max: 200, required: false })
      .string('subtitle', { max: 400, required: false })
      .string('body', { max: 200_000, required: false, trim: false })
      .int('categoryId', { required: false })
      .stringArray('tags', { maxItems: 8, maxLength: 30 })
      .oneOf('kind', KINDS, { required: false })
      .int('coverImageId', { required: false })
      .string('coverCaption', { max: 200, required: false })
      .string('targetNode', { min: 3, max: 40, required: false })
      .string('baseUpdatedAt', { max: 40, required: false })
      .done();
    // Autosave safety: send the "updatedAt" you last received; if the article changed elsewhere in the meantime, refuse.
    if (baseUpdatedAt !== undefined && baseUpdatedAt !== current.updated_at) {
      throw conflict('This article was changed somewhere else (another tab or device). Reload it before saving.', 'edit_conflict');
    }
    if (Object.keys(data).length === 0 && !clearCover) throw badRequest('Send at least one field to update');
    if (data.categoryId !== undefined) assertCategory(data.categoryId);
    if (data.coverImageId !== undefined) assertOwnUpload(data.coverImageId, req.user.id);

    const next = {
      title: data.title ?? current.title,
      subtitle: data.subtitle ?? current.subtitle,
      body: data.body ?? current.body,
      categoryId: data.categoryId ?? current.category_id,
      tags: JSON.stringify(data.tags ?? JSON.parse(current.tags)),
      kind: data.kind ?? current.kind,
      coverUploadId: clearCover ? null : (data.coverImageId ?? current.cover_upload_id),
      coverCaption: data.coverCaption ?? current.cover_caption,
      targetNode: data.targetNode !== undefined ? normalizeNodeCode(data.targetNode) : current.target_node,
    };
    const stats = textStats(next.body);
    db.prepare(
      `UPDATE articles SET title = ?, subtitle = ?, body = ?, category_id = ?, tags = ?, kind = ?,
              cover_upload_id = ?, cover_caption = ?, target_node = ?,
              word_count = ?, code_blocks = ?, read_minutes = ?, updated_at = ? WHERE id = ?`,
    ).run(
      next.title, next.subtitle, next.body, next.categoryId, next.tags, next.kind,
      next.coverUploadId, next.coverCaption, next.targetNode,
      stats.wordCount, stats.codeBlocks, stats.readMinutes, nextStamp(current.updated_at), current.id,
    );
    res.json(ownDetail(current.id, req.user.id));
  });

  // Only drafts can be deleted (anything that entered review stays on record).
  router.delete('/articles/:id', (req, res) => {
    const current = getOwn(req.params.id, req.user.id);
    if (current.status !== 'draft') throw conflict('Only drafts can be deleted', 'article_locked');
    db.prepare('DELETE FROM articles WHERE id = ?').run(current.id);
    res.status(204).end();
  });

  // Editor: "Submit for review". From changes_requested it goes back to pending_review (same ref code, new revision).
  router.post('/articles/:id/submit', (req, res) => {
    const current = getOwn(req.params.id, req.user.id);
    if (!EDITABLE_STATUSES.includes(current.status)) {
      throw conflict(`An article that is "${current.status}" cannot be submitted`, 'invalid_status');
    }
    const problems = {};
    if (!current.subtitle) problems.subtitle = 'is required before submitting';
    if (!current.category_id) problems.categoryId = 'is required before submitting';
    if (current.word_count < config.minWordsToSubmit) problems.body = `needs at least ${config.minWordsToSubmit} words before submitting`;
    if (Object.keys(problems).length) throw badRequest('This article is not ready to submit', problems);

    const now = nowIso();
    db.prepare(
      `UPDATE articles SET status = 'pending_review', revision = revision + 1, submitted_at = ?, updated_at = ? WHERE id = ?`,
    ).run(now, now, current.id);
    res.json(ownDetail(current.id, req.user.id));
  });

  // Submitted by mistake? Take it back. An active reviewer assignment is cancelled; the article becomes editable again
  // (a draft, or "changes requested" if reviewers already gave feedback on an earlier round).
  router.post('/articles/:id/withdraw', (req, res) => {
    const current = getOwn(req.params.id, req.user.id);
    if (current.status !== 'pending_review') {
      throw conflict(`Only articles waiting for review can be withdrawn (this one is "${current.status}")`, 'invalid_status');
    }
    const now = nowIso();
    transaction(db, () => {
      db.prepare(
        `UPDATE review_assignments SET status = 'returned', returned_at = ?, return_reason = 'Withdrawn by the author', cancelled_by = ?
         WHERE article_id = ? AND status = 'assigned'`,
      ).run(now, req.user.id, current.id);
      const hadFeedback = db.prepare('SELECT 1 FROM reviews WHERE article_id = ?').get(current.id);
      db.prepare('UPDATE articles SET status = ?, submitted_at = NULL, updated_at = ? WHERE id = ?').run(
        hadFeedback ? 'changes_requested' : 'draft', nextStamp(current.updated_at), current.id,
      );
    });
    res.json(ownDetail(current.id, req.user.id));
  });

  // Approved articles stay hidden until the author (or the editorial board) publishes them.
  router.post('/articles/:id/publish', (req, res) => {
    const current = getOwn(req.params.id, req.user.id);
    if (current.status !== 'approved') {
      throw conflict(`Only approved articles can be published (this one is "${current.status}")`, 'invalid_status');
    }
    if (current.held_at) {
      throw conflict('An administrator took this article offline. Only an administrator can publish it again.', 'taken_down');
    }
    const now = nowIso();
    db.prepare(`UPDATE articles SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?`).run(now, now, current.id);
    res.json(ownDetail(current.id, req.user.id));
  });

  // ---- Images (editor figures, cover image) ----
  const uploadJson = (u) => ({
    id: u.id, url: uploadUrl(u.filename), mime: u.mime, bytes: u.bytes, createdAt: u.created_at,
    ...(u.used_as_cover !== undefined ? { usedAsCover: u.used_as_cover === 1 } : {}),
  });

  // Send the raw image bytes as the request body with Content-Type image/jpeg, image/png or image/webp (max 5 MB).
  router.post('/uploads', express.raw({ type: ALLOWED_IMAGE_TYPES, limit: config.maxUploadBytes }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new HttpError(415, 'unsupported_media_type', 'Send the raw image bytes with Content-Type image/jpeg, image/png or image/webp');
    }
    const declared = req.get('content-type').split(';')[0].trim().toLowerCase();
    const detected = detectImageType(req.body);
    if (!detected || detected.mime !== declared) {
      throw badRequest('The file content does not match its declared image type');
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE owner_id = ?').get(req.user.id).n;
    if (count >= config.maxUploadsPerUser) {
      throw conflict(`Upload limit reached (${config.maxUploadsPerUser} images). Delete some you no longer use.`, 'upload_limit');
    }

    // Disk protection: a cap on the total size per account, and one for the whole site.
    const usedByUser = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM uploads WHERE owner_id = ?').get(req.user.id).n;
    if (usedByUser + req.body.length > config.maxUploadBytesPerUser) {
      throw conflict(`Storage limit reached (${Math.round(config.maxUploadBytesPerUser / 1048576)} MB per account). Delete images you no longer use.`, 'storage_limit');
    }
    const usedInTotal = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM uploads').get().n;
    if (usedInTotal + req.body.length > config.maxUploadBytesTotal) {
      throw new HttpError(507, 'storage_full', 'The site has no room for new images right now. Please tell an administrator.');
    }

    const filename = `${randomBytes(12).toString('hex')}.${detected.ext}`; // random name: nobody can guess other people's files
    mkdirSync(config.uploadsDir, { recursive: true });
    writeFileSync(join(config.uploadsDir, filename), req.body, { flag: 'wx' });
    try {
      const result = db
        .prepare('INSERT INTO uploads (owner_id, filename, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(req.user.id, filename, detected.mime, req.body.length, nowIso());
      res.status(201).json({ upload: uploadJson(db.prepare('SELECT * FROM uploads WHERE id = ?').get(result.lastInsertRowid)) });
    } catch (err) {
      rmSync(join(config.uploadsDir, filename), { force: true });
      throw err;
    }
  });

  router.get('/uploads', (req, res) => {
    const rows = db
      .prepare(
        `SELECT u.*, EXISTS (SELECT 1 FROM articles a WHERE a.cover_upload_id = u.id) AS used_as_cover
         FROM uploads u WHERE u.owner_id = ? ORDER BY u.id DESC`,
      )
      .all(req.user.id);
    res.json({ items: rows.map(uploadJson), limit: config.maxUploadsPerUser });
  });

  // Images used by an article that is in review or published cannot be deleted (it would break the article).
  router.delete('/uploads/:id', (req, res) => {
    const upload = /^\d+$/.test(req.params.id)
      ? db.prepare('SELECT * FROM uploads WHERE id = ? AND owner_id = ?').get(Number(req.params.id), req.user.id)
      : undefined;
    if (!upload) throw notFound('Upload');
    const inUse = db
      .prepare(
        `SELECT 1 FROM articles WHERE status NOT IN ('draft', 'changes_requested')
           AND (cover_upload_id = ? OR instr(body, ?) > 0) LIMIT 1`,
      )
      .get(upload.id, upload.filename);
    if (inUse) throw conflict('This image is used by an article that is in review or published', 'upload_in_use');
    db.prepare('DELETE FROM uploads WHERE id = ?').run(upload.id);
    rmSync(join(config.uploadsDir, upload.filename), { force: true });
    res.status(204).end();
  });

  return router;
}
