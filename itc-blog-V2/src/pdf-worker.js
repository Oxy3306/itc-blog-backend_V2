import { parentPort, workerData } from 'node:worker_threads';
import { renderArticlePdf } from './pdf.js';

try {
  const buffer = await renderArticlePdf(workerData.article, workerData.options);
  parentPort.postMessage({ ok: true, buffer });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err?.message ?? err) });
}
