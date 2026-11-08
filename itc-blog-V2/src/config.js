import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load variables from a ".env" file if there is one (built into Node, no package needed).
try {
  process.loadEnvFile();
} catch {
  // No .env file: fall back to defaults / real environment variables.
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXAMPLE_ENV_PATH = resolve(PROJECT_ROOT, '.env.example');

const toInt = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};
const MB = 1024 * 1024;

// The JWT_SECRET written in a ".env.example" file (or null).
export function secretInExampleFile(path = EXAMPLE_ENV_PATH) {
  try {
    const line = readFileSync(path, 'utf8').split(/\r?\n/).find((l) => l.startsWith('JWT_SECRET='));
    return line ? line.slice('JWT_SECRET='.length).trim() : null;
  } catch {
    return null;
  }
}

// An example file must only contain a placeholder. A real-looking secret there is public as soon as it is committed.
export function exampleFileLooksLeaked(path = EXAMPLE_ENV_PATH) {
  const value = secretInExampleFile(path);
  return Boolean(value) && !value.startsWith('change-me') && value.length >= 24;
}

// Values that are written in the source code or in the public example file. They can never be a real secret.
export function isPublicSecret(secret, { examplePath = EXAMPLE_ENV_PATH } = {}) {
  if (!secret) return true;
  return secret.startsWith('change-me') || secret.startsWith('dev-only') || secret === secretInExampleFile(examplePath);
}

// Outside production, when no real secret is set: a random one is created on the first start and kept in the data
// folder (data/.jwt-secret), so the server never runs with a value that anybody can read in the code or in git.
export function loadOrCreateLocalSecret(dir) {
  const file = join(dir, '.jwt-secret');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 64) return existing;
  } catch {
    // not created yet
  }
  const secret = randomBytes(48).toString('hex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

// Production refuses weak secrets, and any secret that is written in the (public) example file.
export function assertStrongSecret(secret, { examplePath = EXAMPLE_ENV_PATH } = {}) {
  if (secret.length < 32 || secret.startsWith('change-me') || secret.startsWith('dev-only')) {
    throw new Error('JWT_SECRET is too weak: use a random string of at least 32 characters');
  }
  const published = secretInExampleFile(examplePath);
  if (published && secret === published) {
    throw new Error(
      'JWT_SECRET is the same value that is written in .env.example, so it is public. ' +
        'Generate a new one and put it ONLY in your .env file (see README, "Secrets").',
    );
  }
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  const nodeEnv = env.NODE_ENV ?? 'development';

  const dbPath = env.DB_PATH ? resolve(env.DB_PATH) : resolve('data', 'itc-blog.db');
  let jwtSecret = env.JWT_SECRET;
  if (nodeEnv === 'production') {
    if (!jwtSecret) throw new Error('JWT_SECRET must be set when NODE_ENV=production');
    assertStrongSecret(jwtSecret);
  } else if (overrides.jwtSecret === undefined && (isPublicSecret(jwtSecret) || jwtSecret.length < 32)) {
    // No usable secret (missing, too short, the placeholder from .env.example, or an old built-in value): use a private local one.
    jwtSecret = loadOrCreateLocalSecret(dirname(dbPath));
  }

  return {
    nodeEnv,
    port: toInt(env.PORT, 3000),
    dbPath,
    uploadsDir: env.UPLOADS_DIR ? resolve(env.UPLOADS_DIR) : resolve('data', 'uploads'),
    maxUploadBytes: 5 * MB,
    maxUploadsPerUser: toInt(env.MAX_UPLOADS_PER_USER, 50),
    // Disk protection: a cap per account and a cap for the whole site.
    maxUploadBytesPerUser: toInt(env.MAX_STORAGE_MB_PER_USER, 50) * MB,
    maxUploadBytesTotal: toInt(env.MAX_TOTAL_STORAGE_MB, 2048) * MB,
    jwtSecret,
    // Key for the review signatures. Kept separate so rotating JWT_SECRET does not invalidate old signatures
    // (if you rotate, set this to the old "<old secret>:reviews").
    reviewSigningKey: env.REVIEW_SIGNING_KEY ?? `${jwtSecret}:reviews`,
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? '7d',
    corsOrigin: (env.CORS_ORIGIN ?? 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: env.TRUST_PROXY === 'true',
    defaultTargetNode: (env.DEFAULT_TARGET_NODE ?? 'ITC-BLIDA-MAIN').toUpperCase(),
    reviewSlaHours: toInt(env.REVIEW_SLA_HOURS, 48),
    reviewTargetHours: toInt(env.REVIEW_TARGET_HOURS, 24),
    minWordsToSubmit: toInt(env.MIN_WORDS_TO_SUBMIT, 20),
    // Failed logins only. Counted per account+IP, per account (all IPs) and per IP, so a whole campus sharing one
    // Wi-Fi address is not locked out by a few typos, while password guessing is still stopped.
    // The counters live in the database, so they survive restarts and are shared by every server process.
    loginLimits: {
      windowMs: 15 * 60 * 1000,
      perAccountAndIp: toInt(env.LOGIN_MAX_FAILURES, 8),
      perAccount: 40,
      perIp: 150,
    },
    registerLimit: { windowMs: 60 * 60 * 1000, max: toInt(env.REGISTER_RATE_LIMIT_MAX, 100) },
    // "Unique readers": new anonymous readers one address can add per hour (stops scripted inflation of read counts).
    anonViewsPerIpPerHour: toInt(env.ANON_VIEWS_PER_IP_PER_HOUR, 300),
    // PDF generation limits
    pdfMaxConcurrent: toInt(env.PDF_MAX_CONCURRENT, 2),
    pdfMaxQueue: toInt(env.PDF_MAX_QUEUE, 20),
    pdfCacheBytes: toInt(env.PDF_CACHE_MB, 32) * MB,
    pdfGenerate: null, // tests can replace the generator
    backupDir: env.BACKUP_DIR ? resolve(env.BACKUP_DIR) : resolve('backups'),
    logRequests: nodeEnv !== 'test',
    ...overrides,
  };
}
