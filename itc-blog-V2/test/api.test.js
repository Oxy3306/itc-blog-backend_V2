import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { signReview } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';

const PASSWORD = 'Password123!';
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const bodyWithCode = `Intro text ${words(30)}\n\n\`\`\`js\nconsole.log(1)\n\`\`\`\n`;

function startApp(configOverrides = {}) {
  const db = openDb(':memory:');
  const uploadsDir = mkdtempSync(join(tmpdir(), 'itc-uploads-'));
  const config = loadConfig({
    nodeEnv: 'test',
    uploadsDir,
    jwtSecret: 'test-secret',
    logRequests: false,
    loginLimits: { windowMs: 60_000, perAccountAndIp: 8, perAccount: 40, perIp: 150 },
    registerLimit: { windowMs: 60_000, max: 10_000 },
    ...configOverrides,
  });
  const app = createApp({ db, config });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const api = async (method, path, { token, body, raw, headers = {} } = {}) => {
        const res = await fetch(base + path, {
          method,
          headers: {
            ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...headers,
          },
          body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
        });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, body: json, text, headers: res.headers };
      };
      resolve({
        db, config, api, base, uploadsDir,
        close: () => new Promise((r) => server.close(() => { rmSync(uploadsDir, { recursive: true, force: true }); r(); })),
      });
    });
  });
}

describe('ITC Blog API', () => {
  let ctx, api, db;
  const tokens = {};
  const ids = {};

  const register = async (key, name) => {
    const r = await api('POST', '/api/auth/register', { body: { name, email: `${key}@itc.test`, password: PASSWORD } });
    assert.equal(r.status, 201, r.text);
    tokens[key] = r.body.token;
    ids[key] = r.body.user.id;
  };

  // Full happy path through the API: draft -> submit -> assign -> approve -> publish.
  const publishViaApi = async (authorKey, fields, reviewerKey = 'rev1') => {
    const created = await api('POST', '/api/me/articles', { token: tokens[authorKey], body: { body: bodyWithCode, subtitle: 'A subtitle', ...fields } });
    assert.equal(created.status, 201, created.text);
    const id = created.body.article.id;
    assert.equal((await api('POST', `/api/me/articles/${id}/submit`, { token: tokens[authorKey] })).status, 200);
    const assigned = await api('POST', `/api/admin/articles/${id}/assign`, { token: tokens.admin, body: { reviewerId: ids[reviewerKey] } });
    assert.equal(assigned.status, 201, assigned.text);
    const decided = await api('POST', `/api/reviews/assignments/${assigned.body.assignment.id}/decision`, { token: tokens[reviewerKey], body: { decision: 'approve' } });
    assert.equal(decided.status, 201, decided.text);
    const published = await api('POST', `/api/me/articles/${id}/publish`, { token: tokens[authorKey] });
    assert.equal(published.status, 200, published.text);
    return published.body.article;
  };

  before(async () => {
    ctx = await startApp();
    ({ api, db } = ctx);
    for (const [key, name] of [['admin', 'Admin One'], ['rev1', 'Reviewer One'], ['rev2', 'Reviewer Two'], ['alice', 'Alice Author'], ['bob', 'Bob Writer']]) {
      await register(key, name);
    }
    db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(ids.admin); // the first admin is made outside the API
  });
  after(() => ctx.close());

  describe('basics', () => {
    it('health check works', async () => {
      const r = await api('GET', '/api/health');
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'ok');
    });
    it('unknown routes return JSON 404', async () => {
      const r = await api('GET', '/api/nope');
      assert.equal(r.status, 404);
      assert.equal(r.body.error.code, 'not_found');
    });
    it('malformed JSON returns 400, not a crash', async () => {
      const r = await api('POST', '/api/auth/login', { raw: '{bad json' });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'invalid_json');
    });
    it('sets CORS for the configured frontend origin', async () => {
      const r = await api('GET', '/api/health', { headers: { origin: 'http://localhost:5173' } });
      assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    });
  });

  describe('auth', () => {
    it('rejects bad registration input with per-field details', async () => {
      const r = await api('POST', '/api/auth/register', { body: { name: 'A', email: 'nope', password: 'short' } });
      assert.equal(r.status, 400);
      assert.deepEqual(Object.keys(r.body.error.details).sort(), ['email', 'name', 'password']);
    });
    it('registers as a plain author and never returns the password hash', async () => {
      const r = await api('POST', '/api/auth/register', { body: { name: 'Carol C', email: 'Carol@ITC.test', password: PASSWORD } });
      assert.equal(r.status, 201);
      assert.equal(r.body.user.role, 'author');
      assert.equal(r.body.user.email, 'carol@itc.test');
      assert.ok(!('password_hash' in r.body.user) && !JSON.stringify(r.body).includes('scrypt'));
    });
    it('does not let people register themselves as admin', async () => {
      const r = await api('POST', '/api/auth/register', { body: { name: 'Evil', email: 'evil@itc.test', password: PASSWORD, role: 'admin' } });
      assert.equal(r.body.user.role, 'author');
    });
    it('rejects a duplicate email (case-insensitive)', async () => {
      const r = await api('POST', '/api/auth/register', { body: { name: 'Carol Again', email: 'CAROL@itc.test', password: PASSWORD } });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'email_taken');
    });
    it('logs in with the right password only', async () => {
      const ok = await api('POST', '/api/auth/login', { body: { email: 'alice@itc.test', password: PASSWORD } });
      assert.equal(ok.status, 200);
      assert.ok(ok.body.token);
      const bad = await api('POST', '/api/auth/login', { body: { email: 'alice@itc.test', password: 'wrong-password' } });
      assert.equal(bad.status, 401);
      const unknown = await api('POST', '/api/auth/login', { body: { email: 'ghost@itc.test', password: PASSWORD } });
      assert.equal(unknown.status, 401);
      assert.equal(unknown.body.error.message, bad.body.error.message); // same message: no account enumeration
    });
    it('protects /me and rejects bad tokens', async () => {
      assert.equal((await api('GET', '/api/auth/me')).status, 401);
      assert.equal((await api('GET', '/api/auth/me', { token: 'garbage' })).status, 401);
      const r = await api('GET', '/api/auth/me', { token: tokens.alice });
      assert.equal(r.status, 200);
      assert.equal(r.body.user.name, 'Alice Author');
    });
    it('updates the profile', async () => {
      const r = await api('PATCH', '/api/auth/me', { token: tokens.alice, body: { title: 'Systems Lead', bio: 'Kernel person.' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.user.title, 'Systems Lead');
      assert.equal((await api('PATCH', '/api/auth/me', { token: tokens.alice, body: {} })).status, 400);
    });
    it('slows down password guessing but never blocks the right password or other people', async () => {
      const limited = await startApp({ loginLimits: { windowMs: 60_000, perAccountAndIp: 3, perAccount: 6, perIp: 8 } });
      const login = (email, password) => limited.api('POST', '/api/auth/login', { body: { email, password } });
      await limited.api('POST', '/api/auth/register', { body: { name: 'Real User', email: 'real@itc.test', password: PASSWORD } });
      await limited.api('POST', '/api/auth/register', { body: { name: 'Other User', email: 'other@itc.test', password: PASSWORD } });
      // three wrong guesses for one account from this address...
      assert.deepEqual([await login('real@itc.test', 'bad-guess-1'), await login('real@itc.test', 'bad-guess-2'), await login('real@itc.test', 'bad-guess-3')].map((r) => r.status), [401, 401, 401]);
      // ...then even the correct password waits (that is the point: guessing gets nowhere)
      const blocked = await login('real@itc.test', PASSWORD);
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
      // but everybody else on the same Wi-Fi address can still sign in
      assert.equal((await login('other@itc.test', PASSWORD)).status, 200);
      await limited.close();
    });

    it('does not count typos against someone who then logs in correctly', async () => {
      const limited = await startApp({ loginLimits: { windowMs: 60_000, perAccountAndIp: 3, perAccount: 40, perIp: 150 } });
      await limited.api('POST', '/api/auth/register', { body: { name: 'Typo Person', email: 'typo@itc.test', password: PASSWORD } });
      const login = (password) => limited.api('POST', '/api/auth/login', { body: { email: 'typo@itc.test', password } });
      for (let round = 0; round < 3; round++) {
        assert.equal((await login('wrong-password')).status, 401);
        assert.equal((await login('wrong-password')).status, 401);
        assert.equal((await login(PASSWORD)).status, 200); // success resets the counter
      }
      await limited.close();
    });

    it('limits how many accounts one address can create per hour', async () => {
      const limited = await startApp({ registerLimit: { windowMs: 60_000, max: 2 } });
      const reg = (n) => limited.api('POST', '/api/auth/register', { body: { name: `Person ${n}`, email: `p${n}@itc.test`, password: PASSWORD } });
      assert.deepEqual([(await reg(1)).status, (await reg(2)).status, (await reg(3)).status], [201, 201, 429]);
      await limited.close();
    });

    it('changes the password, signs out older sessions and gives a fresh token', async () => {
      await register('pw', 'Password Changer');
      const oldToken = (await api('POST', '/api/auth/login', { body: { email: 'pw@itc.test', password: PASSWORD } })).body.token;
      await new Promise((r) => setTimeout(r, 1100)); // tokens are timestamped to the second
      const change = (body, token = oldToken) => api('POST', '/api/auth/change-password', { token, body });
      assert.equal((await change({ currentPassword: 'wrong-password', newPassword: 'BrandNew-Pass1' })).status, 400);
      assert.equal((await change({ currentPassword: PASSWORD, newPassword: 'short' })).status, 400);
      assert.equal((await change({ currentPassword: PASSWORD, newPassword: PASSWORD })).status, 400);
      assert.equal((await api('POST', '/api/auth/change-password', { body: { currentPassword: PASSWORD, newPassword: 'BrandNew-Pass1' } })).status, 401);
      const ok = await change({ currentPassword: PASSWORD, newPassword: 'BrandNew-Pass1' });
      assert.equal(ok.status, 200, ok.text);
      assert.equal((await api('GET', '/api/auth/me', { token: oldToken })).status, 401); // other devices are signed out
      assert.equal((await api('GET', '/api/auth/me', { token: ok.body.token })).status, 200); // this one keeps working
      assert.equal((await api('POST', '/api/auth/login', { body: { email: 'pw@itc.test', password: PASSWORD } })).status, 401);
      assert.equal((await api('POST', '/api/auth/login', { body: { email: 'pw@itc.test', password: 'BrandNew-Pass1' } })).status, 200);
    });
  });

  describe('admin: roles and topics', () => {
    it('blocks non-admins', async () => {
      assert.equal((await api('GET', '/api/admin/users', { token: tokens.alice })).status, 403);
      assert.equal((await api('GET', '/api/admin/users')).status, 401);
    });
    it('promotes members to reviewer', async () => {
      for (const key of ['rev1', 'rev2']) {
        const r = await api('PATCH', `/api/admin/users/${ids[key]}`, { token: tokens.admin, body: { role: 'reviewer' } });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.user.role, 'reviewer');
        assert.match(r.body.user.reviewerCode, /^WK-BLIDA-[A-Z2-9]{4,8}$/);
      }
      // roles are read from the database on every request, so the old token already has the new powers
      assert.equal((await api('GET', '/api/reviews/queue', { token: tokens.rev1 })).status, 200);
    });
    it('refuses invalid roles and self role changes', async () => {
      assert.equal((await api('PATCH', `/api/admin/users/${ids.bob}`, { token: tokens.admin, body: { role: 'god' } })).status, 400);
      const self = await api('PATCH', `/api/admin/users/${ids.admin}`, { token: tokens.admin, body: { role: 'author' } });
      assert.equal(self.status, 409);
      assert.equal((await api('PATCH', '/api/admin/users/99999', { token: tokens.admin, body: { role: 'author' } })).status, 404);
    });
    it('lists reviewers with their workload', async () => {
      const r = await api('GET', '/api/admin/reviewers', { token: tokens.admin });
      assert.equal(r.status, 200);
      const names = r.body.reviewers.map((x) => x.name);
      assert.ok(names.includes('Reviewer One') && names.includes('Admin One') && !names.includes('Alice Author'));
    });
    it('lists the design topics and lets admins add one', async () => {
      const list = await api('GET', '/api/categories');
      assert.equal(list.body.categories.length, 8);
      assert.ok(list.body.categories.some((c) => c.slug === 'ai-nlp'));
      assert.ok(list.body.categories.some((c) => c.slug === 'networking'));
      const added = await api('POST', '/api/admin/categories', { token: tokens.admin, body: { name: 'Robotics' } });
      assert.equal(added.status, 201);
      assert.equal(added.body.category.slug, 'robotics');
      assert.equal((await api('POST', '/api/admin/categories', { token: tokens.admin, body: { name: 'robotics' } })).status, 409);
      assert.equal((await api('POST', '/api/admin/categories', { token: tokens.alice, body: { name: 'Nope' } })).status, 403);
    });
  });

  describe('author flow and the review lifecycle', () => {
    let articleId, slug, assignment1, assignment2, assignment3, refCode;
    const devops = () => db.prepare(`SELECT id FROM categories WHERE slug = 'devops'`).get().id;

    it('requires login and validates the draft', async () => {
      assert.equal((await api('POST', '/api/me/articles', { body: { title: 'Hello there' } })).status, 401);
      const short = await api('POST', '/api/me/articles', { token: tokens.alice, body: { title: 'Hi' } });
      assert.equal(short.status, 400);
      assert.ok(short.body.error.details.title);
      const badCat = await api('POST', '/api/me/articles', { token: tokens.alice, body: { title: 'Valid title', categoryId: 9999 } });
      assert.equal(badCat.status, 400);
      assert.ok(badCat.body.error.details.categoryId);
    });

    it('creates a draft with a slug, reference code and computed stats', async () => {
      const r = await api('POST', '/api/me/articles', { token: tokens.alice, body: { title: 'Architecting Low-Latency Telemetry', body: bodyWithCode, tags: ['ebpf', 'go', 'EBPF'] } });
      assert.equal(r.status, 201, r.text);
      const a = r.body.article;
      articleId = a.id;
      slug = a.slug;
      refCode = a.refCode;
      assert.equal(a.status, 'draft');
      assert.equal(slug, 'architecting-low-latency-telemetry');
      assert.match(refCode, /^ARC-\d+$/);
      assert.equal(a.wordCount, 35);
      assert.equal(a.codeBlocks, 1);
      assert.equal(a.readMinutes, 1);
      assert.deepEqual(a.tags, ['ebpf', 'go']); // duplicates (any case) removed
    });

    it('gives duplicate titles unique slugs', async () => {
      const r = await api('POST', '/api/me/articles', { token: tokens.bob, body: { title: 'Architecting Low-Latency Telemetry' } });
      assert.equal(r.body.article.slug, 'architecting-low-latency-telemetry-2');
      assert.equal((await api('DELETE', `/api/me/articles/${r.body.article.id}`, { token: tokens.bob })).status, 204);
    });

    it('saves a draft and recalculates the read-time stats', async () => {
      const r = await api('PATCH', `/api/me/articles/${articleId}`, { token: tokens.alice, body: { subtitle: 'How we traced packets', categoryId: devops(), body: `${words(450)}\n` } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.article.wordCount, 450);
      assert.equal(r.body.article.readMinutes, 3);
      assert.equal(r.body.article.codeBlocks, 0);
      assert.equal((await api('PATCH', `/api/me/articles/${articleId}`, { token: tokens.alice, body: {} })).status, 400);
    });

    it("hides other people's articles (404, not 403)", async () => {
      assert.equal((await api('GET', `/api/me/articles/${articleId}`, { token: tokens.bob })).status, 404);
      assert.equal((await api('PATCH', `/api/me/articles/${articleId}`, { token: tokens.bob, body: { title: 'Hijacked title' } })).status, 404);
      assert.equal((await api('DELETE', `/api/me/articles/${articleId}`, { token: tokens.bob })).status, 404);
      assert.equal((await api('POST', `/api/me/articles/${articleId}/submit`, { token: tokens.bob })).status, 404);
    });

    it('refuses to submit an incomplete article, listing what is missing', async () => {
      const r = await api('POST', '/api/me/articles', { token: tokens.alice, body: { title: 'Unfinished idea', body: 'too short' } });
      const bad = await api('POST', `/api/me/articles/${r.body.article.id}/submit`, { token: tokens.alice });
      assert.equal(bad.status, 400);
      assert.deepEqual(Object.keys(bad.body.error.details).sort(), ['body', 'categoryId', 'subtitle']);
    });

    it('keeps unpublished work private', async () => {
      assert.equal((await api('GET', `/api/articles/${slug}`)).status, 404);
      assert.equal((await api('GET', '/api/articles')).body.total, 0);
    });

    it('submits for review and locks the article', async () => {
      const r = await api('POST', `/api/me/articles/${articleId}/submit`, { token: tokens.alice });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.article.status, 'pending_review');
      assert.equal(r.body.article.revision, 1);
      assert.equal((await api('PATCH', `/api/me/articles/${articleId}`, { token: tokens.alice, body: { title: 'Changed my mind' } })).status, 409);
      assert.equal((await api('POST', `/api/me/articles/${articleId}/submit`, { token: tokens.alice })).status, 409);
      assert.equal((await api('DELETE', `/api/me/articles/${articleId}`, { token: tokens.alice })).status, 409);
      assert.equal((await api('POST', `/api/me/articles/${articleId}/publish`, { token: tokens.alice })).status, 409);
    });

    it('shows it in the admin queue, and only to admins', async () => {
      const q = await api('GET', '/api/admin/queue', { token: tokens.admin });
      assert.equal(q.status, 200);
      assert.equal(q.body.unassigned.length, 1);
      assert.equal(q.body.unassigned[0].article.id, articleId);
      assert.equal(q.body.unassigned[0].lastReturn, null);
      assert.equal((await api('GET', '/api/admin/queue', { token: tokens.rev1 })).status, 403);
    });

    it('validates assignments (conflict of interest, role, status)', async () => {
      const post = (token, body, id = articleId) => api('POST', `/api/admin/articles/${id}/assign`, { token, body });
      // the author cannot review their own paper, even if they are a reviewer
      db.prepare(`UPDATE users SET role = 'reviewer' WHERE id = ?`).run(ids.alice);
      const self = await post(tokens.admin, { reviewerId: ids.alice });
      assert.equal(self.status, 409);
      assert.equal(self.body.error.code, 'conflict_of_interest');
      db.prepare(`UPDATE users SET role = 'author' WHERE id = ?`).run(ids.alice);
      assert.equal((await post(tokens.admin, { reviewerId: ids.bob })).status, 400); // bob is only an author
      assert.equal((await post(tokens.admin, {})).status, 400);
      assert.equal((await post(tokens.admin, { reviewerId: ids.rev1 }, 99999)).status, 404);
      assert.equal((await post(tokens.alice, { reviewerId: ids.rev1 })).status, 403);
    });

    it('assigns a reviewer with priority and a 48h deadline, once', async () => {
      const r = await api('POST', `/api/admin/articles/${articleId}/assign`, { token: tokens.admin, body: { reviewerId: ids.rev1, priority: 'high' } });
      assert.equal(r.status, 201, r.text);
      assignment1 = r.body.assignment.id;
      const hours = (Date.parse(r.body.assignment.dueAt) - Date.parse(r.body.assignment.assignedAt)) / 3_600_000;
      assert.equal(hours, 48);
      const again = await api('POST', `/api/admin/articles/${articleId}/assign`, { token: tokens.admin, body: { reviewerId: ids.rev2 } });
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, 'already_assigned');
      const q = await api('GET', '/api/admin/queue', { token: tokens.admin });
      assert.equal(q.body.unassigned.length, 0);
      assert.equal(q.body.inReview[0].reviewer.name, 'Reviewer One');
    });

    it("shows the reviewer their queue with stats, and nobody else's", async () => {
      const q = await api('GET', '/api/reviews/queue', { token: tokens.rev1 });
      assert.equal(q.status, 200);
      assert.equal(q.body.items.length, 1);
      assert.equal(q.body.items[0].assignment.priority, 'high');
      assert.match(q.body.items[0].assignment.dispatchId, /^ITC-\d{4}-\d{3}-ARC$/);
      assert.equal(q.body.items[0].article.title, 'Architecting Low-Latency Telemetry');
      assert.equal(q.body.stats.pending, 1);
      assert.equal(q.body.stats.urgent, 1);
      assert.equal(q.body.stats.slaHours, 48);
      assert.equal((await api('GET', '/api/reviews/queue', { token: tokens.rev2 })).body.items.length, 0);
      assert.equal((await api('GET', '/api/reviews/queue', { token: tokens.alice })).status, 403);
      assert.equal((await api('GET', `/api/reviews/assignments/${assignment1}`, { token: tokens.rev2 })).status, 404);
    });

    it('lets the reviewer read the full manuscript', async () => {
      const r = await api('GET', `/api/reviews/assignments/${assignment1}`, { token: tokens.rev1 });
      assert.equal(r.status, 200);
      assert.equal(r.body.article.wordCount, 450);
      assert.ok(r.body.article.body.length > 100);
      assert.equal(r.body.article.author.name, 'Alice Author');
      assert.deepEqual(r.body.previousReviews, []);
    });

    it('requires feedback to request changes, then sends the article back to the author', async () => {
      const decide = (body) => api('POST', `/api/reviews/assignments/${assignment1}/decision`, { token: tokens.rev1, body });
      assert.equal((await decide({ decision: 'maybe' })).status, 400);
      assert.equal((await decide({ decision: 'request_changes' })).status, 400);
      assert.equal((await decide({ decision: 'request_changes', feedback: 'too short' })).status, 400);
      const ok = await decide({ decision: 'request_changes', feedback: 'Please list the CUDA and TensorRT versions used.' });
      assert.equal(ok.status, 201, ok.text);
      assert.equal(ok.body.articleStatus, 'changes_requested');
      assert.equal((await decide({ decision: 'approve' })).status, 409); // already closed
    });

    it('stores a verifiable signature for the decision', () => {
      const review = db.prepare('SELECT * FROM reviews WHERE assignment_id = ?').get(assignment1);
      const expected = signReview(ctx.config, {
        assignmentId: review.assignment_id, articleId: review.article_id, revision: review.revision,
        reviewerId: review.reviewer_id, decision: review.decision, feedback: review.feedback, createdAt: review.created_at,
      });
      assert.equal(review.signature, expected);
    });

    it('shows the author the feedback with the reviewer ID but not the name', async () => {
      const r = await api('GET', `/api/me/articles/${articleId}`, { token: tokens.alice });
      assert.equal(r.body.article.status, 'changes_requested');
      assert.equal(r.body.reviews.length, 1);
      assert.match(r.body.reviews[0].reviewerCode, /^WK-BLIDA-[A-Z2-9]{4,8}$/);
      assert.match(r.body.reviews[0].feedback, /TensorRT/);
      assert.ok(!r.text.includes('Reviewer One'));
      const list = await api('GET', '/api/me/articles', { token: tokens.alice });
      const item = list.body.items.find((i) => i.id === articleId);
      assert.equal(item.reviewerNotes, 1);
      assert.equal(list.body.counts.changes_requested, 1);
    });

    it('lets the author fix it and resubmit under the same reference code', async () => {
      assert.equal((await api('PATCH', `/api/me/articles/${articleId}`, { token: tokens.alice, body: { body: `${words(500)}\n` } })).status, 200);
      const r = await api('POST', `/api/me/articles/${articleId}/submit`, { token: tokens.alice });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.article.status, 'pending_review');
      assert.equal(r.body.article.revision, 2);
      assert.equal(r.body.article.refCode, refCode);
    });

    it('lets a reviewer return an assignment (not a rejection) and surfaces it to admins', async () => {
      const a = await api('POST', `/api/admin/articles/${articleId}/assign`, { token: tokens.admin, body: { reviewerId: ids.rev2 } });
      assignment2 = a.body.assignment.id;
      const ret = (body) => api('POST', `/api/reviews/assignments/${assignment2}/return`, { token: tokens.rev2, body });
      assert.equal((await ret({})).status, 400);
      assert.equal((await ret({ reason: 'short' })).status, 400);
      assert.equal((await api('POST', `/api/reviews/assignments/${assignment2}/return`, { token: tokens.rev1, body: { reason: 'Not mine to return at all' } })).status, 404);
      const ok = await ret({ reason: 'I specialize in NLP, this needs a kernel expert.', suggestedExpertise: 'Linux kernel / eBPF' });
      assert.equal(ok.status, 200, ok.text);
      assert.equal((await ret({ reason: 'Returning it a second time now' })).status, 409);

      const q = await api('GET', '/api/admin/queue', { token: tokens.admin });
      assert.equal(q.body.unassigned.length, 1);
      assert.equal(q.body.unassigned[0].article.status, 'pending_review');
      assert.equal(q.body.unassigned[0].lastReturn.suggestedExpertise, 'Linux kernel / eBPF');
      assert.match(q.body.unassigned[0].lastReturn.reviewerCode, /^WK-BLIDA-/);
      assert.equal((await api('GET', '/api/reviews/queue', { token: tokens.rev2 })).body.items.length, 0);
    });

    it('lets the admin reassign, and the second reviewer approve', async () => {
      const a = await api('POST', `/api/admin/articles/${articleId}/assign`, { token: tokens.admin, body: { reviewerId: ids.rev1 } });
      assert.equal(a.status, 201, a.text);
      assignment3 = a.body.assignment.id;
      const detail = await api('GET', `/api/reviews/assignments/${assignment3}`, { token: tokens.rev1 });
      assert.equal(detail.body.previousReviews.length, 1); // sees the first round's feedback
      const ok = await api('POST', `/api/reviews/assignments/${assignment3}/decision`, { token: tokens.rev1, body: { decision: 'approve', feedback: 'Great, all points addressed.' } });
      assert.equal(ok.status, 201, ok.text);
      assert.equal(ok.body.articleStatus, 'approved');
      assert.equal((await api('GET', `/api/articles/${slug}`)).status, 404); // approved is still not public
    });

    it('only publishes when the owner (or an admin) says so', async () => {
      assert.equal((await api('POST', `/api/me/articles/${articleId}/publish`, { token: tokens.bob })).status, 404);
      assert.equal((await api('POST', `/api/admin/articles/${articleId}/publish`, { token: tokens.alice })).status, 403);
      const r = await api('POST', `/api/me/articles/${articleId}/publish`, { token: tokens.alice });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.article.status, 'published');
      assert.ok(r.body.article.publishedAt);
      assert.equal((await api('POST', `/api/me/articles/${articleId}/publish`, { token: tokens.alice })).status, 409);
      assert.equal((await api('POST', `/api/admin/articles/${articleId}/publish`, { token: tokens.admin })).status, 409);
    });

    it('shows the author dashboard stats', async () => {
      const r = await api('GET', '/api/me/articles', { token: tokens.alice });
      assert.equal(r.body.counts.published, 1);
      assert.equal(r.body.counts.draft, 1); // "Unfinished idea"
      assert.equal(r.body.stats.reviewedManuscripts, 1);
      assert.equal(r.body.stats.firstPassApproved, 0); // first review asked for changes
      assert.equal(r.body.stats.publishRate, 0);
      assert.equal(typeof r.body.stats.avgReviewHours, 'number');
      assert.equal(r.body.stats.reviewTargetHours, 24);
      // "this quarter": readers whose first visit was last year must not count, new ones must
      const before = r.body.stats.communityReads;
      assert.equal(typeof before, 'number'); // nobody has read it yet at this point in the flow
      db.prepare(`INSERT INTO article_views (article_id, viewer_hash, first_viewed_at) VALUES (?, 'old-reader', '2020-01-15T10:00:00.000Z')`).run(articleId);
      const afterOld = (await api('GET', '/api/me/articles', { token: tokens.alice })).body.stats.communityReads;
      assert.equal(afterOld, before);
      db.prepare(`INSERT INTO article_views (article_id, viewer_hash, first_viewed_at) VALUES (?, 'new-reader', ?)`).run(articleId, new Date().toISOString());
      const afterNew = (await api('GET', '/api/me/articles', { token: tokens.alice })).body.stats.communityReads;
      assert.equal(afterNew, before + 1);
      db.prepare(`DELETE FROM article_views WHERE viewer_hash IN ('old-reader', 'new-reader')`).run();
      const bobList = await api('GET', '/api/me/articles', { token: tokens.bob });
      assert.equal(bobList.body.stats.publishRate, null); // nothing reviewed yet: no fake numbers
      assert.equal(bobList.body.total, 0);
    });

    it('filters and searches my articles', async () => {
      const byStatus = await api('GET', '/api/me/articles?status=draft', { token: tokens.alice });
      assert.equal(byStatus.body.items.length, 1);
      assert.equal(byStatus.body.items[0].title, 'Unfinished idea');
      assert.equal((await api('GET', '/api/me/articles?status=bogus', { token: tokens.alice })).status, 400);
      const bySearch = await api('GET', '/api/me/articles?search=telemetry', { token: tokens.alice });
      assert.equal(bySearch.body.items.length, 1);
    });

    it('updates reviewer stats', async () => {
      const q = await api('GET', '/api/reviews/queue', { token: tokens.rev1 });
      assert.equal(q.body.stats.pending, 0);
      assert.equal(q.body.stats.reviewedThisMonth, 2);
      assert.equal(typeof q.body.stats.avgTurnaroundHours, 'number');
      const done = await api('GET', '/api/reviews/queue?status=completed', { token: tokens.rev1 });
      assert.equal(done.body.items.length, 2);
      assert.equal((await api('GET', '/api/reviews/queue?status=bogus', { token: tokens.rev1 })).status, 400);
    });

    it('serves the published article publicly, counting each reader once', async () => {
      const first = await api('GET', `/api/articles/${slug}`, { headers: { 'user-agent': 'browser-A' } });
      assert.equal(first.status, 200);
      assert.equal(first.body.article.title, 'Architecting Low-Latency Telemetry');
      assert.ok(first.body.article.body.length > 100);
      assert.equal(first.body.author.name, 'Alice Author');
      assert.equal(first.body.author.bio, 'Kernel person.');
      assert.equal(first.body.article.reads, 1);
      assert.equal((await api('GET', `/api/articles/${slug}`, { headers: { 'user-agent': 'browser-A' } })).body.article.reads, 1);
      // changing the browser name from the same address must NOT look like a new reader
      assert.equal((await api('GET', `/api/articles/${slug}`, { headers: { 'user-agent': 'browser-B' } })).body.article.reads, 1);
      assert.equal((await api('GET', `/api/articles/${slug}`, { token: tokens.bob })).body.article.reads, 2); // signed-in readers count per account
      assert.equal((await api('GET', `/api/articles/${slug}`, { token: tokens.bob })).body.article.reads, 2);
      assert.equal((await api('GET', `/api/articles/${slug}`, { token: tokens.alice })).body.article.reads, 2); // authors don't count
      assert.equal((await api('GET', '/api/articles/does-not-exist')).status, 404);
    });
  });

  describe('public catalog (several published articles)', () => {
    const published = [];
    before(async () => {
      const cat = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;
      published.push(await publishViaApi('bob', { title: 'Quantization Horizons AWQ vs FP8', categoryId: cat('ai-nlp'), tags: ['gpu', 'llm'], kind: 'research-paper' }));
      published.push(await publishViaApi('bob', { title: 'Postgres B-Tree Bloat Tuning', categoryId: cat('databases'), body: `${words(900)}\n` }));
      published.push(await publishViaApi('alice', { title: 'Zero-Downtime Cilium Migration', categoryId: cat('devops') }, 'rev2'));
    });

    it('lists and paginates, newest first', async () => {
      const all = await api('GET', '/api/articles');
      assert.equal(all.body.total, 4);
      assert.equal(all.body.items[0].title, 'Zero-Downtime Cilium Migration');
      assert.equal(all.body.hasMore, false);
      const p1 = await api('GET', '/api/articles?limit=3&page=1');
      const p2 = await api('GET', '/api/articles?limit=3&page=2');
      assert.equal(p1.body.items.length, 3);
      assert.equal(p1.body.hasMore, true);
      assert.equal(p2.body.items.length, 1);
      assert.equal(p2.body.hasMore, false);
      assert.equal(new Set([...p1.body.items, ...p2.body.items].map((i) => i.id)).size, 4);
      assert.ok(!('body' in all.body.items[0])); // lists stay light
    });

    it('rejects bad paging and sorting', async () => {
      for (const q of ['page=0', 'limit=1000', 'limit=abc', 'sort=nonsense', 'author=abc']) {
        assert.equal((await api('GET', `/api/articles?${q}`)).status, 400, q);
      }
    });

    it('filters by topic and author', async () => {
      assert.equal((await api('GET', '/api/articles?category=databases')).body.total, 1);
      assert.equal((await api('GET', '/api/articles?category=nope')).body.total, 0);
      assert.equal((await api('GET', `/api/articles?author=${ids.alice}`)).body.total, 2);
    });

    it('searches title, tags, author name and body', async () => {
      const total = async (q) => (await api('GET', `/api/articles?search=${encodeURIComponent(q)}`)).body.total;
      assert.equal(await total('quantization'), 1); // title
      assert.equal(await total('llm'), 1); // tag
      assert.equal(await total('bob writer'), 2); // author (Bob wrote two of the four)
      assert.equal(await total('word29'), 4); // body text (in all four)
      assert.equal(await total('word123'), 2); // only the two long articles reach that far
      assert.equal(await total('zzz-no-match'), 0);
    });

    it('treats search text as text, not as SQL or wildcards', async () => {
      const total = async (q) => (await api('GET', `/api/articles?search=${encodeURIComponent(q)}`)).body;
      assert.equal((await total('%')).total, 0);
      assert.equal((await total('_')).total, 0);
      const inj = await total(`' OR 1=1 --`);
      assert.equal(inj.total, 0);
    });

    it('sorts by oldest, shortest and most read', async () => {
      assert.equal((await api('GET', '/api/articles?sort=oldest')).body.items[0].title, 'Architecting Low-Latency Telemetry');
      const shortest = (await api('GET', '/api/articles?sort=shortest')).body.items;
      assert.ok(shortest[0].readMinutes <= shortest.at(-1).readMinutes);
      assert.equal(shortest.at(-1).title, 'Postgres B-Tree Bloat Tuning'); // 900 words
      assert.equal((await api('GET', '/api/articles?sort=popular')).body.items[0].title, 'Architecting Low-Latency Telemetry');
    });

    it('computes the Explore header stats', async () => {
      const r = await api('GET', '/api/articles/stats');
      assert.equal(r.status, 200);
      assert.equal(r.body.publishedArticles, 4);
      assert.equal(r.body.activeTracks, 3); // devops, ai-nlp, databases
      assert.ok(r.body.meanReadMinutes >= 1);
      // every article that was ever submitted ended up published, so 4 of 4
      assert.equal(r.body.acceptanceRate, 100);
    });

    it('features articles on the homepage (admin only, published only)', async () => {
      assert.equal((await api('GET', '/api/articles/featured')).body.items.length, 0);
      const [a, b, c] = published;
      assert.equal((await api('POST', `/api/admin/articles/${a.id}/feature`, { token: tokens.bob, body: { featured: true } })).status, 403);
      assert.equal((await api('POST', `/api/admin/articles/${a.id}/feature`, { token: tokens.admin, body: {} })).status, 400);
      for (const art of [a, b, c]) {
        assert.equal((await api('POST', `/api/admin/articles/${art.id}/feature`, { token: tokens.admin, body: { featured: true } })).status, 200);
      }
      const featured = await api('GET', '/api/articles/featured');
      assert.equal(featured.body.items.length, 2); // default is the 2 highlights from the design
      assert.equal(featured.body.items[0].featured, true);
      assert.equal((await api('GET', '/api/articles/featured?limit=6')).body.items.length, 3);
      await api('POST', `/api/admin/articles/${c.id}/feature`, { token: tokens.admin, body: { featured: false } });
      assert.equal((await api('GET', '/api/articles/featured?limit=6')).body.items.length, 2);
      const draft = await api('POST', '/api/me/articles', { token: tokens.bob, body: { title: 'Still a draft' } });
      assert.equal((await api('POST', `/api/admin/articles/${draft.body.article.id}/feature`, { token: tokens.admin, body: { featured: true } })).status, 409);
    });

    it('includes related articles, same topic first, never itself', async () => {
      const first = published[0];
      const r = await api('GET', `/api/articles/${first.slug}`);
      assert.equal(r.body.related.length, 3);
      assert.ok(r.body.related.every((x) => x.id !== first.id));
      const devops = await api('GET', `/api/articles/${published[2].slug}`);
      assert.equal(devops.body.related.length, 3);
      assert.equal(devops.body.related[0].category.slug, 'devops'); // the other DevOps article ranks first
    });

    it('downloads an article as a Markdown file', async () => {
      const r = await api('GET', `/api/articles/${published[1].slug}/download?format=md`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition'), /attachment; filename="?postgres-b-tree-bloat-tuning\.md"?/);
      assert.match(r.headers.get('content-type'), /text\/markdown/);
      assert.ok(r.text.startsWith('# Postgres B-Tree Bloat Tuning'));
      assert.equal((await api('GET', '/api/articles/nope/download')).status, 404);
    });

    it('shows author profiles', async () => {
      const r = await api('GET', `/api/authors/${ids.bob}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.author.name, 'Bob Writer');
      assert.equal(r.body.author.articleCount, 2);
      assert.ok(!r.text.includes('bob@itc.test')); // no email on public profiles
      assert.equal((await api('GET', '/api/authors/99999')).status, 404);
      assert.equal((await api('GET', '/api/authors/abc')).status, 404);
    });

    it('counts topics', async () => {
      const r = await api('GET', '/api/categories');
      const devops = r.body.categories.find((c) => c.slug === 'devops');
      assert.equal(devops.articleCount, 2);
    });
  });

  describe('images, PDF, reference codes, outline, autosave', () => {
    // 1x1 pixel PNG (valid), and files that only LOOK like images
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(30, 1)]);
    const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([30, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(20, 1)]);
    const CORRUPT_PNG = Buffer.concat([PNG.subarray(0, 8), Buffer.from('this is not really a png file at all')]);
    const state = {};

    const upload = async (token, bytes, type = 'image/png') => {
      const res = await fetch(`${ctx.base}/api/me/uploads`, {
        method: 'POST',
        headers: { 'content-type': type, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: bytes,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    };
    const download = async (path) => {
      const res = await fetch(ctx.base + path);
      return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
    };

    before(async () => {
      await register('dana', 'Dana Amine');
      state.devops = db.prepare(`SELECT id FROM categories WHERE slug = 'devops'`).get().id;
    });

    it('accepts PNG, JPEG and WebP uploads and stores them under random names', async () => {
      const png = await upload(tokens.dana, PNG);
      assert.equal(png.status, 201, JSON.stringify(png.body));
      assert.match(png.body.upload.url, /^\/uploads\/[0-9a-f]{24}\.png$/);
      assert.equal(png.body.upload.bytes, PNG.length);
      state.png = png.body.upload;
      assert.match((await upload(tokens.dana, JPEG, 'image/jpeg')).body.upload.url, /\.jpg$/);
      assert.match((await upload(tokens.dana, WEBP, 'image/webp')).body.upload.url, /\.webp$/);
      assert.ok(existsSync(join(ctx.uploadsDir, state.png.url.split('/').pop())));
    });

    it('rejects uploads that are not real images, are too big, or are anonymous', async () => {
      assert.equal((await upload(null, PNG)).status, 401);
      assert.equal((await upload(tokens.dana, Buffer.from('<script>alert(1)</script>'), 'text/html')).status, 415);
      assert.equal((await upload(tokens.dana, Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml')).status, 415);
      const disguised = await upload(tokens.dana, Buffer.from('<script>alert(1)</script>'), 'image/png'); // says PNG, is not
      assert.equal(disguised.status, 400);
      assert.equal((await upload(tokens.dana, JPEG, 'image/png')).status, 400); // JPEG bytes labelled as PNG
      assert.equal((await upload(tokens.dana, Buffer.alloc(0), 'image/png')).status, 415);
      const huge = await upload(tokens.dana, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 10)]));
      assert.equal(huge.status, 413);
    });

    it('serves uploaded images publicly with safe headers', async () => {
      const r = await download(state.png.url);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'image/png');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
      assert.deepEqual(r.bytes, PNG);
      assert.equal((await download('/uploads/doesnotexist.png')).status, 404);
      assert.equal((await download('/uploads/..%2f..%2fpackage.json')).status, 404);
    });

    it('lists my uploads and keeps other people\'s private', async () => {
      const mine = await api('GET', '/api/me/uploads', { token: tokens.dana });
      assert.equal(mine.body.items.length, 3);
      assert.equal((await api('GET', '/api/me/uploads', { token: tokens.bob })).body.items.length, 0);
      assert.equal((await api('DELETE', `/api/me/uploads/${state.png.id}`, { token: tokens.bob })).status, 404);
    });

    it('enforces the per-user upload limit', async () => {
      const small = await startApp({ maxUploadsPerUser: 1 });
      const reg = await small.api('POST', '/api/auth/register', { body: { name: 'Limit Tester', email: 'l@itc.test', password: PASSWORD } });
      const send = () => fetch(`${small.base}/api/me/uploads`, { method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${reg.body.token}` }, body: PNG });
      assert.equal((await send()).status, 201);
      const second = await send();
      assert.equal(second.status, 409);
      assert.equal((await second.json()).error.code, 'upload_limit');
      await small.close();
    });

    it('attaches a cover figure with a caption, and only from my own uploads', async () => {
      const created = await api('POST', '/api/me/articles', { token: tokens.dana, body: { title: 'Kernel tracing figures', coverImageId: state.png.id, coverCaption: 'Figure 1.0: ring buffer' } });
      assert.equal(created.status, 201, created.text);
      assert.deepEqual(created.body.article.cover, { id: state.png.id, url: state.png.url, caption: 'Figure 1.0: ring buffer' });
      state.coverArticle = created.body.article;
      const stolen = await api('POST', '/api/me/articles', { token: tokens.bob, body: { title: 'Borrowed image', coverImageId: state.png.id } });
      assert.equal(stolen.status, 400);
      assert.ok(stolen.body.error.details.coverImageId);
      assert.equal((await api('POST', '/api/me/articles', { token: tokens.dana, body: { title: 'Ghost image', coverImageId: 99999 } })).status, 400);
    });

    it('changes the caption, removes the cover with null, and sets it again', async () => {
      const id = state.coverArticle.id;
      const cap = await api('PATCH', `/api/me/articles/${id}`, { token: tokens.dana, body: { coverCaption: 'New caption' } });
      assert.equal(cap.body.article.cover.caption, 'New caption');
      assert.equal(cap.body.article.cover.url, state.png.url);
      const cleared = await api('PATCH', `/api/me/articles/${id}`, { token: tokens.dana, body: { coverImageId: null } });
      assert.equal(cleared.status, 200, cleared.text);
      assert.equal(cleared.body.article.cover, null);
      const again = await api('PATCH', `/api/me/articles/${id}`, { token: tokens.dana, body: { coverImageId: state.png.id } });
      assert.equal(again.body.article.cover.url, state.png.url);
    });

    it('protects autosave from overwriting newer changes (edit conflict)', async () => {
      const id = state.coverArticle.id;
      const first = await api('PATCH', `/api/me/articles/${id}`, { token: tokens.dana, body: { subtitle: 'version 1' } });
      const stamp1 = first.body.article.updatedAt;
      const second = await api('PATCH', `/api/me/articles/${id}`, { token: tokens.dana, body: { subtitle: 'version 2', baseUpdatedAt: stamp1 } });
      assert.equal(second.status, 200, second.text);
      const stamp2 = second.body.article.updatedAt;
      assert.ok(stamp2 > stamp1); // strictly newer, even for instant saves
      // a second browser tab still holding the old timestamp must not overwrite version 2
      const stale = await api('PATCH', `/api/me/articles/${id}`, { token: tokens.dana, body: { subtitle: 'stale tab', baseUpdatedAt: stamp1 } });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.code, 'edit_conflict');
      assert.equal((await api('GET', `/api/me/articles/${id}`, { token: tokens.dana })).body.article.subtitle, 'version 2');
      // a plain save without baseUpdatedAt still works (last write wins)
      assert.equal((await api('PATCH', `/api/me/articles/${id}`, { token: tokens.dana, body: { subtitle: 'version 3' } })).status, 200);
    });

    it('gives every article with a body a table of contents with read time per section', async () => {
      const body = `Opening words before any heading.\n\n## 1. Overview\n${words(450)}\n\n\`\`\`sh\n# a comment, not a heading\n\`\`\`\n\n## 2. Benchmarks\n${words(100)}\n\n### 2.1 Detail\nshort\n`;
      const r = await api('PATCH', `/api/me/articles/${state.coverArticle.id}`, { token: tokens.dana, body: { body } });
      const sections = r.body.article.sections;
      assert.deepEqual(sections.map((s) => s.title), ['Overview', '1. Overview', '2. Benchmarks', '2.1 Detail']);
      assert.deepEqual(sections.map((s) => s.level), [1, 2, 2, 3]);
      assert.equal(sections[1].readMinutes, 3); // 450+ words
      assert.equal(sections[2].readMinutes, 1);
      assert.deepEqual(sections.map((s) => s.index), [1, 2, 3, 4]);
    });

    it('lets admins set editorial reference codes, unique and validated', async () => {
      const id = state.coverArticle.id;
      const set = (token, refCode, articleId = id) => api('PATCH', `/api/admin/articles/${articleId}/ref-code`, { token, body: { refCode } });
      const ok = await set(tokens.admin, 'rfc-1049-dz');
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.body.article.refCode, 'RFC-1049-DZ');
      assert.equal((await set(tokens.dana, 'RFC-1-DZ')).status, 403);
      for (const bad of ['no spaces here', 'X', '--', 'lower_case_underscore', 'A-B-C-D-E-F-G']) {
        assert.equal((await set(tokens.admin, bad)).status, 400, bad);
      }
      assert.equal((await set(tokens.admin, 'RFC-1049-DZ', 99999)).status, 404);
      const other = await api('POST', '/api/me/articles', { token: tokens.dana, body: { title: 'Another one entirely' } });
      const dup = await set(tokens.admin, 'RFC-1049-DZ', other.body.article.id);
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.code, 'ref_code_taken');
      assert.equal((await set(tokens.admin, 'RFC-1049-DZ')).status, 200); // keeping its own code is fine
    });

    it('never produces a duplicate automatic code when an admin took it first', async () => {
      const nextId = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM articles').get().n;
      const target = `ZZZ-${100 + nextId}`;
      await api('PATCH', `/api/admin/articles/${state.coverArticle.id}/ref-code`, { token: tokens.admin, body: { refCode: target } });
      const created = await api('POST', '/api/me/articles', { token: tokens.dana, body: { title: 'Zzz collision test' } });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.body.article.refCode, `${target}-2`);
      await api('PATCH', `/api/admin/articles/${state.coverArticle.id}/ref-code`, { token: tokens.admin, body: { refCode: 'RFC-1049-DZ' } });
    });

    it('publishes an article with a figure and offers PDF and Markdown downloads with sizes', async () => {
      const body = `Intro with **bold** text. ${words(30)}\n\n## 1. Results\n\n- point one\n- point two\n\n| Vector | Latency |\n|---|---|\n| ptrace | 4.28 ms |\n| ebpf | 0.08 ms |\n\n\`\`\`go\nfunc main() {}\n\`\`\`\n\n![Figure 2](${state.png.url})\n\nCafé, déjà vu, and Arabic: مرحبا\n`;
      const art = await publishViaApi('dana', { title: 'Figures and downloads', categoryId: state.devops, body, coverImageId: state.png.id, coverCaption: 'Figure 1.0: the cover' });
      state.published = art;
      const detail = await api('GET', `/api/articles/${art.slug}`);
      assert.equal(detail.body.article.cover.url, state.png.url);
      assert.equal(detail.body.article.cover.caption, 'Figure 1.0: the cover');
      assert.ok(detail.body.article.sections.length >= 2);

      const info = await api('GET', `/api/articles/${art.slug}/downloads`);
      assert.equal(info.status, 200, info.text);
      assert.ok(info.body.pdf.bytes > 1500);
      assert.ok(info.body.markdown.bytes > 100);
      assert.match(info.body.pdf.url, /format=pdf$/);

      const pdf = await download(`/api/articles/${art.slug}/download`); // PDF is the default
      assert.equal(pdf.status, 200);
      assert.equal(pdf.headers.get('content-type'), 'application/pdf');
      assert.match(pdf.headers.get('content-disposition'), /figures-and-downloads\.pdf/);
      assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
      assert.equal(pdf.bytes.subarray(-8).toString().includes('%%EOF'), true);
      assert.equal(pdf.bytes.length, info.body.pdf.bytes); // the size shown on the button is the real size
      const explicit = await download(`/api/articles/${art.slug}/download?format=pdf`);
      assert.equal(explicit.bytes.length, pdf.bytes.length);

      const md = await api('GET', `/api/articles/${art.slug}/download?format=md`);
      assert.match(md.headers.get('content-type'), /text\/markdown/);
      assert.equal(Buffer.byteLength(md.text), info.body.markdown.bytes);
      assert.equal((await api('GET', `/api/articles/${art.slug}/download?format=docx`)).status, 400);
      assert.equal((await api('GET', '/api/articles/nope/download')).status, 404);
      assert.equal((await api('GET', '/api/articles/nope/downloads')).status, 404);
    });

    it('still produces a PDF (without the image) when a cover image is corrupt, and the server stays up', async () => {
      const bad = await upload(tokens.dana, CORRUPT_PNG);
      assert.equal(bad.status, 201); // it has valid PNG magic bytes, so the upload itself is accepted
      const art = await publishViaApi('dana', { title: 'Broken cover image', categoryId: state.devops, coverImageId: bad.body.upload.id, coverCaption: 'cap' });
      const pdf = await download(`/api/articles/${art.slug}/download`);
      assert.equal(pdf.status, 200);
      assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
      assert.equal((await api('GET', '/api/health')).status, 200);
    });

    it('refuses to delete images that a published or in-review article depends on', async () => {
      assert.equal((await api('DELETE', `/api/me/uploads/${state.png.id}`, { token: tokens.dana })).status, 409); // cover of a published article
      const inBody = await upload(tokens.dana, JPEG, 'image/jpeg');
      const draft = await api('POST', '/api/me/articles', { token: tokens.dana, body: { title: 'Inline image article', subtitle: 'x', categoryId: state.devops, body: `${words(30)}\n\n![fig](${inBody.body.upload.url})\n` } });
      await api('POST', `/api/me/articles/${draft.body.article.id}/submit`, { token: tokens.dana });
      const blocked = await api('DELETE', `/api/me/uploads/${inBody.body.upload.id}`, { token: tokens.dana });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error.code, 'upload_in_use');
    });

    it('deletes unused images from the database and from disk', async () => {
      const spare = await upload(tokens.dana, WEBP, 'image/webp');
      const file = join(ctx.uploadsDir, spare.body.upload.url.split('/').pop());
      assert.ok(existsSync(file));
      assert.equal((await api('DELETE', `/api/me/uploads/${spare.body.upload.id}`, { token: tokens.dana })).status, 204);
      assert.equal(existsSync(file), false);
      assert.equal((await download(spare.body.upload.url)).status, 404);
      assert.equal((await api('DELETE', `/api/me/uploads/${spare.body.upload.id}`, { token: tokens.dana })).status, 404);
    });

    it('lets a draft keep working after its cover image is deleted', async () => {
      const temp = await upload(tokens.dana, PNG);
      const draft = await api('POST', '/api/me/articles', { token: tokens.dana, body: { title: 'Loses its cover', coverImageId: temp.body.upload.id } });
      assert.equal((await api('DELETE', `/api/me/uploads/${temp.body.upload.id}`, { token: tokens.dana })).status, 204);
      const after = await api('GET', `/api/me/articles/${draft.body.article.id}`, { token: tokens.dana });
      assert.equal(after.status, 200);
      assert.equal(after.body.article.cover, null);
    });
  });

  describe('improvised until the boss answers: target node and members directory', () => {
    const makeArticle = (token, fields) => api('POST', '/api/me/articles', { token, body: fields });

    it('gives new articles the default target node and normalises custom ones', async () => {
      const plain = await makeArticle(tokens.dana, { title: 'Default node article' });
      assert.equal(plain.body.article.targetNode, 'ITC-BLIDA-MAIN');
      const custom = await makeArticle(tokens.dana, { title: 'Custom node article', targetNode: 'itc-algiers-lab' });
      assert.equal(custom.body.article.targetNode, 'ITC-ALGIERS-LAB');
      for (const bad of ['no spaces allowed', 'X', 'under_score', '--']) {
        const r = await makeArticle(tokens.dana, { title: 'Bad node article', targetNode: bad });
        assert.equal(r.status, 400, bad);
        assert.ok(r.body.error.details.targetNode, bad);
      }
    });

    it('lets the author change it while the article is editable, and not afterwards', async () => {
      const a = await makeArticle(tokens.dana, { title: 'Movable article', subtitle: 'x', categoryId: db.prepare(`SELECT id FROM categories WHERE slug = 'cloud'`).get().id, body: words(30) });
      const patched = await api('PATCH', `/api/me/articles/${a.body.article.id}`, { token: tokens.dana, body: { targetNode: 'ITC-ORAN-MAIN' } });
      assert.equal(patched.body.article.targetNode, 'ITC-ORAN-MAIN');
      await api('POST', `/api/me/articles/${a.body.article.id}/submit`, { token: tokens.dana });
      const locked = await api('PATCH', `/api/me/articles/${a.body.article.id}`, { token: tokens.dana, body: { targetNode: 'ITC-BLIDA-MAIN' } });
      assert.equal(locked.status, 409);
    });

    it('filters published articles by node and lists the nodes in use', async () => {
      const totalBefore = (await api('GET', '/api/articles')).body.total;
      const art = await publishViaApi('dana', { title: 'Published on another node', categoryId: db.prepare(`SELECT id FROM categories WHERE slug = 'devops'`).get().id, targetNode: 'ITC-ALGIERS-LAB' });
      assert.equal(art.targetNode, 'ITC-ALGIERS-LAB');
      const filtered = await api('GET', '/api/articles?node=itc-algiers-lab');
      assert.equal(filtered.body.total, 1);
      assert.equal(filtered.body.items[0].title, 'Published on another node');
      const main = await api('GET', '/api/articles?node=ITC-BLIDA-MAIN');
      assert.equal(main.body.total, totalBefore); // every older article kept the default node
      assert.equal((await api('GET', '/api/articles?node=bad%20node')).status, 400);

      const nodes = await api('GET', '/api/nodes');
      assert.equal(nodes.body.defaultNode, 'ITC-BLIDA-MAIN');
      const byCode = Object.fromEntries(nodes.body.nodes.map((n) => [n.code, n.articleCount]));
      assert.equal(byCode['ITC-ALGIERS-LAB'], 1);
      assert.equal(byCode['ITC-BLIDA-MAIN'], totalBefore);
    });

    it('lists contributors in a members directory (only people with published work, no emails)', async () => {
      const r = await api('GET', '/api/authors');
      assert.equal(r.status, 200, r.text);
      const names = r.body.items.map((m) => m.name);
      assert.deepEqual([...names].sort(), ['Alice Author', 'Bob Writer', 'Dana Amine']);
      assert.ok(!names.includes('Admin One') && !names.includes('Reviewer One') && !names.includes('Carol C'));
      assert.equal(r.body.total, 3);
      const counts = r.body.items.map((m) => m.articleCount);
      assert.deepEqual(counts, [...counts].sort((a, b) => b - a)); // most articles first
      assert.ok(r.body.items.every((m) => m.latestPublishedAt));
      assert.ok(!r.text.includes('@itc.test'));
    });

    it('searches, sorts and pages the members directory', async () => {
      assert.deepEqual((await api('GET', '/api/authors?search=bob')).body.items.map((m) => m.name), ['Bob Writer']);
      assert.equal((await api('GET', '/api/authors?search=%25')).body.total, 0); // % is text, not a wildcard
      assert.deepEqual((await api('GET', '/api/authors?sort=name')).body.items.map((m) => m.name), ['Alice Author', 'Bob Writer', 'Dana Amine']);
      assert.equal((await api('GET', '/api/authors?sort=recent')).body.items[0].name, 'Dana Amine'); // published last
      const p1 = await api('GET', '/api/authors?sort=name&limit=2&page=1');
      const p2 = await api('GET', '/api/authors?sort=name&limit=2&page=2');
      assert.equal(p1.body.items.length, 2);
      assert.equal(p1.body.hasMore, true);
      assert.equal(p2.body.items.length, 1);
      assert.equal(p2.body.hasMore, false);
      assert.equal((await api('GET', '/api/authors?sort=bogus')).status, 400);
      // the single-profile route still works next to the directory
      assert.equal((await api('GET', `/api/authors/${ids.dana}`)).body.author.name, 'Dana Amine');
    });

    it('treats an expired or invalid token on a public page as anonymous instead of failing', async () => {
      const published = (await api('GET', '/api/articles?limit=1')).body.items[0];
      const r = await api('GET', `/api/articles/${published.slug}`, { token: 'expired-or-garbage' });
      assert.equal(r.status, 200);
      assert.equal((await api('GET', '/api/auth/me', { token: 'expired-or-garbage' })).status, 401); // protected routes still refuse
    });

    it('lets an admin reset a forgotten password with a one-time temporary password', async () => {
      await register('forgot', 'Forgetful Member');
      const oldToken = (await api('POST', '/api/auth/login', { body: { email: 'forgot@itc.test', password: PASSWORD } })).body.token;
      await new Promise((r) => setTimeout(r, 1100));
      assert.equal((await api('POST', `/api/admin/users/${ids.forgot}/reset-password`, { token: tokens.alice })).status, 403);
      assert.equal((await api('POST', `/api/admin/users/${ids.admin}/reset-password`, { token: tokens.admin })).status, 409); // not for yourself
      assert.equal((await api('POST', '/api/admin/users/99999/reset-password', { token: tokens.admin })).status, 404);
      const reset = await api('POST', `/api/admin/users/${ids.forgot}/reset-password`, { token: tokens.admin });
      assert.equal(reset.status, 200, reset.text);
      assert.ok(reset.body.temporaryPassword.length >= 12);
      assert.ok(!JSON.stringify(reset.body.user).includes('scrypt'));
      assert.equal((await api('GET', '/api/auth/me', { token: oldToken })).status, 401); // their old sessions are gone
      assert.equal((await api('POST', '/api/auth/login', { body: { email: 'forgot@itc.test', password: PASSWORD } })).status, 401);
      assert.equal((await api('POST', '/api/auth/login', { body: { email: 'forgot@itc.test', password: reset.body.temporaryPassword } })).status, 200);
    });

    const draftFor = async (token, title) => {
      const created = await api('POST', '/api/me/articles', { token, body: { title, subtitle: 'x', categoryId: db.prepare(`SELECT id FROM categories WHERE slug = 'cloud'`).get().id, body: words(30) } });
      return created.body.article.id;
    };
    const submit = (token, id) => api('POST', `/api/me/articles/${id}/submit`, { token });
    const assign = (id, reviewer) => api('POST', `/api/admin/articles/${id}/assign`, { token: tokens.admin, body: { reviewerId: ids[reviewer] } });

    it('lets an author withdraw an article submitted by mistake', async () => {
      const id = await draftFor(tokens.bob, 'Submitted too early');
      assert.equal((await api('POST', `/api/me/articles/${id}/withdraw`, { token: tokens.bob })).status, 409); // not submitted yet
      await submit(tokens.bob, id);
      const a = await assign(id, 'rev1');
      assert.equal((await api('POST', `/api/me/articles/${id}/withdraw`, { token: tokens.alice })).status, 404); // not theirs
      const back = await api('POST', `/api/me/articles/${id}/withdraw`, { token: tokens.bob });
      assert.equal(back.status, 200, back.text);
      assert.equal(back.body.article.status, 'draft');
      // the reviewer lost the assignment and cannot answer it any more
      assert.equal((await api('POST', `/api/reviews/assignments/${a.body.assignment.id}/decision`, { token: tokens.rev1, body: { decision: 'approve' } })).status, 409);
      const queue = await api('GET', '/api/reviews/queue?status=returned', { token: tokens.rev1 });
      assert.equal(queue.body.items.find((i) => i.assignment.id === a.body.assignment.id).assignment.cancelledByAdmin, true);
      // it is editable again, and can be submitted a second time
      assert.equal((await api('PATCH', `/api/me/articles/${id}`, { token: tokens.bob, body: { subtitle: 'now it is ready' } })).status, 200);
      const again = await submit(tokens.bob, id);
      assert.equal(again.body.article.status, 'pending_review');
      assert.equal(again.body.article.revision, 2);
      const q = await api('GET', '/api/admin/queue', { token: tokens.admin });
      const entry = q.body.unassigned.find((u) => u.article.id === id);
      assert.equal(entry.lastReturn, null); // the old withdrawal must not be shown against the new submission
    });

    it('returns a withdrawn second-round article to "changes requested", keeping the feedback', async () => {
      const id = await draftFor(tokens.bob, 'Second round withdrawal');
      await submit(tokens.bob, id);
      const a = await assign(id, 'rev1');
      await api('POST', `/api/reviews/assignments/${a.body.assignment.id}/decision`, { token: tokens.rev1, body: { decision: 'request_changes', feedback: 'Please add the benchmark setup details.' } });
      await submit(tokens.bob, id);
      const back = await api('POST', `/api/me/articles/${id}/withdraw`, { token: tokens.bob });
      assert.equal(back.body.article.status, 'changes_requested');
      assert.equal(back.body.reviews.length, 1);
    });

    it('lets an admin take an assignment back from a reviewer who went quiet, then reassign', async () => {
      const id = await draftFor(tokens.bob, 'Stuck with a silent reviewer');
      await submit(tokens.bob, id);
      const a = await assign(id, 'rev1');
      assert.equal((await assign(id, 'rev2')).status, 409); // blocked while rev1 holds it
      const q1 = await api('GET', '/api/admin/queue', { token: tokens.admin });
      assert.equal(q1.body.inReview.find((r) => r.assignmentId === a.body.assignment.id).overdue, false);
      // make it overdue by moving the deadline into the past
      db.prepare(`UPDATE review_assignments SET due_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(a.body.assignment.id);
      const q2 = await api('GET', '/api/admin/queue', { token: tokens.admin });
      assert.equal(q2.body.inReview.find((r) => r.assignmentId === a.body.assignment.id).overdue, true);

      assert.equal((await api('POST', `/api/admin/assignments/${a.body.assignment.id}/cancel`, { token: tokens.rev1 })).status, 403);
      assert.equal((await api('POST', '/api/admin/assignments/99999/cancel', { token: tokens.admin })).status, 404);
      const cancelled = await api('POST', `/api/admin/assignments/${a.body.assignment.id}/cancel`, { token: tokens.admin, body: { reason: 'No response for a week' } });
      assert.equal(cancelled.status, 200, cancelled.text);
      assert.equal((await api('POST', `/api/admin/assignments/${a.body.assignment.id}/cancel`, { token: tokens.admin })).status, 409); // already closed

      const q3 = await api('GET', '/api/admin/queue', { token: tokens.admin });
      const entry = q3.body.unassigned.find((u) => u.article.id === id);
      assert.equal(entry.lastReturn.cancelled, true);
      assert.match(entry.lastReturn.reason, /No response for a week/);
      assert.equal((await api('POST', `/api/reviews/assignments/${a.body.assignment.id}/decision`, { token: tokens.rev1, body: { decision: 'approve' } })).status, 409);
      assert.equal((await assign(id, 'rev2')).status, 201); // now it can go to someone else
    });

    it('lets an admin take an article down, and only an admin can put it back', async () => {
      const art = await publishViaApi('bob', { title: 'Needs a correction', categoryId: db.prepare(`SELECT id FROM categories WHERE slug = 'cloud'`).get().id });
      await api('POST', `/api/admin/articles/${art.id}/feature`, { token: tokens.admin, body: { featured: true } });
      assert.equal((await api('POST', `/api/admin/articles/${art.id}/unpublish`, { token: tokens.bob })).status, 403);
      const off = await api('POST', `/api/admin/articles/${art.id}/unpublish`, { token: tokens.admin, body: { reason: 'Contains a licensing problem' } });
      assert.equal(off.status, 200, off.text);
      assert.equal(off.body.article.status, 'approved');
      assert.equal(off.body.article.featured, false);
      assert.equal(off.body.article.publishedAt, null);
      assert.equal(off.body.article.takenDown.reason, 'Contains a licensing problem');
      assert.equal((await api('GET', `/api/articles/${art.slug}`)).status, 404); // gone from the public site
      assert.equal((await api('POST', `/api/admin/articles/${art.id}/unpublish`, { token: tokens.admin })).status, 409);
      // the author is told why, and cannot undo it
      const own = await api('GET', `/api/me/articles/${art.id}`, { token: tokens.bob });
      assert.equal(own.body.article.takenDown.reason, 'Contains a licensing problem');
      const blocked = await api('POST', `/api/me/articles/${art.id}/publish`, { token: tokens.bob });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error.code, 'taken_down');
      assert.equal((await api('GET', `/api/articles/${art.slug}`)).status, 404);
      // only an admin can republish, which clears the takedown
      const back = await api('POST', `/api/admin/articles/${art.id}/publish`, { token: tokens.admin });
      assert.equal(back.body.article.status, 'published');
      assert.equal(back.body.article.takenDown, null);
      assert.equal((await api('GET', `/api/articles/${art.slug}`)).status, 200);
    });

    it('does not count withdrawn drafts in the acceptance rate', async () => {
      const stats = await api('GET', '/api/articles/stats');
      const submitted = db.prepare(`SELECT COUNT(*) AS n FROM articles WHERE revision >= 1 AND status != 'draft'`).get().n;
      const accepted = db.prepare(`SELECT COUNT(*) AS n FROM articles WHERE status IN ('approved', 'published')`).get().n;
      assert.equal(stats.body.acceptanceRate, Math.round((accepted * 100) / submitted));
    });

    it('makes a restorable backup of the database and the images', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'itc-backup-'));
      const { createBackup } = await import('../src/backup-lib.js');
      const result = createBackup(db, { uploadsDir: ctx.uploadsDir, backupDir: dir });
      const { DatabaseSync } = await import('node:sqlite');
      const copy = new DatabaseSync(result.dbFile);
      const count = (d, table) => d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      assert.equal(count(copy, 'users'), count(db, 'users'));
      assert.equal(count(copy, 'articles'), count(db, 'articles'));
      assert.equal(copy.prepare('PRAGMA user_version').get().user_version, db.prepare('PRAGMA user_version').get().user_version);
      copy.close();
      assert.equal(result.hasUploads, true);
      assert.ok(existsSync(join(result.dir, 'uploads')));
      // two backups in a row must not collide
      assert.notEqual(createBackup(db, { uploadsDir: ctx.uploadsDir, backupDir: dir }).dir, result.dir);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('boss review findings', () => {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const catId = () => db.prepare(`SELECT id FROM categories WHERE slug = 'cloud'`).get().id;
    const draftFor = async (token, title) => (await api('POST', '/api/me/articles', { token, body: { title, subtitle: 'x', categoryId: catId(), body: words(30) } })).body.article.id;
    const submit = (token, id) => api('POST', `/api/me/articles/${id}/submit`, { token });
    const assign = (id, key) => api('POST', `/api/admin/articles/${id}/assign`, { token: tokens.admin, body: { reviewerId: ids[key] } });
    const promote = (key, role = 'reviewer') => api('PATCH', `/api/admin/users/${ids[key]}`, { token: tokens.admin, body: { role } });
    const decide = (key, assignmentId, body) => api('POST', `/api/reviews/assignments/${assignmentId}/decision`, { token: tokens[key], body });

    before(async () => {
      await register('rev3', 'Hidden Reviewer');
      await register('rev4', 'Second Hidden Reviewer');
      await register('rev5', 'Demoted Reviewer');
      await register('drafty', 'Only Drafts Person');
      for (const key of ['rev3', 'rev4', 'rev5']) assert.equal((await promote(key)).status, 200);
    });

    // ---- 1. secrets in .env.example ----
    describe('1. secret key', () => {
      it('ships a placeholder (never a real key) in .env.example', async () => {
        const { exampleFileLooksLeaked, secretInExampleFile } = await import('../src/config.js');
        assert.match(secretInExampleFile(), /^change-me/);
        assert.equal(exampleFileLooksLeaked(), false);
      });

      it('recognises an example file that contains a real-looking secret', async () => {
        const { exampleFileLooksLeaked } = await import('../src/config.js');
        const dir = mkdtempSync(join(tmpdir(), 'itc-env-'));
        const { writeFileSync } = await import('node:fs');
        writeFileSync(join(dir, 'leaked'), `PORT=3000\nJWT_SECRET=${'ae1021ce'.repeat(8)}\n`);
        writeFileSync(join(dir, 'fine'), 'PORT=3000\nJWT_SECRET=change-me-to-a-long-random-string\n');
        assert.equal(exampleFileLooksLeaked(join(dir, 'leaked')), true);
        assert.equal(exampleFileLooksLeaked(join(dir, 'fine')), false);
        assert.equal(exampleFileLooksLeaked(join(dir, 'missing-file')), false);
        rmSync(dir, { recursive: true, force: true });
      });

      it('refuses, in production, weak secrets and any secret that is written in the public example file', async () => {
        const { assertStrongSecret } = await import('../src/config.js');
        const dir = mkdtempSync(join(tmpdir(), 'itc-env-'));
        const { writeFileSync } = await import('node:fs');
        const leaked = 'f3a9'.repeat(16);
        writeFileSync(join(dir, 'example'), `JWT_SECRET=${leaked}\n`);
        const examplePath = join(dir, 'example');
        assert.throws(() => assertStrongSecret('short', { examplePath }), /too weak/);
        assert.throws(() => assertStrongSecret('change-me-to-a-long-random-string-xxxxxxxx', { examplePath }), /too weak/);
        assert.throws(() => assertStrongSecret('dev-only-secret-do-not-use-in-production-xx', { examplePath }), /too weak/);
        assert.throws(() => assertStrongSecret(leaked, { examplePath }), /written in \.env\.example/); // strong-looking, but public
        assert.doesNotThrow(() => assertStrongSecret('7c1e'.repeat(16), { examplePath }));
        rmSync(dir, { recursive: true, force: true });
      });

      it('keeps review signatures valid when JWT_SECRET is rotated, if REVIEW_SIGNING_KEY is set', async () => {
        const { loadConfig } = await import('../src/config.js');
        const before = { JWT_SECRET: process.env.JWT_SECRET, KEY: process.env.REVIEW_SIGNING_KEY };
        try {
          process.env.JWT_SECRET = 'first-secret-first-secret-first-secret-00';
          delete process.env.REVIEW_SIGNING_KEY;
          assert.equal(loadConfig().reviewSigningKey, 'first-secret-first-secret-first-secret-00:reviews');
          process.env.JWT_SECRET = 'rotated-secret-rotated-secret-rotated-secret-1';
          process.env.REVIEW_SIGNING_KEY = 'first-secret-first-secret-first-secret-00:reviews';
          assert.equal(loadConfig().reviewSigningKey, 'first-secret-first-secret-first-secret-00:reviews');
        } finally {
          for (const [name, value] of [['JWT_SECRET', before.JWT_SECRET], ['REVIEW_SIGNING_KEY', before.KEY]]) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
          }
        }
      });

      it('never runs with a publicly known secret, even in development: it creates a private random one and keeps it', async () => {
        const { loadConfig, secretInExampleFile } = await import('../src/config.js');
        const dir = mkdtempSync(join(tmpdir(), 'itc-secret-'));
        const saved = { ...process.env };
        try {
          process.env.DB_PATH = join(dir, 'x.db');
          delete process.env.NODE_ENV;
          const published = ['dev-only-secret-do-not-use-in-production', secretInExampleFile(), 'change-me-to-a-long-random-string', 'too-short', undefined];
          const first = (() => { delete process.env.JWT_SECRET; return loadConfig().jwtSecret; })();
          assert.match(first, /^[0-9a-f]{96}$/);
          assert.ok(existsSync(join(dir, '.jwt-secret')));
          for (const value of published) {
            if (value === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = value;
            assert.equal(loadConfig().jwtSecret, first, `"${value}" must be replaced by the private secret`); // and it is the same one every start
          }
          process.env.JWT_SECRET = 'a-real-secret-that-someone-chose-0123456789abcdef';
          assert.equal(loadConfig().jwtSecret, 'a-real-secret-that-someone-chose-0123456789abcdef'); // a real one is respected
        } finally {
          process.env = saved;
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('rejects admin tokens forged with any value that is written in the code or in .env.example', async () => {
        const { loadConfig, secretInExampleFile } = await import('../src/config.js');
        const { default: jwt } = await import('jsonwebtoken');
        const dir = mkdtempSync(join(tmpdir(), 'itc-secret-'));
        const saved = { ...process.env };
        let server;
        try {
          process.env.DB_PATH = join(dir, 'x.db');
          delete process.env.NODE_ENV;
          delete process.env.JWT_SECRET; // the default way people start the server
          const config = loadConfig({ logRequests: false, uploadsDir: join(dir, 'up'), registerLimit: { windowMs: 60000, max: 100 } });
          const local = openDb(':memory:');
          const app = createApp({ db: local, config });
          server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
          const base = `http://127.0.0.1:${server.address().port}`;
          const reg = await (await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Real Admin', email: 'real@itc.test', password: PASSWORD }) })).json();
          local.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(reg.user.id);
          const call = (token) => fetch(`${base}/api/admin/users`, { headers: { authorization: `Bearer ${token}` } });
          for (const known of ['dev-only-secret-do-not-use-in-production', secretInExampleFile(), 'change-me-to-a-long-random-string', 'secret']) {
            const forged = jwt.sign({ role: 'admin' }, known, { subject: String(reg.user.id), expiresIn: '1h', algorithm: 'HS256' });
            assert.equal((await call(forged)).status, 401, `forged with "${known}"`);
          }
          assert.equal((await call(reg.token)).status, 200); // the genuine token still works
        } finally {
          process.env = saved;
          if (server) await new Promise((r) => server.close(r));
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });

    // ---- 2. reviewer identity ----
    describe('2. reviewer identity stays hidden from authors', () => {
      it('uses random reviewer codes that are not derived from the user id', async () => {
        const codes = [];
        for (const key of ['rev3', 'rev4']) {
          const me = await api('GET', '/api/auth/me', { token: tokens[key] });
          codes.push(me.body.user.reviewerCode);
          assert.match(me.body.user.reviewerCode, /^WK-BLIDA-[A-Z2-9]{4,8}$/);
          assert.notEqual(me.body.user.reviewerCode, `WK-BLIDA-${String(ids[key]).padStart(2, '0')}`); // the old, guessable formula
          assert.equal((await api('GET', '/api/auth/me', { token: tokens[key] })).body.user.reviewerCode, me.body.user.reviewerCode); // stable
        }
        assert.notEqual(codes[0], codes[1]);
        const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
        assert.equal(db.prepare('SELECT COUNT(DISTINCT public_code) AS n FROM users').get().n, total); // every user has a unique code
      });

      it('does not let an author turn a reviewer code into a name', async () => {
        const id = await draftFor(tokens.drafty, 'Reviewed article for identity test');
        await submit(tokens.drafty, id);
        const a = await assign(id, 'rev3');
        await decide('rev3', a.body.assignment.id, { decision: 'request_changes', feedback: 'Please explain the setup in more detail.' });
        const own = await api('GET', `/api/me/articles/${id}`, { token: tokens.drafty });
        const code = own.body.reviews[0].reviewerCode;
        const reviewerCodeOfRev3 = (await api('GET', '/api/auth/me', { token: tokens.rev3 })).body.user.reviewerCode;
        assert.equal(code, reviewerCodeOfRev3);
        assert.ok(!own.text.includes('Hidden Reviewer'));
        // trying the reviewer's user id on the public profile endpoint finds nothing
        assert.equal((await api('GET', `/api/authors/${ids.rev3}`)).status, 404);
      });

      it('gives public profiles only to people with published articles', async () => {
        assert.equal((await api('GET', `/api/authors/${ids.drafty}`)).status, 404); // only drafts
        assert.equal((await api('GET', `/api/authors/${ids.admin}`)).status, 404); // admin
        assert.equal((await api('GET', `/api/authors/${ids.bob}`)).status, 200); // has published work
      });
    });

    // ---- 3. reviewers and closed assignments ----
    describe('3. reviewers lose access to the manuscript when the assignment closes', () => {
      it('shows the text while the assignment is active, and hides it afterwards', async () => {
        const id = await draftFor(tokens.drafty, 'Private draft that changes later');
        await submit(tokens.drafty, id);
        const a = await assign(id, 'rev4');
        const active = await api('GET', `/api/reviews/assignments/${a.body.assignment.id}`, { token: tokens.rev4 });
        assert.ok(active.body.article.body.includes('word1')); // the reviewer can read it now
        assert.equal(active.body.myReview, null);

        await decide('rev4', a.body.assignment.id, { decision: 'request_changes', feedback: 'Needs a clearer introduction section.' });
        await api('PATCH', `/api/me/articles/${id}`, { token: tokens.drafty, body: { body: `SECRET-NEW-PRIVATE-TEXT ${words(30)}` } });

        const closed = await api('GET', `/api/reviews/assignments/${a.body.assignment.id}`, { token: tokens.rev4 });
        assert.equal(closed.status, 200);
        assert.equal(closed.body.article.bodyHidden, true);
        assert.ok(!('body' in closed.body.article) && !('sections' in closed.body.article));
        assert.ok(!closed.text.includes('SECRET-NEW-PRIVATE-TEXT'));
        assert.deepEqual(closed.body.previousReviews, []);
        assert.equal(closed.body.myReview.decision, 'changes_requested'); // their own record stays
        assert.match(closed.body.myReview.feedback, /introduction/);
        assert.equal(closed.body.assignment.status, 'completed');
      });

      it('also hides the text on returned and cancelled assignments', async () => {
        const id = await draftFor(tokens.drafty, 'Returned and cancelled manuscripts');
        await submit(tokens.drafty, id);
        const first = await assign(id, 'rev4');
        await api('POST', `/api/reviews/assignments/${first.body.assignment.id}/return`, { token: tokens.rev4, body: { reason: 'This is outside what I know.' } });
        const returned = await api('GET', `/api/reviews/assignments/${first.body.assignment.id}`, { token: tokens.rev4 });
        assert.equal(returned.body.article.bodyHidden, true);

        const second = await assign(id, 'rev3');
        await api('POST', `/api/admin/assignments/${second.body.assignment.id}/cancel`, { token: tokens.admin });
        const cancelled = await api('GET', `/api/reviews/assignments/${second.body.assignment.id}`, { token: tokens.rev3 });
        assert.equal(cancelled.body.article.bodyHidden, true);
        assert.ok(!('body' in cancelled.body.article));
      });
    });

    // ---- 4. demoting a reviewer ----
    describe('4. demoting a reviewer', () => {
      it('takes back their open assignments so the articles reappear in the admin queue', async () => {
        const id = await draftFor(tokens.bob, 'Held by someone who gets demoted');
        await submit(tokens.bob, id);
        const a = await assign(id, 'rev5');
        assert.equal((await api('GET', '/api/reviews/queue', { token: tokens.rev5 })).body.items.length, 1);

        assert.equal((await promote('rev5', 'author')).status, 200);

        const queue = await api('GET', '/api/admin/queue', { token: tokens.admin });
        const entry = queue.body.unassigned.find((u) => u.article.id === id);
        assert.ok(entry, 'the article must be back in the unassigned list');
        assert.equal(entry.lastReturn.cancelled, true);
        assert.match(entry.lastReturn.reason, /role was removed/);
        assert.ok(!queue.body.inReview.some((r) => r.assignmentId === a.body.assignment.id));
        assert.equal((await api('GET', '/api/reviews/queue', { token: tokens.rev5 })).status, 403);
        assert.equal((await assign(id, 'rev3')).status, 201); // and it can be given to someone else straight away
      });

      it('keeps assignments when a reviewer becomes an admin (they can still review)', async () => {
        await promote('rev5', 'reviewer');
        const id = await draftFor(tokens.bob, 'Held by a reviewer who becomes admin');
        await submit(tokens.bob, id);
        const a = await assign(id, 'rev5');
        await promote('rev5', 'admin');
        const q = await api('GET', '/api/reviews/queue', { token: tokens.rev5 });
        assert.equal(q.body.items.length, 1);
        assert.equal(q.body.items[0].assignment.id, a.body.assignment.id);
        await promote('rev5', 'reviewer');
      });

      it('does not touch assignments when only the title changes', async () => {
        const id = await draftFor(tokens.bob, 'Title change must not cancel reviews');
        await submit(tokens.bob, id);
        await assign(id, 'rev5');
        await api('PATCH', `/api/admin/users/${ids.rev5}`, { token: tokens.admin, body: { title: 'Senior Reviewer' } });
        assert.equal((await api('GET', '/api/reviews/queue', { token: tokens.rev5 })).body.items.length, 2);
      });
    });

    // ---- 5. takedown stays down: covered in 'lets an admin take an article down...' above; extra cases here ----
    describe('5. taking an article down', () => {
      it('works without a reason, and the takedown clears when an admin republishes', async () => {
        const art = await publishViaApi('bob', { title: 'Taken down without a reason', categoryId: catId() });
        const off = await api('POST', `/api/admin/articles/${art.id}/unpublish`, { token: tokens.admin });
        assert.equal(off.status, 200);
        assert.deepEqual({ ...off.body.article.takenDown, at: 'x' }, { at: 'x', reason: '' });
        assert.equal((await api('POST', `/api/admin/articles/${art.id}/publish`, { token: tokens.admin })).body.article.takenDown, null);
      });

      it('lets an author publish a normal approved article as before', async () => {
        const id = await draftFor(tokens.bob, 'Normal approved article');
        await submit(tokens.bob, id);
        const a = await assign(id, 'rev3');
        await decide('rev3', a.body.assignment.id, { decision: 'approve' });
        assert.equal((await api('POST', `/api/me/articles/${id}/publish`, { token: tokens.bob })).status, 200);
      });
    });

    // ---- 6. disk space ----
    describe('6. storage limits', () => {
      const send = (base, token, bytes) => fetch(`${base}/api/me/uploads`, { method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${token}` }, body: bytes });
      const signUp = async (app, n) => (await app.api('POST', '/api/auth/register', { body: { name: `Uploader ${n}`, email: `up${n}@itc.test`, password: PASSWORD } })).body;

      it('caps the total size per account, and frees space when images are deleted', async () => {
        const app = await startApp({ maxUploadBytesPerUser: PNG.length * 3 + 1 });
        const { token } = await signUp(app, 1);
        const ids3 = [];
        for (let i = 0; i < 3; i++) {
          const r = await send(app.base, token, PNG);
          assert.equal(r.status, 201);
          ids3.push((await r.json()).upload.id);
        }
        const over = await send(app.base, token, PNG);
        assert.equal(over.status, 409);
        assert.equal((await over.json()).error.code, 'storage_limit');
        assert.equal((await app.api('DELETE', `/api/me/uploads/${ids3[0]}`, { token })).status, 204);
        assert.equal((await send(app.base, token, PNG)).status, 201); // room again
        await app.close();
      });

      it('caps the whole site, whoever is uploading', async () => {
        const app = await startApp({ maxUploadBytesTotal: PNG.length * 2 + 1 });
        const a = await signUp(app, 1);
        const b = await signUp(app, 2);
        assert.equal((await send(app.base, a.token, PNG)).status, 201);
        assert.equal((await send(app.base, b.token, PNG)).status, 201);
        const full = await send(app.base, a.token, PNG);
        assert.equal(full.status, 507);
        assert.equal((await full.json()).error.code, 'storage_full');
        await app.close();
      });

      it('has sensible defaults: 50 images and 50 MB per account, 2 GB for the site', async () => {
        const { loadConfig } = await import('../src/config.js');
        const c = loadConfig();
        assert.equal(c.maxUploadsPerUser, 50);
        assert.equal(c.maxUploadBytesPerUser, 50 * 1024 * 1024);
        assert.equal(c.maxUploadBytesTotal, 2048 * 1024 * 1024);
      });
    });

    // ---- 7. PDF load ----
    describe('7. PDF generation under load', () => {
      const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

      it('shares one generation between simultaneous requests and then serves from the cache', async () => {
        const { createPdfService } = await import('../src/pdf-service.js');
        let calls = 0;
        const gate = deferred();
        const service = createPdfService({ generate: async () => { calls += 1; await gate.promise; return Buffer.alloc(500, 1); }, maxConcurrent: 2, maxQueue: 5, maxCacheBytes: 10_000 });
        const requests = Array.from({ length: 10 }, () => service.get('same-article', {}, {}));
        gate.resolve();
        const results = await Promise.all(requests);
        assert.equal(calls, 1);
        assert.ok(results.every((r) => r.length === 500));
        await service.get('same-article', {}, {});
        assert.equal(calls, 1); // cached
      });

      it('limits the cache by total bytes, dropping the least recently used first', async () => {
        const { createPdfService } = await import('../src/pdf-service.js');
        let calls = 0;
        const service = createPdfService({ generate: async () => { calls += 1; return Buffer.alloc(1000, 2); }, maxConcurrent: 2, maxQueue: 5, maxCacheBytes: 2500 });
        await service.get('a', {}, {});
        await service.get('b', {}, {});
        await service.get('a', {}, {}); // touch a, so b is now the oldest
        await service.get('c', {}, {}); // 3000 bytes > 2500: b is dropped
        assert.equal(calls, 3);
        assert.ok(service.stats().cachedBytes <= 2500);
        await service.get('a', {}, {});
        await service.get('c', {}, {});
        assert.equal(calls, 3); // a and c are still cached
        await service.get('b', {}, {});
        assert.equal(calls, 4); // b had to be built again
      });

      it('does not cache a single file that is bigger than the whole cache', async () => {
        const { createPdfService } = await import('../src/pdf-service.js');
        let calls = 0;
        const service = createPdfService({ generate: async () => { calls += 1; return Buffer.alloc(5000, 3); }, maxConcurrent: 1, maxQueue: 1, maxCacheBytes: 2000 });
        await service.get('huge', {}, {});
        await service.get('huge', {}, {});
        assert.equal(calls, 2);
        assert.equal(service.stats().cachedBytes, 0);
      });

      it('runs only a few at once, queues a few more, and says "busy" to the rest', async () => {
        const { createPdfService } = await import('../src/pdf-service.js');
        const gates = {};
        const service = createPdfService({
          generate: (article) => { gates[article.k] = deferred(); return gates[article.k].promise; },
          maxConcurrent: 1, maxQueue: 1, maxCacheBytes: 10_000,
        });
        const first = service.get('k1', { k: 'k1' }, {});
        const second = service.get('k2', { k: 'k2' }, {});
        await new Promise((r) => setImmediate(r));
        assert.deepEqual([service.stats().running, service.stats().waiting], [1, 1]);
        await assert.rejects(() => service.get('k3', { k: 'k3' }, {}), (err) => err.status === 503 && err.code === 'busy');
        gates.k1.resolve(Buffer.alloc(10));
        await first;
        await new Promise((r) => setImmediate(r));
        assert.ok(gates.k2, 'the queued job starts when a slot frees up');
        gates.k2.resolve(Buffer.alloc(10));
        await second;
        assert.deepEqual([service.stats().running, service.stats().waiting], [0, 0]);
      });

      it('forgets a failed generation so the next request can try again', async () => {
        const { createPdfService } = await import('../src/pdf-service.js');
        let calls = 0;
        const service = createPdfService({ generate: async () => { calls += 1; if (calls === 1) throw new Error('boom'); return Buffer.alloc(10); }, maxConcurrent: 1, maxQueue: 1, maxCacheBytes: 1000 });
        await assert.rejects(() => service.get('x', {}, {}), /boom/);
        assert.equal((await service.get('x', {}, {})).length, 10);
        assert.deepEqual([service.stats().running, service.stats().waiting], [0, 0]);
      });

      it('builds each PDF once even when many visitors download it together (through the real API)', async () => {
        let calls = 0;
        ctx.config.pdfGenerate = async () => { calls += 1; await new Promise((r) => setTimeout(r, 50)); return Buffer.from('%PDF-fake-for-test%%EOF'); };
        try {
          const art = await publishViaApi('bob', { title: 'Many readers want this PDF', categoryId: catId() });
          const downloads = await Promise.all(Array.from({ length: 8 }, () => api('GET', `/api/articles/${art.slug}/download`)));
          assert.ok(downloads.every((d) => d.status === 200));
          assert.equal(calls, 1);
        } finally {
          ctx.config.pdfGenerate = null;
        }
      });

      it('answers 503 instead of piling up work when the PDF queue is full (through the real API)', async () => {
        const app = await startApp({ pdfMaxConcurrent: 1, pdfMaxQueue: 0 });
        const gate = deferred();
        app.config.pdfGenerate = () => gate.promise;
        const user = (await app.api('POST', '/api/auth/register', { body: { name: 'Pdf Author', email: 'pdf@itc.test', password: PASSWORD } })).body;
        const insert = (slug) => app.db.prepare(`INSERT INTO articles (slug, author_id, title, status, published_at, created_at, updated_at, ref_code) VALUES (?, ?, ?, 'published', ?, ?, ?, ?)`)
          .run(slug, user.user.id, slug, new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), slug.toUpperCase());
        insert('first-pdf');
        insert('second-pdf');
        const running = app.api('GET', '/api/articles/first-pdf/download');
        await new Promise((r) => setTimeout(r, 100));
        const busy = await app.api('GET', '/api/articles/second-pdf/download');
        assert.equal(busy.status, 503);
        assert.equal(busy.body.error.code, 'busy');
        gate.resolve(Buffer.from('%PDF-ok%%EOF'));
        assert.equal((await running).status, 200);
        await app.close();
      });
    });

    // ---- 8. signatures ----
    describe('8. review signatures are checked', () => {
      it('verifies every stored review, and only admins can ask', async () => {
        assert.equal((await api('GET', '/api/admin/reviews/verify', { token: tokens.alice })).status, 403);
        assert.equal((await api('GET', '/api/admin/reviews/verify')).status, 401);
        const r = await api('GET', '/api/admin/reviews/verify', { token: tokens.admin });
        assert.equal(r.status, 200, r.text);
        assert.ok(r.body.checked > 5);
        assert.equal(r.body.valid, r.body.checked);
        assert.deepEqual(r.body.invalid, []);
      });

      it('detects a review that was changed after it was written', async () => {
        const target = db.prepare(`SELECT id, article_id, feedback, decision FROM reviews WHERE feedback != '' ORDER BY id LIMIT 1`).get();
        db.prepare('UPDATE reviews SET feedback = ? WHERE id = ?').run('Quietly rewritten feedback', target.id);
        const all = await api('GET', '/api/admin/reviews/verify', { token: tokens.admin });
        assert.equal(all.body.invalid.length, 1);
        assert.equal(all.body.invalid[0].reviewId, target.id);
        assert.equal(all.body.valid, all.body.checked - 1);
        const scoped = await api('GET', `/api/admin/reviews/verify?articleId=${target.article_id}`, { token: tokens.admin });
        assert.equal(scoped.body.invalid.length, 1);
        const other = await api('GET', `/api/admin/reviews/verify?articleId=${published_other_article_id()}`, { token: tokens.admin });
        assert.equal(other.body.invalid.length, 0);
        db.prepare('UPDATE reviews SET feedback = ? WHERE id = ?').run(target.feedback, target.id); // put it back
        assert.equal((await api('GET', '/api/admin/reviews/verify', { token: tokens.admin })).body.invalid.length, 0);
        assert.equal((await api('GET', '/api/admin/reviews/verify?articleId=abc', { token: tokens.admin })).status, 400);

        function published_other_article_id() {
          return db.prepare('SELECT article_id FROM reviews WHERE article_id != ? LIMIT 1').get(target.article_id).article_id;
        }
      });

      it('flags reviews signed with a different key (for example after a secret rotation without REVIEW_SIGNING_KEY)', async () => {
        const { reviewSignatureIsValid } = await import('../src/auth.js');
        const row = db.prepare('SELECT * FROM reviews ORDER BY id LIMIT 1').get();
        assert.equal(reviewSignatureIsValid(ctx.config, row), true);
        assert.equal(reviewSignatureIsValid({ ...ctx.config, reviewSigningKey: 'some-other-key' }, row), false);
        assert.equal(reviewSignatureIsValid(ctx.config, { ...row, signature: 'not-hex-at-all' }), false);
      });
    });

    // ---- 9. login lockouts survive restarts ----
    describe('9. login lockouts are stored in the database', () => {
      it('keeps counting across a restart and across server processes that share the database', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'itc-lock-'));
        const file = join(dir, 'lock.db');
        const limits = { loginLimits: { windowMs: 60_000, perAccountAndIp: 3, perAccount: 40, perIp: 150 } };
        const boot = (database) => new Promise((resolve) => {
          const cfg = loadConfig({ nodeEnv: 'test', jwtSecret: 'test-secret', logRequests: false, uploadsDir: dir, registerLimit: { windowMs: 60_000, max: 1000 }, ...limits });
          const server = createApp({ db: database, config: cfg }).listen(0, '127.0.0.1', () => {
            const base = `http://127.0.0.1:${server.address().port}`;
            resolve({ base, stop: () => new Promise((r) => server.close(r)),
              login: async (email, password) => (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).status });
          });
        });
        const db1 = openDb(file);
        const one = await boot(db1);
        await fetch(`${one.base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Locked Out', email: 'lock@itc.test', password: PASSWORD }) });
        for (let i = 0; i < 3; i++) assert.equal(await one.login('lock@itc.test', `wrong-${i}`), 401);
        assert.equal(await one.login('lock@itc.test', PASSWORD), 429);

        // a second server process using the same database sees the same lockout
        const db2 = openDb(file);
        const two = await boot(db2);
        assert.equal(await two.login('lock@itc.test', PASSWORD), 429);

        // and so does a restart
        await one.stop(); await two.stop(); db1.close(); db2.close();
        const db3 = openDb(file);
        const restarted = await boot(db3);
        assert.equal(await restarted.login('lock@itc.test', PASSWORD), 429);
        await restarted.stop(); db3.close();
        rmSync(dir, { recursive: true, force: true });
      });
    });

    // ---- 10. read counts ----
    describe('10. read counts', () => {
      it('does not count a reader twice for changing the browser name', async () => {
        const art = await publishViaApi('bob', { title: 'Read count inflation test', categoryId: catId() });
        let reads = 0;
        for (const ua of ['Chrome', 'Firefox', 'Safari', 'curl/8', 'spoofed-1', 'spoofed-2']) {
          reads = (await api('GET', `/api/articles/${art.slug}`, { headers: { 'user-agent': ua } })).body.article.reads;
        }
        assert.equal(reads, 1);
      });

      it('stores anonymous readers as a keyed hash, never the address itself', async () => {
        const rows = db.prepare(`SELECT viewer_hash FROM article_views WHERE viewer_hash LIKE 'anon:%'`).all();
        assert.ok(rows.length > 0);
        assert.ok(rows.every((r) => !r.viewer_hash.includes('127.0.0.1') && /^anon:[0-9a-f]{32}$/.test(r.viewer_hash)));
      });

      it('limits how many new anonymous readers one address can add per hour', async () => {
        const app = await startApp({ anonViewsPerIpPerHour: 2 });
        const user = (await app.api('POST', '/api/auth/register', { body: { name: 'Viewer Author', email: 'views@itc.test', password: PASSWORD } })).body;
        const now = new Date().toISOString();
        for (const slug of ['view-a', 'view-b', 'view-c']) {
          app.db.prepare(`INSERT INTO articles (slug, author_id, title, status, published_at, created_at, updated_at) VALUES (?, ?, ?, 'published', ?, ?, ?)`).run(slug, user.user.id, slug, now, now, now);
        }
        const reads = async (slug) => (await app.api('GET', `/api/articles/${slug}`)).body.article.reads;
        assert.equal(await reads('view-a'), 1);
        assert.equal(await reads('view-b'), 1);
        assert.equal(await reads('view-c'), 0); // third NEW reader from this address within the hour is not counted
        assert.equal(await reads('view-a'), 1); // known readers are unaffected
        // signed-in readers are not subject to the anonymous limit
        const reader = (await app.api('POST', '/api/auth/register', { body: { name: 'Signed In Reader', email: 'sir@itc.test', password: PASSWORD } })).body;
        assert.equal((await app.api('GET', '/api/articles/view-c', { token: reader.token })).body.article.reads, 1);
        await app.close();
      });
    });

    // ---- the database upgrade for existing installs ----
    describe('upgrading an existing database', () => {
      it('gives every existing user a unique random code and keeps their data', async () => {
        // build a database the way version 5 left it, then open it with the new code
        const { DatabaseSync } = await import('node:sqlite');
        const dir = mkdtempSync(join(tmpdir(), 'itc-upgrade-'));
        const file = join(dir, 'old.db');
        const fresh = openDb(file);
        fresh.exec('PRAGMA foreign_keys = OFF');
        fresh.exec('DROP TABLE rate_counters');
        fresh.exec('DROP INDEX ux_users_public_code');
        fresh.exec('ALTER TABLE users DROP COLUMN public_code');
        fresh.exec('ALTER TABLE articles DROP COLUMN held_at');
        fresh.exec('ALTER TABLE articles DROP COLUMN hold_reason');
        fresh.exec('PRAGMA user_version = 5');
        for (const n of [1, 2, 3]) fresh.prepare(`INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, 'x', ?)`).run(`Old User ${n}`, `old${n}@itc.test`, new Date().toISOString());
        fresh.close();

        const upgraded = openDb(file);
        assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 6);
        const users = upgraded.prepare('SELECT name, public_code FROM users ORDER BY id').all();
        assert.equal(users.length, 3);
        assert.ok(users.every((u) => /^WK-BLIDA-[A-Z2-9]{4,8}$/.test(u.public_code)));
        assert.equal(new Set(users.map((u) => u.public_code)).size, 3);
        upgraded.close();
        void DatabaseSync;
        rmSync(dir, { recursive: true, force: true });
      });
    });
  });

  it('never leaks internals on server errors', async () => {
    const broken = await startApp();
    broken.db.close(); // simulate the database dying
    const r = await broken.api('GET', '/api/categories');
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, 'internal_error');
    assert.ok(!r.text.includes('sqlite') && !r.text.includes('node:'));
    await broken.close();
  });
});
