import { HttpError } from './util.js';

/**
 * Protects the server from PDF requests:
 *  - several requests for the same PDF at the same time share ONE generation,
 *  - at most `maxConcurrent` PDFs are built at once, `maxQueue` more may wait, the rest get "busy" (503),
 *  - finished PDFs are cached up to `maxCacheBytes` in total (oldest-used are dropped first).
 */
export function createPdfService({ generate, maxConcurrent, maxQueue, maxCacheBytes }) {
  const cache = new Map(); // insertion order = least recently used first
  let cacheBytes = 0;
  const inflight = new Map();
  const waiting = [];
  let running = 0;

  const acquire = () =>
    new Promise((resolve, reject) => {
      if (running < maxConcurrent) {
        running += 1;
        resolve();
      } else if (waiting.length >= maxQueue) {
        reject(new HttpError(503, 'busy', 'PDF generation is busy right now. Please try again in a moment.'));
      } else {
        waiting.push(resolve); // the slot is handed over directly when someone finishes
      }
    });
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };

  const remember = (key, buffer) => {
    if (buffer.length > maxCacheBytes) return; // too big to keep
    cache.set(key, buffer);
    cacheBytes += buffer.length;
    for (const [oldKey, oldBuffer] of cache) {
      if (cacheBytes <= maxCacheBytes) break;
      cache.delete(oldKey);
      cacheBytes -= oldBuffer.length;
    }
  };

  return {
    async get(key, article, options) {
      if (cache.has(key)) {
        const buffer = cache.get(key);
        cache.delete(key); // move to the "most recently used" end
        cache.set(key, buffer);
        return buffer;
      }
      if (inflight.has(key)) return inflight.get(key);
      const job = (async () => {
        await acquire();
        try {
          const buffer = await generate(article, options);
          remember(key, buffer);
          return buffer;
        } finally {
          release();
        }
      })();
      inflight.set(key, job);
      try {
        return await job;
      } finally {
        inflight.delete(key);
      }
    },
    stats: () => ({ cachedFiles: cache.size, cachedBytes: cacheBytes, running, waiting: waiting.length }),
  };
}
