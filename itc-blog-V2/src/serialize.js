import { uploadUrl } from './uploads.js';
import { outline } from './util.js';

// Shared SQL pieces so every endpoint returns articles in the same shape.
export const ARTICLE_JOINS = `LEFT JOIN categories c ON c.id = a.category_id JOIN users u ON u.id = a.author_id
  LEFT JOIN uploads up ON up.id = a.cover_upload_id`;
export const ARTICLE_FROM = `articles a ${ARTICLE_JOINS}`;
export const ARTICLE_COLUMNS = `
  a.id, a.slug, a.ref_code, a.kind, a.title, a.subtitle, a.tags, a.status, a.is_featured,
  a.word_count, a.code_blocks, a.read_minutes, a.revision, a.submitted_at, a.published_at,
  a.created_at, a.updated_at, a.author_id, a.category_id, a.cover_upload_id, a.cover_caption, a.target_node,
  a.held_at, a.hold_reason,
  up.filename AS cover_filename,
  c.name AS category_name, c.slug AS category_slug,
  u.name AS author_name, u.title AS author_title,
  (SELECT COUNT(*) FROM article_views v WHERE v.article_id = a.id) AS reads`;

export function toArticle(row) {
  return {
    id: row.id,
    slug: row.slug,
    refCode: row.ref_code,
    kind: row.kind,
    targetNode: row.target_node,
    title: row.title,
    subtitle: row.subtitle,
    tags: JSON.parse(row.tags),
    status: row.status,
    featured: row.is_featured === 1,
    // set when an admin took the article offline: only an admin can publish it again
    takenDown: row.held_at ? { at: row.held_at, reason: row.hold_reason } : null,
    cover: row.cover_upload_id ? { id: row.cover_upload_id, url: uploadUrl(row.cover_filename), caption: row.cover_caption } : null,
    category: row.category_id ? { id: row.category_id, name: row.category_name, slug: row.category_slug } : null,
    author: { id: row.author_id, name: row.author_name, title: row.author_title },
    wordCount: row.word_count,
    codeBlocks: row.code_blocks,
    readMinutes: row.read_minutes,
    revision: row.revision,
    reads: row.reads,
    submittedAt: row.submitted_at,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// With the full text and a table of contents (section titles + read time per section).
export const toArticleWithBody = (row) => ({ ...toArticle(row), body: row.body, sections: outline(row.body) });

export function toUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    title: row.title,
    bio: row.bio,
    reviewerCode: row.role === 'author' ? null : (row.public_code ?? null),
    createdAt: row.created_at,
  };
}

// What an author sees of a review: the reviewer's public ID, never their name.
export const toReviewForAuthor = (row) => ({
  id: row.id,
  revision: row.revision,
  decision: row.decision,
  feedback: row.feedback,
  reviewerCode: row.reviewer_code,
  createdAt: row.created_at,
});
