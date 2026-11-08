import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createBackup } from './backup-lib.js';

// Usage: npm run backup
const config = loadConfig();
const db = openDb(config.dbPath);
const result = createBackup(db, config);
db.close();
console.log(`Backup saved to: ${result.dir}`);
console.log(`  database: itc-blog.db${result.hasUploads ? '\n  images:   uploads\\' : '\n  (no uploaded images yet)'}`);
console.log('Copy that folder somewhere safe (USB drive, another computer, cloud storage).');
