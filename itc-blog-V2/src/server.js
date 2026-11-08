import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = createApp({ db, config });

if (config.nodeEnv !== 'production' && !process.env.JWT_SECRET) {
  console.warn('Note: no JWT_SECRET set, using a private random secret stored in data/.jwt-secret. Set JWT_SECRET (and NODE_ENV=production) when you deploy.');
}

// A plain Node server (not app.listen) so the "running" message only prints when the port was really free.
const server = createServer(app);

server.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Stop the other program, or set PORT=3001 in your .env file.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(config.port, () => {
  console.log(`ITC Blog API running on http://localhost:${config.port}  (health check: /api/health)`);
});

function shutdown() {
  setTimeout(() => process.exit(1), 5000).unref(); // do not hang forever if a connection stays open
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
