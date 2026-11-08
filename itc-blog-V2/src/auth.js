import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { forbidden, unauthorized } from './util.js';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

// Passwords are hashed with scrypt (built into Node). Stored as "scrypt$<salt>$<hash>".
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

// Used when the email does not exist, so a wrong email takes as long as a wrong password.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}

export function signToken(user, config) {
  return jwt.sign({ role: user.role }, config.jwtSecret, {
    subject: String(user.id),
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
  });
}

// Tamper-evidence for review decisions: an HMAC over the decision's fields.
export function signReview(config, { assignmentId, articleId, revision, reviewerId, decision, feedback, createdAt }) {
  const payload = [assignmentId, articleId, revision, reviewerId, decision, feedback, createdAt].join('|');
  return createHmac('sha256', config.reviewSigningKey).update(payload).digest('hex');
}

// Recomputes the signature of a stored review row. False means the row was changed after it was written
// (or was signed with a different key).
export function reviewSignatureIsValid(config, row) {
  const expected = Buffer.from(
    signReview(config, {
      assignmentId: row.assignment_id, articleId: row.article_id, revision: row.revision,
      reviewerId: row.reviewer_id, decision: row.decision, feedback: row.feedback, createdAt: row.created_at,
    }),
    'hex',
  );
  const actual = Buffer.from(String(row.signature), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createAuth({ db, config }) {
  const findUser = db.prepare('SELECT id, name, email, role, title, bio, created_at, password_changed_at, public_code FROM users WHERE id = ?');

  function loadUser(req) {
    const header = req.get('authorization');
    if (!header) return null;
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw unauthorized('Use the header "Authorization: Bearer <token>"');
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    const user = findUser.get(Number(payload.sub));
    if (!user) throw unauthorized('Account no longer exists');
    // Sessions created before the last password change are no longer valid.
    if (user.password_changed_at && payload.iat < Math.floor(Date.parse(user.password_changed_at) / 1000)) {
      throw unauthorized('Your password was changed. Please sign in again.');
    }
    return user;
  }

  return {
    // Public pages: a valid token identifies the reader; a missing, expired or bad token just means "anonymous"
    // (a stale token in the browser must never stop someone from reading an article).
    optionalAuth(req, res, next) {
      try {
        req.user = loadUser(req);
      } catch {
        req.user = null;
      }
      next();
    },
    requireAuth(req, res, next) {
      const user = loadUser(req);
      if (!user) throw unauthorized();
      req.user = user;
      next();
    },
  };
}

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) throw unauthorized();
  if (!roles.includes(req.user.role)) throw forbidden(`This action requires the role: ${roles.join(' or ')}`);
  next();
};
