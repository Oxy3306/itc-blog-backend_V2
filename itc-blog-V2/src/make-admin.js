import { loadConfig } from './config.js';
import { openDb } from './db.js';

// Usage: npm run make-admin -- someone@example.com
const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run make-admin -- someone@example.com');
  process.exit(1);
}

const db = openDb(loadConfig().dbPath);
const result = db.prepare(`UPDATE users SET role = 'admin' WHERE email = ?`).run(email);
if (result.changes === 0) {
  console.error(`No account found for ${email}. Register it first (POST /api/auth/register), then run this again.`);
  process.exit(1);
}
console.log(`${email} is now an admin.`);
db.close();
