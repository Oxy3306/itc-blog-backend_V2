import { HttpError } from './util.js';

// Counters kept in the DATABASE (table rate_counters), not in memory: they survive a server restart and are shared by
// every server process that uses the same database. Each key counts hits inside a time window.
export function createCounter(db, { name, windowMs, max }) {
  const upsert = db.prepare(
    `INSERT INTO rate_counters (key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END`,
  );
  const read = db.prepare('SELECT count, reset_at FROM rate_counters WHERE key = ?');
  const remove = db.prepare('DELETE FROM rate_counters WHERE key = ?');
  const prune = db.prepare('DELETE FROM rate_counters WHERE reset_at <= ?');
  const id = (key) => `${name}:${key}`;
  return {
    // seconds to wait, or 0 when this key is not over the limit
    blockedFor(key) {
      const row = read.get(id(key));
      const now = Date.now();
      return row && row.reset_at > now && row.count >= max ? Math.ceil((row.reset_at - now) / 1000) : 0;
    },
    // records one hit (a failed login, a new account...) and returns the count inside the current window
    hit(key) {
      const now = Date.now();
      upsert.run(id(key), now + windowMs, now, now, now + windowMs);
      if (Math.random() < 0.02) prune.run(now); // housekeeping: forget expired windows
      return read.get(id(key)).count;
    },
    reset(key) {
      remove.run(id(key));
    },
  };
}

// Express middleware: at most `max` hits per address per window (used for account creation).
export function createRateLimiter(db, { name, windowMs, max }) {
  const counter = createCounter(db, { name, windowMs, max });
  return (req, res, next) => {
    const wait = counter.blockedFor(req.ip);
    if (wait) {
      res.set('Retry-After', String(wait));
      throw new HttpError(429, 'rate_limited', 'Too many attempts. Please try again later.');
    }
    counter.hit(req.ip);
    next();
  };
}

export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms.toFixed(1)} ms)`);
  });
  next();
}

export function notFoundHandler(req, res, next) {
  next(new HttpError(404, 'not_found', `No route for ${req.method} ${req.path}`));
}

// Every error leaves the API in the same shape: { error: { code, message, details? } }
export function errorHandler({ quiet = false } = {}) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is too large' } });
    }
    if (!quiet) console.error(err);
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong on the server' } });
  };
}
