import { Router } from 'express';
import { newPublicCode } from '../db.js';
import { burnPasswordCheck, hashPassword, signToken, verifyPassword } from '../auth.js';
import { createCounter } from '../middleware.js';
import { toUser } from '../serialize.js';
import { HttpError, badRequest, conflict, nowIso, unauthorized, validator } from '../util.js';

export function authRoutes({ db, config, auth, rateLimit }) {
  const router = Router();
  const limits = config.loginLimits;
  const byAccountAndIp = createCounter(db, { name: 'login-pair', windowMs: limits.windowMs, max: limits.perAccountAndIp });
  const byAccount = createCounter(db, { name: 'login-account', windowMs: limits.windowMs, max: limits.perAccount });
  const byIp = createCounter(db, { name: 'login-ip', windowMs: limits.windowMs, max: limits.perIp });

  const tooMany = (seconds, res) => {
    res.set('Retry-After', String(seconds));
    return new HttpError(429, 'rate_limited', `Too many failed attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`);
  };

  // Anyone can create an account; every new account starts as a plain "author" (club member).
  router.post('/register', rateLimit, async (req, res) => {
    const data = validator(req.body)
      .string('name', { min: 2, max: 80 })
      .email('email')
      .string('password', { min: 8, max: 128, trim: false })
      .string('title', { max: 120, required: false })
      .done();

    const passwordHash = await hashPassword(data.password);
    // No "await" between the check and the insert, so two simultaneous sign-ups cannot both win.
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(data.email)) {
      throw conflict('An account with this email already exists', 'email_taken');
    }
    const result = db
      .prepare('INSERT INTO users (name, email, password_hash, title, public_code, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(data.name, data.email, passwordHash, data.title ?? '', newPublicCode(db), nowIso());
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ token: signToken(user, config), user: toUser(user) });
  });

  router.post('/login', async (req, res) => {
    const { email, password } = validator(req.body)
      .email('email')
      .string('password', { min: 1, max: 128, trim: false })
      .done();

    const keys = { both: `${req.ip}|${email}`, account: email, ip: req.ip };
    const wait = Math.max(byAccountAndIp.blockedFor(keys.both), byAccount.blockedFor(keys.account), byIp.blockedFor(keys.ip));
    if (wait) throw tooMany(wait, res);

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const valid = user ? await verifyPassword(password, user.password_hash) : (await burnPasswordCheck(password), false);
    if (!valid) {
      byAccountAndIp.hit(keys.both);
      byAccount.hit(keys.account);
      byIp.hit(keys.ip);
      throw unauthorized('Invalid email or password');
    }
    byAccountAndIp.reset(keys.both); // typos before a successful login do not count against you
    res.json({ token: signToken(user, config), user: toUser(user) });
  });

  router.get('/me', auth.requireAuth, (req, res) => {
    res.json({ user: toUser(req.user) });
  });

  router.patch('/me', auth.requireAuth, (req, res) => {
    const data = validator(req.body)
      .string('name', { min: 2, max: 80, required: false })
      .string('title', { max: 120, required: false })
      .string('bio', { max: 1000, required: false })
      .done();
    if (Object.keys(data).length === 0) throw badRequest('Send at least one of: name, title, bio');
    const next = { name: req.user.name, title: req.user.title, bio: req.user.bio, ...data };
    db.prepare('UPDATE users SET name = ?, title = ?, bio = ? WHERE id = ?').run(next.name, next.title, next.bio, req.user.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: toUser(user) });
  });

  // Changing the password signs out every other device. The response contains a fresh token for this one.
  router.post('/change-password', auth.requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = validator(req.body)
      .string('currentPassword', { min: 1, max: 128, trim: false })
      .string('newPassword', { min: 8, max: 128, trim: false })
      .done();

    const key = `password:${req.user.id}`;
    const wait = byAccount.blockedFor(key);
    if (wait) throw tooMany(wait, res);

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      byAccount.hit(key);
      throw badRequest('Validation failed', { currentPassword: 'is incorrect' });
    }
    if (newPassword === currentPassword) throw badRequest('Validation failed', { newPassword: 'must be different from the current password' });

    db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(
      await hashPassword(newPassword), nowIso(), req.user.id,
    );
    byAccount.reset(key);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ token: signToken(user, config), user: toUser(user) });
  });

  return router;
}
