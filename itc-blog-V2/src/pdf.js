import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import PDFDocument from 'pdfkit';

const COLORS = { text: '#1a1a1a', muted: '#666666', accent: '#c1121f', codeBg: '#f2f2f2', rule: '#d9d9d9', headBg: '#ececec' };
const PDF_FONTS = { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', mono: 'Courier' };
const WIN_ANSI_EXTRAS = new Set(Array.from('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'));

// The built-in PDF fonts only cover Western European text (English, French, ...).
// Anything else (Arabic, emoji, ...) becomes "?" instead of garbage.
function safe(text) {
  let out = '';
  for (const ch of String(text).normalize('NFC')) {
    const code = ch.codePointAt(0);
    if (code === 9) out += '    ';
    else if (code < 32 || (code >= 127 && code < 160)) out += ' ';
    else if (code < 256 || WIN_ANSI_EXTRAS.has(ch)) out += ch;
    else out += '?';
  }
  return out;
}

// **bold**, *italic*, `code` and [links](url) inside one line of text.
function inlineSegments(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return parts.map((part) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return { text: part.slice(2, -2), font: PDF_FONTS.bold };
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return { text: part.slice(1, -1), font: PDF_FONTS.mono };
    if ((part.startsWith('*') && part.endsWith('*') || part.startsWith('_') && part.endsWith('_')) && part.length > 2) {
      return { text: part.slice(1, -1), font: PDF_FONTS.italic };
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) return { text: `${link[1]} (${link[2]})`, font: PDF_FONTS.regular };
    return { text: part, font: PDF_FONTS.regular };
  });
}

function writeInline(doc, text, options = {}) {
  const segments = inlineSegments(safe(text)).filter((s) => s.text.length > 0);
  if (segments.length === 0) segments.push({ text: ' ', font: PDF_FONTS.regular });
  segments.forEach((seg, i) => {
    doc.font(seg.font).text(seg.text, { ...options, continued: i < segments.length - 1 });
  });
}

const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTableSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/**
 * Builds the PDF for one published article.
 * article: row from the articles query (needs title, subtitle, body, author_name, author_title, category_name,
 *          ref_code, published_at, read_minutes, word_count, cover_filename, cover_caption)
 */
export function renderArticlePdf(article, { uploadsDir, images = true }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 56, bottom: 64, left: 56, right: 56 },
        bufferPages: true,
        info: { Title: safe(article.title), Author: safe(article.author_name), Subject: safe(article.subtitle || ''), Creator: 'ITC Club Blog' },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = doc.page.margins.left;
      const width = doc.page.width - left - doc.page.margins.right;
      const maxY = () => doc.page.height - doc.page.margins.bottom;
      const ensureSpace = (needed) => {
        if (doc.y + needed > maxY()) doc.addPage();
      };

      // Local image files only (our own uploads). pdfkit can embed PNG and JPEG, not WebP.
      const imagePathFor = (filename) => {
        if (!images) return null;
        const name = basename(filename);
        if (!['.png', '.jpg', '.jpeg'].includes(extname(name).toLowerCase())) return null;
        const full = join(uploadsDir, name);
        return existsSync(full) ? full : null;
      };

      const drawImage = (filename, caption) => {
        const file = imagePathFor(filename);
        if (file) {
          const img = doc.openImage(file);
          const scale = Math.min(width / img.width, 300 / img.height, 1);
          const w = img.width * scale;
          const h = img.height * scale;
          ensureSpace(h + 30);
          doc.image(file, left + (width - w) / 2, doc.y, { width: w, height: h });
          doc.y += h + 6;
        } else {
          doc.font(PDF_FONTS.italic).fontSize(9).fillColor(COLORS.muted).text(safe(`[Figure not available in the PDF${caption ? `: ${caption}` : ''}]`), left, doc.y, { width });
        }
        if (caption) {
          doc.font(PDF_FONTS.italic).fontSize(8.5).fillColor(COLORS.muted).text(safe(caption), left, doc.y, { width, align: 'center' });
        }
        doc.moveDown(0.8);
      };

      // ---- Header ----
      const label = [article.category_name, article.kind && article.kind !== 'article' ? article.kind.replace('-', ' ') : null, article.ref_code]
        .filter(Boolean).join('  |  ').toUpperCase();
      doc.font(PDF_FONTS.bold).fontSize(8).fillColor(COLORS.accent).text(safe(label), left, doc.y, { width });
      doc.moveDown(0.5);
      doc.font(PDF_FONTS.bold).fontSize(22).fillColor(COLORS.text).text(safe(article.title), { width });
      if (article.subtitle) {
        doc.moveDown(0.4);
        doc.font(PDF_FONTS.italic).fontSize(11.5).fillColor(COLORS.muted).text(safe(article.subtitle), { width });
      }
      doc.moveDown(0.6);
      const date = article.published_at ? article.published_at.slice(0, 10) : '';
      const byline = [`By ${article.author_name}${article.author_title ? `, ${article.author_title}` : ''}`, date, `${article.read_minutes} min read`, `${article.word_count} words`]
        .filter(Boolean).join('  -  ');
      doc.font(PDF_FONTS.regular).fontSize(9).fillColor(COLORS.muted).text(safe(byline), { width });
      doc.moveDown(0.5);
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.7).strokeColor(COLORS.rule).stroke();
      doc.moveDown(0.8);

      if (article.cover_filename) drawImage(article.cover_filename, article.cover_caption);

      // ---- Body (Markdown subset) ----
      const lines = String(article.body).replace(/\r\n?/g, '\n').split('\n');
      let i = 0;
      const startsBlock = (line) =>
        /^\s*```/.test(line) || /^#{1,6}\s/.test(line) || /^\s*([-*+]|\d+\.)\s+/.test(line) || /^\s*>/.test(line) ||
        /^\s*\|/.test(line) || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) || /^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line);

      while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) { i += 1; continue; }

        // Fenced code block
        if (/^\s*```/.test(line)) {
          const language = line.replace(/^\s*```/, '').trim();
          const code = [];
          i += 1;
          while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i += 1; }
          i += 1; // closing fence
          doc.moveDown(0.3);
          doc.font(PDF_FONTS.mono).fontSize(8.5);
          if (language) {
            ensureSpace(24);
            doc.fillColor(COLORS.muted).font(PDF_FONTS.bold).fontSize(7.5).text(safe(language.toUpperCase()), left, doc.y, { width });
            doc.font(PDF_FONTS.mono).fontSize(8.5);
          }
          for (const raw of code) {
            const text = safe(raw) || ' ';
            const h = doc.heightOfString(text, { width: width - 14 });
            ensureSpace(h + 2);
            const y0 = doc.y;
            doc.rect(left, y0, width, h + 3).fill(COLORS.codeBg);
            doc.fillColor(COLORS.text).font(PDF_FONTS.mono).fontSize(8.5).text(text, left + 7, y0 + 1.5, { width: width - 14 });
            doc.y = y0 + h + 3;
          }
          doc.moveDown(0.8);
          continue;
        }

        // Heading
        const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
          const level = heading[1].length;
          const size = [0, 16, 13.5, 12, 11, 10.5, 10][level];
          ensureSpace(size + 40);
          doc.moveDown(level === 1 ? 0.9 : 0.6);
          doc.font(PDF_FONTS.bold).fontSize(size).fillColor(level === 2 ? COLORS.accent : COLORS.text).text(safe(heading[2]), left, doc.y, { width });
          doc.moveDown(0.35);
          i += 1;
          continue;
        }

        // Horizontal rule
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          ensureSpace(20);
          doc.moveDown(0.4);
          doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.7).strokeColor(COLORS.rule).stroke();
          doc.moveDown(0.6);
          i += 1;
          continue;
        }

        // Table: header row, separator row, body rows
        if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
          const rows = [splitRow(line)];
          i += 2;
          while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i += 1; }
          const cols = Math.max(...rows.map((r) => r.length));
          const weights = Array.from({ length: cols }, (_, c) => Math.max(6, Math.min(40, Math.max(...rows.map((r) => (r[c] ?? '').length)))));
          const total = weights.reduce((a, b) => a + b, 0);
          const colWidths = weights.map((w) => (w / total) * width);
          doc.moveDown(0.3);
          rows.forEach((row, rowIndex) => {
            doc.font(rowIndex === 0 ? PDF_FONTS.bold : PDF_FONTS.regular).fontSize(8);
            const heights = colWidths.map((cw, c) => doc.heightOfString(safe(row[c] ?? '') || ' ', { width: cw - 8 }));
            const rowHeight = Math.max(...heights) + 8;
            ensureSpace(rowHeight);
            const y0 = doc.y;
            let x = left;
            colWidths.forEach((cw, c) => {
              if (rowIndex === 0) doc.rect(x, y0, cw, rowHeight).fill(COLORS.headBg);
              doc.rect(x, y0, cw, rowHeight).lineWidth(0.5).strokeColor(COLORS.rule).stroke();
              doc.fillColor(COLORS.text).font(rowIndex === 0 ? PDF_FONTS.bold : PDF_FONTS.regular).fontSize(8)
                .text(safe(row[c] ?? ''), x + 4, y0 + 4, { width: cw - 8 });
              x += cw;
            });
            doc.y = y0 + rowHeight;
          });
          doc.moveDown(0.8);
          continue;
        }

        // Image on its own line: ![caption](/uploads/file.png)
        const image = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
        if (image) {
          const url = image[2].trim();
          drawImage(url.startsWith('/uploads/') ? url : '', image[1]);
          i += 1;
          continue;
        }

        // List item
        const item = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
        if (item) {
          const base = 18 + Math.min(Math.floor(item[1].length / 2), 3) * 14;
          const marker = /\d/.test(item[2]) ? item[2] : '\u2022';
          ensureSpace(16);
          const y0 = doc.y;
          doc.font(PDF_FONTS.regular).fontSize(10).fillColor(COLORS.text).text(marker, left + base - 18, y0, { width: 16, lineBreak: false });
          doc.x = left + base;
          doc.y = y0;
          writeInline(doc, item[3], { width: width - base });
          doc.x = left;
          doc.moveDown(0.2);
          i += 1;
          continue;
        }

        // Blockquote
        if (/^\s*>/.test(line)) {
          const quote = [];
          while (i < lines.length && /^\s*>/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
          const text = safe(quote.join(' '));
          doc.font(PDF_FONTS.italic).fontSize(10);
          const h = doc.heightOfString(text, { width: width - 16 });
          ensureSpace(h + 6);
          const y0 = doc.y;
          doc.rect(left, y0, 2.5, h).fill(COLORS.accent);
          doc.fillColor(COLORS.muted).text(text, left + 12, y0, { width: width - 16 });
          doc.x = left;
          doc.moveDown(0.6);
          continue;
        }

        // Paragraph: gather following plain lines
        const paragraph = [line.trim()];
        i += 1;
        while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) { paragraph.push(lines[i].trim()); i += 1; }
        ensureSpace(24);
        doc.font(PDF_FONTS.regular).fontSize(10).fillColor(COLORS.text);
        writeInline(doc, paragraph.join(' '), { width, align: 'left', lineGap: 2 });
        doc.x = left;
        doc.moveDown(0.6);
      }

      // ---- Footer on every page ----
      const range = doc.bufferedPageRange();
      for (let p = 0; p < range.count; p++) {
        doc.switchToPage(range.start + p);
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0; // otherwise writing in the margin would create a new page
        doc.font(PDF_FONTS.regular).fontSize(8).fillColor(COLORS.muted);
        doc.text(safe(`ITC Club Blog  |  ${article.ref_code}`), left, doc.page.height - 36, { width: width / 2, lineBreak: false });
        doc.text(`Page ${p + 1} of ${range.count}`, left + width / 2, doc.page.height - 36, { width: width / 2, align: 'right', lineBreak: false });
        doc.page.margins.bottom = bottom;
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Safe entry point used by the API.
// pdfkit decodes images asynchronously and a corrupt image can throw OUTSIDE any try/catch, which
// would crash the whole server. So the PDF is built in a worker thread: if it dies or hangs, only
// the worker is lost, and we retry once without images so the reader still gets a PDF.
// ---------------------------------------------------------------------------------------------
const WORKER_URL = new URL('./pdf-worker.js', import.meta.url);

function runInWorker(article, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { workerData: { article: { ...article }, options } });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('PDF generation timed out')), timeoutMs);
    worker.once('message', (m) => (m.ok ? finish(resolve, Buffer.from(m.buffer)) : finish(reject, new Error(m.error))));
    worker.once('error', (err) => finish(reject, err));
    worker.once('exit', (code) => finish(reject, new Error(`PDF worker stopped unexpectedly (code ${code})`)));
  });
}

export async function generateArticlePdf(article, { uploadsDir, timeoutMs = 15_000 }) {
  try {
    return await runInWorker(article, { uploadsDir, images: true }, timeoutMs);
  } catch {
    return await runInWorker(article, { uploadsDir, images: false }, timeoutMs);
  }
}
