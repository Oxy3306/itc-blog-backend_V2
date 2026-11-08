import { Router } from 'express';
import { createHmac } from 'node:crypto';
import { createCounter } from '../middleware.js';
import { ARTICLE_COLUMNS, ARTICLE_FROM, toArticle, toArticleWithBody } from '../serialize.js';
import { badRequest, escapeLike, normalizeNodeCode, nowIso, notFound, parsePaging, queryString, round1 } from '../util.js';

const SORTS = {
  latest: 'a.published_at DESC, a.id DESC',
  oldest: 'a.published_at ASC, a.id ASC',
  popular: 'reads DESC, a.published_at DESC',
  shortest: 'a.read_minutes ASC, a.published_at DESC',
};

const DOWNLOAD_FORMATS = ['pdf', 'md'];

function markdownFor(row) {
  return `${[
    `# ${row.title}`,
    row.subtitle ? `_${row.subtitle}_` : '',
    `By ${row.author_name}${row.author_title ? ` (${row.author_title})` : ''} - published ${row.published_at.slice(0, 10)}`,
    row.body,
  ]
    .filter(Boolean)
    .join('\n\n')}\n`;
}

export function publicRoutes({ db, config, auth, pdf }) {
  const router = Router();

  // Published articles never change, so a generated PDF can be reused. The service shares simultaneous requests,
  // limits how many PDFs are built at once, and caps the cache by total size (see pdf-service.js).
  const pdfFor = (row) => {
    const key = [row.id, row.updated_at, row.author_name, row.author_title, row.category_name, row.ref_code, row.cover_upload_id, row.cover_caption].join('|');
    return pdf.get(key, row, { uploadsDir: config.uploadsDir });
  };
  // New anonymous readers one address can add per hour (so scripts cannot inflate read counts).
  const anonViews = createCounter(db, { name: 'anon-views', windowMs: 60 * 60 * 1000, max: config.anonViewsPerIpPerHour });
  const getPublishedForDownload = (slug) => {
    const row = db
      .prepare(`SELECT ${ARTICLE_COLUMNS}, a.body FROM ${ARTICLE_FROM} WHERE a.slug = ? AND a.status = 'published'`)
      .get(slug);
    if (!row) throw notFound('Article');
    return row;
  };

  // Topics for the filter dropdown, with how many published articles each has.
  router.get('/categories', (req, res) => {
    const rows = db
      .prepare(
        `SELECT c.id, c.name, c.slug,
                (SELECT COUNT(*) FROM articles a WHERE a.category_id = c.id AND a.status = 'published') AS article_count
         FROM categories c ORDER BY c.name`,
      )
      .all();
    res.json({ categories: rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, articleCount: r.article_count })) });
  });

  // Target nodes in use (for a filter or the editor's dropdown), with how many published articles each has.
  router.get('/nodes', (req, res) => {
    const rows = db
      .prepare(`SELECT target_node AS code, COUNT(*) AS n FROM articles WHERE status = 'published' GROUP BY target_node ORDER BY target_node`)
      .all();
    const nodes = rows.map((r) => ({ code: r.code, articleCount: r.n }));
    if (!nodes.some((n) => n.code === config.defaultTargetNode)) nodes.unshift({ code: config.defaultTargetNode, articleCount: 0 });
    res.json({ defaultNode: config.defaultTargetNode, nodes });
  });

  // Homepage "Featured Articles" (the editorial board picks them).
  router.get('/articles/featured', (req, res) => {
    const { limit } = parsePaging(req.query, { defaultLimit: 2, maxLimit: 6 });
    const rows = db
      .prepare(
        `SELECT ${ARTICLE_COLUMNS} FROM ${ARTICLE_FROM}
         WHERE a.status = 'published' AND a.is_featured = 1
         ORDER BY a.published_at DESC, a.id DESC LIMIT ?`,
      )
      .all(limit);
    res.json({ items: rows.map(toArticle) });
  });

  // Explore page header: ACTIVE TRACKS / MEAN READ / ACCEPTANCE.
  router.get('/articles/stats', (req, res) => {
    const published = db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT category_id) AS tracks, AVG(read_minutes) AS mean_read
         FROM articles WHERE status = 'published'`,
      )
      .get();
    const submitted = db.prepare(`SELECT COUNT(*) AS n FROM articles WHERE revision >= 1 AND status != 'draft'`).get().n;
    const accepted = db.prepare(`SELECT COUNT(*) AS n FROM articles WHERE status IN ('approved', 'published')`).get().n;
    res.json({
      publishedArticles: published.total,
      activeTracks: published.tracks,
      meanReadMinutes: round1(published.mean_read ?? 0),
      // accepted (approved or published) / every article ever submitted for review
      acceptanceRate: submitted ? Math.round((accepted * 100) / submitted) : 0,
    });
  });

  // Explore + homepage "Latest": search, filter, sort, "Load more" pagination.
  router.get('/articles', (req, res) => {
    const { page, limit, offset } = parsePaging(req.query);
    const sort = queryString(req.query, 'sort') ?? 'latest';
    if (!Object.hasOwn(SORTS, sort)) throw badRequest('Validation failed', { sort: `must be one of: ${Object.keys(SORTS).join(', ')}` });

    const where = [`a.status = 'published'`];
    const params = [];

    const category = queryString(req.query, 'category');
    if (category) {
      where.push('c.slug = ?');
      params.push(category);
    }
    const node = queryString(req.query, 'node');
    if (node) {
      where.push('a.target_node = ?');
      params.push(normalizeNodeCode(node, 'node'));
    }
    const authorId = queryString(req.query, 'author');
    if (authorId) {
      if (!/^\d+$/.test(authorId)) throw badRequest('Validation failed', { author: 'must be a user id' });
      where.push('a.author_id = ?');
      params.push(Number(authorId));
    }
    const search = queryString(req.query, 'search');
    if (search) {
      const like = `%${escapeLike(search.slice(0, 100))}%`;
      where.push(
        `(a.title LIKE ? ESCAPE '\\' OR a.subtitle LIKE ? ESCAPE '\\' OR a.tags LIKE ? ESCAPE '\\'
          OR u.name LIKE ? ESCAPE '\\' OR a.body LIKE ? ESCAPE '\\')`,
      );
      params.push(like, like, like, like, like);
    }

    const whereSql = where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ${ARTICLE_FROM} WHERE ${whereSql}`).get(...params).n;
    const rows = db
      .prepare(
        `SELECT ${ARTICLE_COLUMNS} FROM ${ARTICLE_FROM}
         WHERE ${whereSql} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    res.json({ items: rows.map(toArticle), page, limit, total, hasMore: offset + rows.length < total });
  });

  // Article details page.
  router.get('/articles/:slug', auth.optionalAuth, (req, res) => {
    const row = db
      .prepare(
        `SELECT ${ARTICLE_COLUMNS}, a.body, u.bio AS author_bio FROM ${ARTICLE_FROM}
         WHERE a.slug = ? AND a.status = 'published'`,
      )
      .get(req.params.slug);
    if (!row) throw notFound('Article');

    // Count each reader once per article: signed-in readers by account, anonymous readers by network address
    // (the address is stored only as a keyed hash, never as plain text). The browser name is NOT used, because it is
    // trivial to change. Shared Wi-Fi therefore counts as one anonymous reader; signed-in readers count individually.
    // Authors reading their own article do not count.
    if (!req.user || req.user.id !== row.author_id) {
      let viewer = null;
      if (req.user) {
        viewer = `user:${req.user.id}`;
      } else if (!anonViews.blockedFor(req.ip)) {
        viewer = `anon:${createHmac('sha256', `${config.jwtSecret}:views`).update(String(req.ip)).digest('hex').slice(0, 32)}`;
      }
      if (viewer) {
        const added = db
          .prepare('INSERT OR IGNORE INTO article_views (article_id, viewer_hash, first_viewed_at) VALUES (?, ?, ?)')
          .run(row.id, viewer, nowIso()).changes;
        if (added && !req.user) anonViews.hit(req.ip);
      }
      row.reads = db.prepare('SELECT COUNT(*) AS n FROM article_views WHERE article_id = ?').get(row.id).n;
    }

    // "Related dispatches": same category first, then the newest of the rest.
    const related = db
      .prepare(
        `SELECT ${ARTICLE_COLUMNS} FROM ${ARTICLE_FROM}
         WHERE a.status = 'published' AND a.id != ?
         ORDER BY COALESCE(a.category_id = ?, 0) DESC, a.published_at DESC LIMIT 3`,
      )
      .all(row.id, row.category_id);

    res.json({
      article: toArticleWithBody(row),
      author: { id: row.author_id, name: row.author_name, title: row.author_title, bio: row.author_bio },
      related: related.map(toArticle),
    });
  });

  // "Download the article (1.8 MB)": links and file sizes for the download button.
  router.get('/articles/:slug/downloads', async (req, res) => {
    const row = getPublishedForDownload(req.params.slug);
    const base = `/api/articles/${row.slug}/download`;
    res.json({
      pdf: { url: `${base}?format=pdf`, bytes: (await pdfFor(row)).length },
      markdown: { url: `${base}?format=md`, bytes: Buffer.byteLength(markdownFor(row)) },
    });
  });

  // The article as a PDF (default) or a Markdown file: GET .../download?format=pdf|md
  router.get('/articles/:slug/download', async (req, res) => {
    const format = queryString(req.query, 'format') ?? 'pdf';
    if (!DOWNLOAD_FORMATS.includes(format)) throw badRequest('Validation failed', { format: `must be one of: ${DOWNLOAD_FORMATS.join(', ')}` });
    const row = getPublishedForDownload(req.params.slug);
    if (format === 'md') {
      res.attachment(`${row.slug}.md`).type('text/markdown; charset=utf-8').send(markdownFor(row));
    } else {
      res.attachment(`${row.slug}.pdf`).type('application/pdf').send(await pdfFor(row));
    }
  });

  // Members directory: everyone who has published at least one article.
  const AUTHOR_SORTS = {
    articles: 'article_count DESC, u.name ASC',
    name: 'u.name ASC',
    recent: 'latest_published_at DESC, u.name ASC',
  };
  router.get('/authors', (req, res) => {
    const { page, limit, offset } = parsePaging(req.query, { defaultLimit: 20, maxLimit: 100 });
    const sort = queryString(req.query, 'sort') ?? 'articles';
    if (!Object.hasOwn(AUTHOR_SORTS, sort)) throw badRequest('Validation failed', { sort: `must be one of: ${Object.keys(AUTHOR_SORTS).join(', ')}` });
    const where = [];
    const params = [];
    const search = queryString(req.query, 'search');
    if (search) {
      const like = `%${escapeLike(search.slice(0, 100))}%`;
      where.push(`(u.name LIKE ? ESCAPE '\\' OR u.title LIKE ? ESCAPE '\\')`);
      params.push(like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `users u JOIN articles a ON a.author_id = u.id AND a.status = 'published' ${whereSql}`;
    const total = db.prepare(`SELECT COUNT(DISTINCT u.id) AS n FROM ${from}`).get(...params).n;
    const rows = db
      .prepare(
        `SELECT u.id, u.name, u.title, u.bio, COUNT(a.id) AS article_count, MAX(a.published_at) AS latest_published_at
         FROM ${from} GROUP BY u.id ORDER BY ${AUTHOR_SORTS[sort]} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    res.json({
      items: rows.map((r) => ({ id: r.id, name: r.name, title: r.title, bio: r.bio, articleCount: r.article_count, latestPublishedAt: r.latest_published_at })),
      page, limit, total, hasMore: offset + rows.length < total,
    });
  });

  // "View Author Profile".
  router.get('/authors/:id', (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw notFound('Author');
    const author = db.prepare('SELECT id, name, title, bio, created_at FROM users WHERE id = ?').get(Number(req.params.id));
    if (!author) throw notFound('Author');
    const rows = db
      .prepare(
        `SELECT ${ARTICLE_COLUMNS} FROM ${ARTICLE_FROM}
         WHERE a.status = 'published' AND a.author_id = ? ORDER BY a.published_at DESC, a.id DESC`,
      )
      .all(author.id);
    // Same rule as the members directory: only people with published work have a public profile.
    // (Reviewers and other members must not be discoverable by guessing ids.)
    if (rows.length === 0) throw notFound('Author');
    res.json({
      author: { id: author.id, name: author.name, title: author.title, bio: author.bio, joinedAt: author.created_at, articleCount: rows.length },
      articles: rows.map(toArticle),
    });
  });

  return router;
}
