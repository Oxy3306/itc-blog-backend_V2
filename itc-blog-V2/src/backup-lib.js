import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Makes a consistent copy of the database (safe while the server is running) plus the uploaded images.
export function createBackup(db, { uploadsDir, backupDir }) {
  const stamp = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 23); // 2026-11-03_10-15-30-123
  const dir = join(backupDir, stamp);
  mkdirSync(dir, { recursive: true });
  const dbFile = join(dir, 'itc-blog.db');
  db.exec(`VACUUM INTO '${dbFile.replaceAll("'", "''")}'`);
  const hasUploads = existsSync(uploadsDir);
  if (hasUploads) cpSync(uploadsDir, join(dir, 'uploads'), { recursive: true });
  return { dir, dbFile, hasUploads };
}
