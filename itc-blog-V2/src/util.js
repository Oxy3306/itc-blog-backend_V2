export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'validation_error', message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do this') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message, code = 'conflict') => new HttpError(409, code, message);

export const nowIso = () => new Date().toISOString();

export function slugify(text) {
  const slug = String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'article';
}

// Word count, code-block count and estimated read time for the editor ("~8 min read (1,840 words)").
export function textStats(body) {
  const words = body.split(/\s+/).filter(Boolean).length;
  const fences = (body.match(/^[ \t]*```/gm) ?? []).length;
  return {
    wordCount: words,
    codeBlocks: Math.ceil(fences / 2),
    readMinutes: Math.max(1, Math.ceil(words / 200)),
  };
}

// Table of contents with a read time per section ("§ 01 // OVERVIEW  READ TIME: 3 MIN"), from the Markdown headings.
export function outline(body) {
  const sections = [];
  let current = { title: 'Overview', level: 1, words: 0, implicit: true };
  let inCode = false;
  const flush = () => {
    if (current.implicit && current.words === 0) return;
    sections.push({
      index: sections.length + 1,
      title: current.title,
      level: current.level,
      words: current.words,
      readMinutes: Math.max(1, Math.ceil(current.words / 200)),
    });
  };
  for (const line of body.split(/\r?\n/)) {
    if (/^[ \t]*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    const heading = !inCode && /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      current = { title: heading[2].trim(), level: heading[1].length, words: 0 };
    } else {
      current.words += line.split(/\s+/).filter(Boolean).length;
    }
  }
  flush();
  return sections;
}

// Reference code shown in the review queue, e.g. "QUA-101". Stable for the life of the article.
export function refCodeFor(title, id) {
  const letters = (title.match(/[A-Za-z]/g) ?? []).slice(0, 3).join('').toUpperCase().padEnd(3, 'X');
  return `${letters}-${100 + id}`;
}

// Admins can set codes like "RFC-1049-DZ" or "AWQ-821": upper-case letters/digits in 2-5 dash-separated groups.
export const REF_CODE_PATTERN = /^[A-Z0-9]{1,12}(-[A-Z0-9]{1,12}){1,4}$/;

// "Target node" codes look like reference codes, e.g. ITC-BLIDA-MAIN. Returns the normalised code or throws a 400.
export function normalizeNodeCode(value, field = 'targetNode') {
  const code = String(value).trim().toUpperCase();
  if (!REF_CODE_PATTERN.test(code)) {
    throw badRequest('Validation failed', { [field]: 'use letters and digits in groups separated by dashes, e.g. ITC-BLIDA-MAIN' });
  }
  return code;
}

export const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

// First moment of the current calendar quarter (UTC), for "this quarter" stats.
export function startOfQuarterIso(date = new Date()) {
  const firstMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(date.getUTCFullYear(), firstMonth, 1)).toISOString();
}

export const round1 = (n) => Math.round(n * 10) / 10;

export function average(numbers) {
  return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
}

export const hoursBetween = (fromIso, toIso) => (Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000;

// Tiny validation helper: collect every problem, then throw one 400 with details per field.
export function validator(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const errors = {};
  const data = {};

  const missing = (field, required) => {
    const value = source[field];
    if (value === undefined || value === null) {
      if (required) errors[field] = 'is required';
      return true;
    }
    return false;
  };

  const api = {
    string(field, { min = 0, max = 10_000, required = true, trim = true } = {}) {
      if (missing(field, required)) return api;
      let value = source[field];
      if (typeof value !== 'string') {
        errors[field] = 'must be a string';
        return api;
      }
      if (trim) value = value.trim();
      if (value.length < min) errors[field] = min === 1 ? 'is required' : `must be at least ${min} characters`;
      else if (value.length > max) errors[field] = `must be at most ${max} characters`;
      else data[field] = value;
      return api;
    },
    email(field, { required = true } = {}) {
      if (missing(field, required)) return api;
      const value = source[field];
      if (typeof value !== 'string') errors[field] = 'must be a string';
      else if (value.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) errors[field] = 'must be a valid email address';
      else data[field] = value.trim().toLowerCase();
      return api;
    },
    int(field, { min = 1, max = Number.MAX_SAFE_INTEGER, required = true } = {}) {
      if (missing(field, required)) return api;
      const value = source[field];
      if (!Number.isInteger(value) || value < min || value > max) errors[field] = `must be an integer between ${min} and ${max}`;
      else data[field] = value;
      return api;
    },
    boolean(field, { required = true } = {}) {
      if (missing(field, required)) return api;
      if (typeof source[field] !== 'boolean') errors[field] = 'must be true or false';
      else data[field] = source[field];
      return api;
    },
    oneOf(field, allowed, { required = true } = {}) {
      if (missing(field, required)) return api;
      if (!allowed.includes(source[field])) errors[field] = `must be one of: ${allowed.join(', ')}`;
      else data[field] = source[field];
      return api;
    },
    stringArray(field, { maxItems = 10, maxLength = 40, required = false } = {}) {
      if (missing(field, required)) return api;
      const value = source[field];
      if (!Array.isArray(value) || value.length > maxItems) {
        errors[field] = `must be an array with at most ${maxItems} items`;
        return api;
      }
      const cleaned = [];
      for (const item of value) {
        const t = typeof item === 'string' ? item.trim() : '';
        if (!t || t.length > maxLength) {
          errors[field] = `items must be non-empty strings of at most ${maxLength} characters`;
          return api;
        }
        if (!cleaned.some((x) => x.toLowerCase() === t.toLowerCase())) cleaned.push(t);
      }
      data[field] = cleaned;
      return api;
    },
    done() {
      if (Object.keys(errors).length) throw badRequest('Validation failed', errors);
      return data;
    },
  };
  return api;
}

// Same idea for query strings (?page=2&limit=10).
export function parsePaging(query, { defaultLimit = 10, maxLimit = 50 } = {}) {
  const errors = {};
  const toNumber = (name, fallback, min, max) => {
    if (query[name] === undefined || query[name] === '') return fallback;
    const n = Number(query[name]);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors[name] = `must be an integer between ${min} and ${max}`;
      return fallback;
    }
    return n;
  };
  const page = toNumber('page', 1, 1, 1_000_000);
  const limit = toNumber('limit', defaultLimit, 1, maxLimit);
  if (Object.keys(errors).length) throw badRequest('Validation failed', errors);
  return { page, limit, offset: (page - 1) * limit };
}

export const queryString = (query, name) =>
  typeof query[name] === 'string' && query[name].trim() ? query[name].trim() : undefined;
