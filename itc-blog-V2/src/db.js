import { DatabaseSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Version 1 of the schema. Future changes go in a new entry of MIGRATIONS (never edit old ones).
// Public reviewer codes (e.g. WK-BLIDA-7K2P) are random: they must NOT reveal the reviewer's user id.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alike characters (0/O, 1/I/L)
export function newPublicCode(db) {
  for (let length = 4; length <= 8; length++) {
    for (let attempt = 0; attempt < 25; attempt++) {
      let suffix = '';
      for (let i = 0; i < length; i++) suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      const code = `WK-BLIDA-${suffix}`;
      if (!db.prepare('SELECT 1 FROM users WHERE public_code = ?').get(code)) return code;
    }
  }
  throw new Error('Could not generate a unique public code');
}

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'author' CHECK (role IN ('author', 'reviewer', 'admin')),
    title         TEXT NOT NULL DEFAULT '',
    bio           TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
  );

  CREATE TABLE categories (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE
  );

  CREATE TABLE articles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slug         TEXT NOT NULL UNIQUE,
    ref_code     TEXT NOT NULL DEFAULT '',
    author_id    INTEGER NOT NULL REFERENCES users(id),
    category_id  INTEGER REFERENCES categories(id),
    kind         TEXT NOT NULL DEFAULT 'article',
    title        TEXT NOT NULL,
    subtitle     TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL DEFAULT '',
    tags         TEXT NOT NULL DEFAULT '[]',
    status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'pending_review', 'changes_requested', 'approved', 'published')),
    is_featured  INTEGER NOT NULL DEFAULT 0,
    word_count   INTEGER NOT NULL DEFAULT 0,
    code_blocks  INTEGER NOT NULL DEFAULT 0,
    read_minutes INTEGER NOT NULL DEFAULT 1,
    revision     INTEGER NOT NULL DEFAULT 0,
    submitted_at TEXT,
    published_at TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX idx_articles_status_published ON articles(status, published_at);
  CREATE INDEX idx_articles_author ON articles(author_id);
  CREATE INDEX idx_articles_category ON articles(category_id);

  CREATE TABLE review_assignments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id          INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    reviewer_id         INTEGER NOT NULL REFERENCES users(id),
    assigned_by         INTEGER NOT NULL REFERENCES users(id),
    revision            INTEGER NOT NULL,
    submitted_at        TEXT NOT NULL,
    priority            TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
    status              TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'completed', 'returned')),
    assigned_at         TEXT NOT NULL,
    due_at              TEXT NOT NULL,
    completed_at        TEXT,
    returned_at         TEXT,
    return_reason       TEXT,
    suggested_expertise TEXT
  );
  CREATE INDEX idx_assignments_reviewer ON review_assignments(reviewer_id, status);
  CREATE INDEX idx_assignments_article ON review_assignments(article_id);
  -- An article can only have ONE active assignment at a time.
  CREATE UNIQUE INDEX ux_active_assignment ON review_assignments(article_id) WHERE status = 'assigned';

  CREATE TABLE reviews (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL UNIQUE REFERENCES review_assignments(id) ON DELETE CASCADE,
    article_id    INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    reviewer_id   INTEGER NOT NULL REFERENCES users(id),
    revision      INTEGER NOT NULL,
    decision      TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
    feedback      TEXT NOT NULL DEFAULT '',
    signature     TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX idx_reviews_article ON reviews(article_id);

  CREATE TABLE article_views (
    article_id      INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    viewer_hash     TEXT NOT NULL,
    first_viewed_at TEXT NOT NULL,
    PRIMARY KEY (article_id, viewer_hash)
  );

  -- The topics used in the design. Admins can add more through the API.
  INSERT INTO categories (name, slug) VALUES
    ('Software Engineering', 'software-engineering'),
    ('DevOps', 'devops'),
    ('Cybersecurity', 'cybersecurity'),
    ('AI & NLP', 'ai-nlp'),
    ('Databases', 'databases'),
    ('Web Development', 'web-development'),
    ('Cloud', 'cloud');
  `,
  // 2: the design also uses a Networking topic (see "Related engineering dispatches").
  `INSERT OR IGNORE INTO categories (name, slug) VALUES ('Networking', 'networking');`,
  // 3: image uploads, a cover figure with caption on articles, and unique reference codes.
  `
  CREATE TABLE uploads (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL REFERENCES users(id),
    filename   TEXT NOT NULL UNIQUE,
    mime       TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_uploads_owner ON uploads(owner_id);
  ALTER TABLE articles ADD COLUMN cover_upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL;
  ALTER TABLE articles ADD COLUMN cover_caption TEXT NOT NULL DEFAULT '';
  CREATE UNIQUE INDEX ux_articles_ref_code ON articles(ref_code) WHERE ref_code != '';
  `,
  // 4: "target node" shown in the editor (our reading: the ITC chapter / channel the article is published to).
  `
  ALTER TABLE articles ADD COLUMN target_node TEXT NOT NULL DEFAULT 'ITC-BLIDA-MAIN';
  CREATE INDEX idx_articles_node ON articles(target_node);
  `,
  // 5: password changes invalidate older sessions; admins/authors can cancel an active review assignment.
  `
  ALTER TABLE users ADD COLUMN password_changed_at TEXT;
  ALTER TABLE review_assignments ADD COLUMN cancelled_by INTEGER REFERENCES users(id);
  `,
  // 6: random public reviewer codes, "taken down by an admin" state, and login/rate counters stored in the database.
  (db) => {
    db.exec(`
      ALTER TABLE users ADD COLUMN public_code TEXT;
      CREATE UNIQUE INDEX ux_users_public_code ON users(public_code);
      ALTER TABLE articles ADD COLUMN held_at TEXT;
      ALTER TABLE articles ADD COLUMN hold_reason TEXT NOT NULL DEFAULT '';
      CREATE TABLE rate_counters (
        key      TEXT PRIMARY KEY,
        count    INTEGER NOT NULL,
        reset_at INTEGER NOT NULL
      );
      CREATE INDEX idx_rate_counters_reset ON rate_counters(reset_at);
    `);
    for (const { id } of db.prepare('SELECT id FROM users WHERE public_code IS NULL').all()) {
      db.prepare('UPDATE users SET public_code = ? WHERE id = ?').run(newPublicCode(db), id);
    }
  },
];

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      const migration = MIGRATIONS[version];
      if (typeof migration === 'function') migration(db);
      else db.exec(migration);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// Run fn() inside a transaction. fn must be synchronous (no await inside).
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
