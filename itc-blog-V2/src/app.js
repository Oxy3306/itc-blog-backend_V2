import express from 'express';
import cors from 'cors';
import { createAuth } from './auth.js';
import { generateArticlePdf } from './pdf.js';
import { createPdfService } from './pdf-service.js';
import { createRateLimiter, errorHandler, notFoundHandler, requestLogger } from './middleware.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { publicRoutes } from './routes/public.js';
import { reviewRoutes } from './routes/reviews.js';
import { nowIso } from './util.js';

export function createApp({ db, config }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(cors({ origin: config.corsOrigin.includes('*') ? '*' : config.corsOrigin }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  // Uploaded images. Random file names, never executed: served with "nosniff" and a locked-down CSP.
  app.use(
    '/uploads',
    express.static(config.uploadsDir, {
      index: false,
      dotfiles: 'deny',
      maxAge: '365d',
      immutable: true,
      setHeaders(res) {
        res.set('Content-Security-Policy', "default-src 'none'");
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      },
    }),
  );
  if (config.logRequests) app.use(requestLogger);
  app.use(express.json({ limit: '1mb' }));

  const auth = createAuth({ db, config });
  const rateLimit = createRateLimiter(db, { name: 'register', ...config.registerLimit });
  const pdf = createPdfService({
    generate: (article, options) => (config.pdfGenerate ?? generateArticlePdf)(article, options), // looked up on every call
    maxConcurrent: config.pdfMaxConcurrent,
    maxQueue: config.pdfMaxQueue,
    maxCacheBytes: config.pdfCacheBytes,
  });
  const deps = { db, config, auth, rateLimit, pdf };

  app.get('/api/health', (req, res) => res.json({ status: 'ok', time: nowIso() }));
  app.use('/api/auth', authRoutes(deps));
  app.use('/api/me', meRoutes(deps));
  app.use('/api/reviews', reviewRoutes(deps));
  app.use('/api/admin', adminRoutes(deps));
  app.use('/api', publicRoutes(deps));

  app.use(notFoundHandler);
  app.use(errorHandler({ quiet: config.nodeEnv === 'test' }));
  return app;
}
