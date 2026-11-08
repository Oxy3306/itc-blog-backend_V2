export const ROLES = ['author', 'reviewer', 'admin'];

// Article lifecycle: draft -> pending_review -> (changes_requested -> pending_review)* -> approved -> published
export const STATUSES = ['draft', 'pending_review', 'changes_requested', 'approved', 'published'];

// Statuses in which the author may still edit the article.
export const EDITABLE_STATUSES = ['draft', 'changes_requested'];

export const KINDS = ['article', 'rfc', 'research-paper', 'post-mortem', 'tutorial'];

export const PRIORITIES = ['normal', 'high'];

// Slugs that would clash with fixed routes such as /api/articles/featured
export const RESERVED_SLUGS = new Set(['featured', 'stats']);
