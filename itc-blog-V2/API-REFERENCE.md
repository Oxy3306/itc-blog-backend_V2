# ITC Blog API reference

For the frontend team. Every example below is a **real response** from the running server filled with the sample data (`npm run seed`),
so the shapes are exact. Long text is shortened with `...`, and lists are cut to one item to keep this readable (the real ones are longer).

## Quick start

1. `npm install`, then `copy .env.example .env`, then `npm run seed`, then `npm run dev` (Windows CMD, in the project folder).
2. The API runs at `http://localhost:3000`. Check `http://localhost:3000/api/health`.
3. In `.env`, set `CORS_ORIGIN` to the address of your dev server (default `http://localhost:5173`; separate several with commas).
4. Sample accounts (password `Password123!` for all): `admin@itc.local`, `reviewer1@itc.local`, `reviewer2@itc.local`, `yacine@itc.local` (author with articles in every status).

## Conventions

- **JSON in, JSON out**, field names in `camelCase`. IDs are numbers. Dates are ISO 8601 in UTC (`2026-11-03T10:15:00.000Z`): convert to local time in the browser.
- **Sign-in:** `POST /api/auth/login` returns a `token`. Send it on protected requests as the header `Authorization: Bearer <token>`. It lasts 7 days.
  Store it, and on any `401` from a protected call, send the user to the sign-in page. A bad or expired token on a *public* page is simply ignored.
- **Roles:** `author` (every new account), `reviewer`, `admin`. The role is in `user.role`: use it to show or hide the Review Queue.
- **Article statuses:** `draft` -> `pending_review` -> `changes_requested` (back to the author, who edits and resubmits) -> `approved` -> `published`.
  Authors can only edit in `draft` and `changes_requested`. Nothing is public until `published`.
  An admin can take a published article down (`unpublish`): it goes back to `approved` with `article.takenDown` set (`{ at, reason }`), and then **only an admin** can publish it again.
- **Lists** return `{ items, page, limit, total, hasMore }`. For "Load more" request `page + 1` while `hasMore` is `true`.
- **Images:** an upload's `url` (and `article.cover.url`) is relative, such as `/uploads/ab12.png`. Prefix it with the API address.
  Article bodies are **Markdown text**: render and sanitize them (for example with DOMPurify) before putting them in the page.
- **Reference codes** (`refCode`, like `QUA-113`) are shown on cards and in the review queue. `dispatchId` appears on the Review Article page.
- **Read time, word count, code-block count and `sections`** are calculated by the server on every save: do not compute them in the browser.
- **Rate limits:** wrong-password logins are limited (`429` with a `Retry-After` header in seconds). The counters are stored in the database, so a restart does not reset them.
- **Reviewer codes** (`WK-BLIDA-K7QX2`) are random public IDs, not derived from the user's id. Authors only ever see this code, never a reviewer's name.
- **Other limits:** images are limited to 50 per account, 50 MB per account and 2 GB for the whole site; PDF generation answers `503 busy` when the server is overloaded (try again in a moment).
- **There are no admin screens in the design.** The admin endpoints below exist so the review flow can run, but someone has to build a page
  for them (or call them by hand) before reviewers can be assigned manuscripts.

## Authentication

### `POST /api/auth/register`

**Who:** Public &nbsp;|&nbsp; Create an account (always starts as role `author`).

Request body:
```json
{
  "name": "Sara Benali",
  "email": "sara@example.com",
  "password": "at-least-8-chars",
  "title": "Optional: role or affiliation"
}
```

Response `201`:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYXV0aG9yIiwiaWF0IjoxNzk0MDY4MTgzLCJleHAiOjE3OTQ2NzI5ODMsIn...",
  "user": {
    "id": 12,
    "name": "Sara Benali",
    "email": "sara@example.com",
    "role": "author",
    "title": "Optional: role or affiliation",
    "bio": "",
    "reviewerCode": null,
    "createdAt": "2026-11-07T16:16:23.511Z"
  }
}
```

### `POST /api/auth/login`

**Who:** Public &nbsp;|&nbsp; Returns the token to send as `Authorization: Bearer <token>`.

Request body:
```json
{
  "email": "yacine@itc.local",
  "password": "Password123!"
}
```

Response `200`:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYXV0aG9yIiwiaWF0IjoxNzk0MDY4MTgzLCJleHAiOjE3OTQ2NzI5ODMsIn...",
  "user": {
    "id": 4,
    "name": "Yacine Merabet",
    "email": "yacine@itc.local",
    "role": "author",
    "title": "Systems & Kernel Lead",
    "bio": "Senior Computer Science Student at Saad Dahlab Blida 1. Specializing in Linux kernel internals, low-level n...",
    "reviewerCode": null,
    "createdAt": "2026-08-09T16:16:21.454Z"
  }
}
```

### `GET /api/auth/me`

**Who:** Any signed-in user

Response `200`:
```json
{
  "user": {
    "id": 4,
    "name": "Yacine Merabet",
    "email": "yacine@itc.local",
    "role": "author",
    "title": "Systems & Kernel Lead",
    "bio": "Senior Computer Science Student at Saad Dahlab Blida 1. Specializing in Linux kernel internals, low-level n...",
    "reviewerCode": null,
    "createdAt": "2026-08-09T16:16:21.454Z"
  }
}
```


## Public pages (no sign-in)

### `GET /api/articles/featured`

**Who:** Public &nbsp;|&nbsp; Homepage highlights. `?limit=` up to 6 (default 2).

Response `200`:
```json
{
  "items": [
    {
      "id": 2,
      "slug": "fine-tuning-llama-3-for-algerian-darija-nlp",
      "refCode": "FIN-102",
      "kind": "research-paper",
      "targetNode": "ITC-BLIDA-MAIN",
      "title": "Fine-Tuning Llama 3 for Algerian Darija NLP",
      "subtitle": "Methodology, LoRA hyperparameters, and synthetic corpus tokenization challenges when fine-tuning multilingu...",
      "tags": [
        "llm"
      ],
      "status": "published",
      "featured": true,
      "takenDown": null,
      "cover": null,
      "category": {
        "id": 4,
        "name": "AI & NLP",
        "slug": "ai-nlp"
      },
      "author": {
        "id": 11,
        "name": "ML Research Division",
        "title": "ITC Labs"
      },
      "wordCount": 119,
      "codeBlocks": 1,
      "readMinutes": 1,
      "revision": 1,
      "reads": 37,
      "submittedAt": "2026-10-30T16:16:21.473Z",
      "publishedAt": "2026-11-02T16:16:21.473Z",
      "createdAt": "2026-10-28T16:16:21.473Z",
      "updatedAt": "2026-11-02T16:16:21.473Z"
    }
  ]
}
```

### `GET /api/articles`

**Who:** Public &nbsp;|&nbsp; Homepage "Latest" and the Explore page. Only published articles.

**Query:** `search` (title, subtitle, tags, author name, body), `category` (topic slug), `author` (user id), `node`, `sort` = `latest` (default) \| `oldest` \| `popular` \| `shortest`, `page` (from 1), `limit` (1-50, default 10). "Load more" = request `page + 1` while `hasMore` is true. Lists show 1 article here to keep the example short.

Response `200`:
```json
{
  "items": [
    {
      "id": 4,
      "slug": "zero-downtime-migration-to-kubernetes-cilium-ebpf-cni",
      "refCode": "ZER-104",
      "kind": "article",
      "targetNode": "ITC-BLIDA-MAIN",
      "title": "Zero-Downtime Migration to Kubernetes Cilium eBPF CNI",
      "subtitle": "Replacing standard iptables networking with eBPF-powered routing across our bare-metal cluster with zero dr...",
      "tags": [
        "cilium"
      ],
      "status": "published",
      "featured": false,
      "takenDown": null,
      "cover": null,
      "category": {
        "id": 2,
        "name": "DevOps",
        "slug": "devops"
      },
      "author": {
        "id": 6,
        "name": "Mehdi Kadri",
        "title": "DevOps Guild"
      },
      "wordCount": 121,
      "codeBlocks": 1,
      "readMinutes": 1,
      "revision": 1,
      "reads": 20,
      "submittedAt": "2026-10-31T16:16:21.502Z",
      "publishedAt": "2026-11-03T16:16:21.502Z",
      "createdAt": "2026-10-29T16:16:21.502Z",
      "updatedAt": "2026-11-03T16:16:21.502Z"
    }
  ],
  "page": 1,
  "limit": 2,
  "total": 9,
  "hasMore": true
}
```

### `GET /api/articles/stats`

**Who:** Public &nbsp;|&nbsp; Explore page header numbers.

Response `200`:
```json
{
  "publishedArticles": 9,
  "activeTracks": 7,
  "meanReadMinutes": 1,
  "acceptanceRate": 71
}
```

### `GET /api/categories`

**Who:** Public &nbsp;|&nbsp; Topics for the filter, with article counts.

Response `200`:
```json
{
  "categories": [
    {
      "id": 4,
      "name": "AI & NLP",
      "slug": "ai-nlp",
      "articleCount": 1
    },
    {
      "id": 7,
      "name": "Cloud",
      "slug": "cloud",
      "articleCount": 1
    },
    {
      "id": 3,
      "name": "Cybersecurity",
      "slug": "cybersecurity",
      "articleCount": 1
    }
  ]
}
```

### `GET /api/nodes`

**Who:** Public &nbsp;|&nbsp; Target nodes in use.

Response `200`:
```json
{
  "defaultNode": "ITC-BLIDA-MAIN",
  "nodes": [
    {
      "code": "ITC-BLIDA-MAIN",
      "articleCount": 9
    }
  ]
}
```

### `GET /api/articles/:slug`

**Who:** Public &nbsp;|&nbsp; Article page. Counts one read per reader. `sections` is the table of contents with read time per section; `related` has up to 3 articles.

Response `200`:
```json
{
  "article": {
    "id": 4,
    "slug": "zero-downtime-migration-to-kubernetes-cilium-ebpf-cni",
    "refCode": "ZER-104",
    "kind": "article",
    "targetNode": "ITC-BLIDA-MAIN",
    "title": "Zero-Downtime Migration to Kubernetes Cilium eBPF CNI",
    "subtitle": "Replacing standard iptables networking with eBPF-powered routing across our bare-metal cluster with zero dr...",
    "tags": [
      "cilium"
    ],
    "status": "published",
    "featured": false,
    "takenDown": null,
    "cover": null,
    "category": {
      "id": 2,
      "name": "DevOps",
      "slug": "devops"
    },
    "author": {
      "id": 6,
      "name": "Mehdi Kadri",
      "title": "DevOps Guild"
    },
    "wordCount": 121,
    "codeBlocks": 1,
    "readMinutes": 1,
    "revision": 1,
    "reads": 21,
    "submittedAt": "2026-10-31T16:16:21.502Z",
    "publishedAt": "2026-11-03T16:16:21.502Z",
    "createdAt": "2026-10-29T16:16:21.502Z",
    "updatedAt": "2026-11-03T16:16:21.502Z",
    "body": "## 1. Context\n\nReplacing standard iptables networking with eBPF-powered routing across our bare-metal clust...",
    "sections": [
      {
        "index": 1,
        "title": "1. Context",
        "level": 2,
        "words": 38,
        "readMinutes": 1
      }
    ]
  },
  "author": {
    "id": 6,
    "name": "Mehdi Kadri",
    "title": "DevOps Guild",
    "bio": ""
  },
  "related": [
    {
      "id": 3,
      "slug": "architecting-low-latency-real-time-telemetry-with-ebpf-and-go-in-kubernetes",
      "refCode": "ARC-103",
      "kind": "article",
      "targetNode": "ITC-BLIDA-MAIN",
      "title": "Architecting Low-Latency Real-Time Telemetry with eBPF and Go in Kubernetes",
      "subtitle": "How we bypassed traditional user-space socket overhead to achieve sub-millisecond network tracing across 14...",
      "tags": [
        "ebpf"
      ],
      "status": "published",
      "featured": false,
      "takenDown": null,
      "cover": null,
      "category": {
        "id": 2,
        "name": "DevOps",
        "slug": "devops"
      },
      "author": {
        "id": 4,
        "name": "Yacine Merabet",
        "title": "Systems & Kernel Lead"
      },
      "wordCount": 126,
      "codeBlocks": 1,
      "readMinutes": 1,
      "revision": 1,
      "reads": 55,
      "submittedAt": "2026-10-19T16:16:21.484Z",
      "publishedAt": "2026-10-22T16:16:21.484Z",
      "createdAt": "2026-10-17T16:16:21.485Z",
      "updatedAt": "2026-10-22T16:16:21.485Z"
    }
  ]
}
```

### `GET /api/articles/:slug/downloads`

**Who:** Public &nbsp;|&nbsp; Links and file sizes for the "Download the article" button.

Response `200`:
```json
{
  "pdf": {
    "url": "/api/articles/zero-downtime-migration-to-kubernetes-cilium-ebpf-cni/download?format=pdf",
    "bytes": 3232
  },
  "markdown": {
    "url": "/api/articles/zero-downtime-migration-to-kubernetes-cilium-ebpf-cni/download?format=md",
    "bytes": 1003
  }
}
```

### `GET /api/articles/:slug/download`

**Who:** Public &nbsp;|&nbsp; The file itself. `?format=pdf` (default) or `?format=md`.

Response `200`: `application/pdf`, `attachment; filename=zero-downtime-migration-to-kubernetes-cilium-ebpf-cni.pdf` (3232 bytes)

### `GET /api/authors`

**Who:** Public &nbsp;|&nbsp; Members directory: people with at least one published article. Query: `search`, `sort` = `articles` \| `name` \| `recent`, `page`, `limit`.

Response `200`:
```json
{
  "items": [
    {
      "id": 4,
      "name": "Yacine Merabet",
      "title": "Systems & Kernel Lead",
      "bio": "Senior Computer Science Student at Saad Dahlab Blida 1. Specializing in Linux kernel internals, low-level n...",
      "articleCount": 2,
      "latestPublishedAt": "2026-10-22T16:16:21.484Z"
    }
  ],
  "page": 1,
  "limit": 2,
  "total": 8,
  "hasMore": true
}
```

### `GET /api/authors/:id`

**Who:** Public &nbsp;|&nbsp; "View Author Profile". `404` for people with no published article.

Response `200`:
```json
{
  "author": {
    "id": 6,
    "name": "Mehdi Kadri",
    "title": "DevOps Guild",
    "bio": "",
    "joinedAt": "2026-08-09T16:16:21.455Z",
    "articleCount": 1
  },
  "articles": [
    {
      "id": 4,
      "slug": "zero-downtime-migration-to-kubernetes-cilium-ebpf-cni",
      "refCode": "ZER-104",
      "kind": "article",
      "targetNode": "ITC-BLIDA-MAIN",
      "title": "Zero-Downtime Migration to Kubernetes Cilium eBPF CNI",
      "subtitle": "Replacing standard iptables networking with eBPF-powered routing across our bare-metal cluster with zero dr...",
      "tags": [
        "cilium"
      ],
      "status": "published",
      "featured": false,
      "takenDown": null,
      "cover": null,
      "category": {
        "id": 2,
        "name": "DevOps",
        "slug": "devops"
      },
      "author": {
        "id": 6,
        "name": "Mehdi Kadri",
        "title": "DevOps Guild"
      },
      "wordCount": 121,
      "codeBlocks": 1,
      "readMinutes": 1,
      "revision": 1,
      "reads": 21,
      "submittedAt": "2026-10-31T16:16:21.502Z",
      "publishedAt": "2026-11-03T16:16:21.502Z",
      "createdAt": "2026-10-29T16:16:21.502Z",
      "updatedAt": "2026-11-03T16:16:21.502Z"
    }
  ]
}
```


## Author: My Articles and the Editor (sign-in required)

### `GET /api/me/articles`

**Who:** Any signed-in user (own articles only) &nbsp;|&nbsp; My Articles page.

**Query:** `status` (`draft` \| `pending_review` \| `changes_requested` \| `approved` \| `published`), `search`, `page`, `limit` (default 20). `counts` always has all 5 statuses (for the tab badges). `stats`: `publishRate` and `avgReviewHours` are `null` until there is something to measure.

Response `200`:
```json
{
  "items": [
    {
      "id": 12,
      "slug": "exploring-webgpu-compute-shaders-for-graph-neural-nets",
      "refCode": "EXP-112",
      "kind": "article",
      "targetNode": "ITC-BLIDA-MAIN",
      "title": "Exploring WebGPU Compute Shaders for Graph Neural Nets",
      "subtitle": "Writing custom WGSL shaders to execute message-passing passes directly on client GPUs.",
      "tags": [
        "webgpu"
      ],
      "status": "draft",
      "featured": false,
      "takenDown": null,
      "cover": null,
      "category": {
        "id": 6,
        "name": "Web Development",
        "slug": "web-development"
      },
      "author": {
        "id": 4,
        "name": "Yacine Merabet",
        "title": "Systems & Kernel Lead"
      },
      "wordCount": 119,
      "codeBlocks": 1,
      "readMinutes": 1,
      "revision": 0,
      "reads": 0,
      "submittedAt": null,
      "publishedAt": null,
      "createdAt": "2026-11-01T16:16:21.548Z",
      "updatedAt": "2026-11-06T16:16:21.548Z",
      "reviewerNotes": 0
    }
  ],
  "page": 1,
  "limit": 1,
  "total": 6,
  "hasMore": true,
  "counts": {
    "draft": 1,
    "pending_review": 1,
    "changes_requested": 1,
    "approved": 1,
    "published": 2
  },
  "stats": {
    "publishRate": 75,
    "firstPassApproved": 3,
    "reviewedManuscripts": 4,
    "avgReviewHours": 54.5,
    "communityReads": 64,
    "reviewTargetHours": 24
  }
}
```

### `GET /api/me/articles/:id`

**Who:** Owner &nbsp;|&nbsp; Full article for the editor, plus the reviewers' feedback (reviewer ID only, never their name).

Response `200`:
```json
{
  "article": {
    "id": 11,
    "slug": "memory-management-in-high-throughput-go-workers",
    "refCode": "MEM-111",
    "kind": "article",
    "targetNode": "ITC-BLIDA-MAIN",
    "title": "Memory Management in High-Throughput Go Workers",
    "subtitle": "Profiling allocation patterns and arena reuse in write-heavy services.",
    "tags": [
      "go"
    ],
    "status": "changes_requested",
    "featured": false,
    "takenDown": null,
    "cover": null,
    "category": {
      "id": 1,
      "name": "Software Engineering",
      "slug": "software-engineering"
    },
    "author": {
      "id": 4,
      "name": "Yacine Merabet",
      "title": "Systems & Kernel Lead"
    },
    "wordCount": 114,
    "codeBlocks": 1,
    "readMinutes": 1,
    "revision": 1,
    "reads": 0,
    "submittedAt": "2026-11-01T16:16:21.546Z",
    "publishedAt": null,
    "createdAt": "2026-10-30T16:16:21.546Z",
    "updatedAt": "2026-11-04T16:16:21.546Z",
    "body": "## 1. Context\n\nProfiling allocation patterns and arena reuse in write-heavy services. This write-up documen...",
    "sections": [
      {
        "index": 1,
        "title": "1. Context",
        "level": 2,
        "words": 32,
        "readMinutes": 1
      }
    ]
  },
  "reviews": [
    {
      "id": 11,
      "revision": 1,
      "decision": "changes_requested",
      "feedback": "Excellent analysis. In Section 3, please list the Go version and GC settings used, and add a short warning ...",
      "reviewerCode": "WK-BLIDA-W2J3",
      "createdAt": "2026-11-05T12:16:21.547Z"
    }
  ]
}
```

### `POST /api/me/articles`

**Who:** Any signed-in user &nbsp;|&nbsp; Create a draft. Only `title` is required.

Optional fields: `subtitle`, `categoryId`, `tags` (max 8), `kind` (`article` \| `rfc` \| `research-paper` \| `post-mortem` \| `tutorial`), `body` (Markdown), `targetNode`, `coverImageId`, `coverCaption`. `wordCount`, `readMinutes`, `codeBlocks` and `sections` are calculated by the server.

Request body:
```json
{
  "title": "My new article",
  "subtitle": "A short abstract",
  "categoryId": 7,
  "tags": [
    "go",
    "kernel"
  ],
  "body": "## 1. Intro\nSome text with **bold**.\n",
  "targetNode": "ITC-BLIDA-MAIN"
}
```

Response `201`:
```json
{
  "article": {
    "id": 16,
    "slug": "my-new-article",
    "refCode": "MYN-116",
    "kind": "article",
    "targetNode": "ITC-BLIDA-MAIN",
    "title": "My new article",
    "subtitle": "A short abstract",
    "tags": [
      "go"
    ],
    "status": "draft",
    "featured": false,
    "takenDown": null,
    "cover": null,
    "category": {
      "id": 7,
      "name": "Cloud",
      "slug": "cloud"
    },
    "author": {
      "id": 4,
      "name": "Yacine Merabet",
      "title": "Systems & Kernel Lead"
    },
    "wordCount": 7,
    "codeBlocks": 0,
    "readMinutes": 1,
    "revision": 0,
    "reads": 0,
    "submittedAt": null,
    "publishedAt": null,
    "createdAt": "2026-11-07T16:16:23.914Z",
    "updatedAt": "2026-11-07T16:16:23.914Z",
    "body": "## 1. Intro\nSome text with **bold**.\n",
    "sections": [
      {
        "index": 1,
        "title": "1. Intro",
        "level": 2,
        "words": 4,
        "readMinutes": 1
      }
    ]
  },
  "reviews": []
}
```

### `PATCH /api/me/articles/:id`

**Who:** Owner, while `draft` or `changes_requested` &nbsp;|&nbsp; Save Draft (send only the fields that changed).

Autosave: send `baseUpdatedAt` = the `updatedAt` you last received. If the article was saved elsewhere meanwhile you get `409 edit_conflict`. Send `"coverImageId": null` to remove the cover image.

Request body:
```json
{
  "body": "## 1. Intro\nEdited text. This paragraph has enough words so the article can be submitted for review. This paragraph has enough words so the article can be submitted for review. This paragraph has enough words so the article can be submitted for review. \n",
  "baseUpdatedAt": "2026-11-07T16:16:23.914Z"
}
```

Response `200`:
```json
{
  "article": {
    "id": 16,
    "slug": "my-new-article",
    "refCode": "MYN-116",
    "kind": "article",
    "targetNode": "ITC-BLIDA-MAIN",
    "title": "My new article",
    "subtitle": "A short abstract",
    "tags": [
      "go"
    ],
    "status": "draft",
    "featured": false,
    "takenDown": null,
    "cover": null,
    "category": {
      "id": 7,
      "name": "Cloud",
      "slug": "cloud"
    },
    "author": {
      "id": 4,
      "name": "Yacine Merabet",
      "title": "Systems & Kernel Lead"
    },
    "wordCount": 44,
    "codeBlocks": 0,
    "readMinutes": 1,
    "revision": 0,
    "reads": 0,
    "submittedAt": null,
    "publishedAt": null,
    "createdAt": "2026-11-07T16:16:23.914Z",
    "updatedAt": "2026-11-07T16:16:23.921Z",
    "body": "## 1. Intro\nEdited text. This paragraph has enough words so the article can be submitted for review. This p...",
    "sections": [
      {
        "index": 1,
        "title": "1. Intro",
        "level": 2,
        "words": 41,
        "readMinutes": 1
      }
    ]
  },
  "reviews": []
}
```

### `POST /api/me/uploads`

**Who:** Any signed-in user &nbsp;|&nbsp; Upload an image.

Limits: 50 images and 50 MB per account (`409 upload_limit`), 2 GB for the whole site (`507 storage_full`). Send the **raw file bytes** as the body (not JSON, not multipart) with `Content-Type: image/jpeg`, `image/png` or `image/webp` (max 5 MB). Use the returned `url` (prefix it with the API address) in an `<img>` or in the article body as `![caption](/uploads/...)`.

Response `201`:
```json
{
  "upload": {
    "id": 1,
    "url": "/uploads/875e7b2bd849e7149a841323.png",
    "mime": "image/png",
    "bytes": 70,
    "createdAt": "2026-11-07T16:16:23.926Z"
  }
}
```

### `POST /api/me/articles/:id/submit`

**Who:** Owner &nbsp;|&nbsp; Submit for review (needs subtitle, topic and at least 20 words). Works from `draft` and `changes_requested`.

Response `200`:
```json
{
  "article": {
    "id": 16,
    "slug": "my-new-article",
    "refCode": "MYN-116",
    "kind": "article",
    "targetNode": "ITC-BLIDA-MAIN",
    "title": "My new article",
    "subtitle": "A short abstract",
    "tags": [
      "go"
    ],
    "status": "pending_review",
    "featured": false,
    "takenDown": null,
    "cover": null,
    "category": {
      "id": 7,
      "name": "Cloud",
      "slug": "cloud"
    },
    "author": {
      "id": 4,
      "name": "Yacine Merabet",
      "title": "Systems & Kernel Lead"
    },
    "wordCount": 44,
    "codeBlocks": 0,
    "readMinutes": 1,
    "revision": 1,
    "reads": 0,
    "submittedAt": "2026-11-07T16:16:23.930Z",
    "publishedAt": null,
    "createdAt": "2026-11-07T16:16:23.914Z",
    "updatedAt": "2026-11-07T16:16:23.930Z",
    "body": "## 1. Intro\nEdited text. This paragraph has enough words so the article can be submitted for review. This p...",
    "sections": [
      {
        "index": 1,
        "title": "1. Intro",
        "level": 2,
        "words": 41,
        "readMinutes": 1
      }
    ]
  },
  "reviews": []
}
```

Other author actions (no body): `POST /api/me/articles/:id/withdraw` (take back an article waiting for review), `POST /api/me/articles/:id/publish` (when `approved`), `DELETE /api/me/articles/:id` (drafts only, `204`), `GET /api/me/uploads`, `DELETE /api/me/uploads/:id` (`204`).


## Reviewer workspace (role `reviewer` or `admin`)

### `GET /api/reviews/queue`

**Who:** Reviewer &nbsp;|&nbsp; Review Queue page. `?status=assigned` (default) \| `completed` \| `returned`.

Urgent items come first. `overdue` is true when the 48h deadline has passed. `avgTurnaroundHours` is `null` until the reviewer has finished one.

Response `200`:
```json
{
  "reviewerCode": "WK-BLIDA-BGSP",
  "stats": {
    "pending": 2,
    "urgent": 1,
    "reviewedThisMonth": 2,
    "avgTurnaroundHours": 18,
    "slaHours": 48
  },
  "items": [
    {
      "assignment": {
        "id": 12,
        "dispatchId": "ITC-2026-012-QUA",
        "status": "assigned",
        "priority": "high",
        "revision": 1,
        "assignedAt": "2026-11-05T16:16:21.550Z",
        "dueAt": "2026-11-07T16:16:21.550Z",
        "overdue": true,
        "completedAt": null,
        "returnedAt": null,
        "cancelledByAdmin": false
      },
      "article": {
        "id": 13,
        "slug": "quantization-horizons-awq-vs-fp8-inference-on-edge-gpus",
        "refCode": "QUA-113",
        "kind": "article",
        "targetNode": "ITC-BLIDA-MAIN",
        "title": "Quantization Horizons: AWQ vs FP8 Inference on Edge GPUs",
        "subtitle": "Evaluating throughput thresholds, activation anomalies, and memory bandwidth bounds.",
        "tags": [
          "gpu"
        ],
        "status": "pending_review",
        "featured": false,
        "takenDown": null,
        "cover": null,
        "category": {
          "id": 4,
          "name": "AI & NLP",
          "slug": "ai-nlp"
        },
        "author": {
          "id": 4,
          "name": "Yacine Merabet",
          "title": "Systems & Kernel Lead"
        },
        "wordCount": 117,
        "codeBlocks": 1,
        "readMinutes": 1,
        "revision": 1,
        "reads": 0,
        "submittedAt": "2026-11-02T16:16:21.549Z",
        "publishedAt": null,
        "createdAt": "2026-10-31T16:16:21.549Z",
        "updatedAt": "2026-11-05T16:16:21.549Z"
      }
    }
  ]
}
```

### `GET /api/reviews/assignments/:id`

**Who:** The assigned reviewer &nbsp;|&nbsp; Review Article page: full manuscript and feedback from earlier rounds. Once the assignment is closed (decided, returned, cancelled or withdrawn) the text is no longer sent: `article.bodyHidden` is `true`, `previousReviews` is empty and `myReview` holds your own decision.

Response `200`:
```json
{
  "reviewerCode": "WK-BLIDA-BGSP",
  "assignment": {
    "id": 12,
    "dispatchId": "ITC-2026-012-QUA",
    "status": "assigned",
    "priority": "high",
    "revision": 1,
    "assignedAt": "2026-11-05T16:16:21.550Z",
    "dueAt": "2026-11-07T16:16:21.550Z",
    "overdue": true,
    "completedAt": null,
    "returnedAt": null,
    "cancelledByAdmin": false
  },
  "article": {
    "id": 13,
    "slug": "quantization-horizons-awq-vs-fp8-inference-on-edge-gpus",
    "refCode": "QUA-113",
    "kind": "article",
    "targetNode": "ITC-BLIDA-MAIN",
    "title": "Quantization Horizons: AWQ vs FP8 Inference on Edge GPUs",
    "subtitle": "Evaluating throughput thresholds, activation anomalies, and memory bandwidth bounds.",
    "tags": [
      "gpu"
    ],
    "status": "pending_review",
    "featured": false,
    "takenDown": null,
    "cover": null,
    "category": {
      "id": 4,
      "name": "AI & NLP",
      "slug": "ai-nlp"
    },
    "author": {
      "id": 4,
      "name": "Yacine Merabet",
      "title": "Systems & Kernel Lead"
    },
    "wordCount": 117,
    "codeBlocks": 1,
    "readMinutes": 1,
    "revision": 1,
    "reads": 0,
    "submittedAt": "2026-11-02T16:16:21.549Z",
    "publishedAt": null,
    "createdAt": "2026-10-31T16:16:21.549Z",
    "updatedAt": "2026-11-05T16:16:21.549Z",
    "body": "## 1. Context\n\nEvaluating throughput thresholds, activation anomalies, and memory bandwidth bounds. This wr...",
    "sections": [
      {
        "index": 1,
        "title": "1. Context",
        "level": 2,
        "words": 32,
        "readMinutes": 1
      }
    ]
  },
  "previousReviews": [],
  "myReview": null
}
```

### `POST /api/reviews/assignments/:id/decision`

**Who:** The assigned reviewer &nbsp;|&nbsp; `decision` is `approve` or `request_changes`; feedback is required (10+ characters) for `request_changes`.

Request body:
```json
{
  "decision": "request_changes",
  "feedback": "Please list the GPU model and driver versions used."
}
```

Response `201`:
```json
{
  "review": {
    "id": 12,
    "decision": "changes_requested",
    "feedback": "Please list the GPU model and driver versions used.",
    "reviewerCode": "WK-BLIDA-BGSP",
    "createdAt": "2026-11-07T16:16:23.940Z"
  },
  "articleStatus": "changes_requested"
}
```

### `POST /api/reviews/assignments/:id/return`

**Who:** The assigned reviewer &nbsp;|&nbsp; "Outside My Expertise // Reassign". Not a rejection: the manuscript goes back to the admin queue.

Request body:
```json
{
  "reason": "This is deep network engineering, outside my expertise.",
  "suggestedExpertise": "Networking / Cloud infrastructure"
}
```

Response `200`:
```json
{
  "returned": true,
  "articleStatus": "pending_review",
  "message": "The manuscript is back in the admin queue for reassignment."
}
```


## Editorial board (role `admin`). No screens in the design for these

### `GET /api/admin/queue`

**Who:** Admin &nbsp;|&nbsp; Articles waiting for a reviewer (with the reason if a reviewer sent them back) and reviews in progress.

Response `200`:
```json
{
  "unassigned": [
    {
      "article": {
        "id": 14,
        "slug": "automating-multi-region-wireguard-mesh-networks",
        "refCode": "AUT-114",
        "kind": "article",
        "targetNode": "ITC-BLIDA-MAIN",
        "title": "Automating Multi-Region WireGuard Mesh Networks",
        "subtitle": "Dynamic topology negotiation using custom etcd state syncing and automated MTU discovery.",
        "tags": [
          "wireguard"
        ],
        "status": "pending_review",
        "featured": false,
        "takenDown": null,
        "cover": null,
        "category": {
          "id": 7,
          "name": "Cloud",
          "slug": "cloud"
        },
        "author": {
          "id": 6,
          "name": "Mehdi Kadri",
          "title": "DevOps Guild"
        },
        "wordCount": 116,
        "codeBlocks": 1,
        "readMinutes": 1,
        "revision": 1,
        "reads": 0,
        "submittedAt": "2026-11-03T16:16:21.551Z",
        "publishedAt": null,
        "createdAt": "2026-11-01T16:16:21.551Z",
        "updatedAt": "2026-11-06T16:16:21.551Z"
      },
      "lastReturn": {
        "reviewerId": 3,
        "reviewerCode": "WK-BLIDA-BGSP",
        "cancelled": false,
        "reason": "This is deep network engineering, outside my expertise.",
        "suggestedExpertise": "Networking / Cloud infrastructure",
        "returnedAt": "2026-11-07T16:16:23.947Z"
      }
    }
  ],
  "inReview": []
}
```

### `GET /api/admin/reviewers`

**Who:** Admin &nbsp;|&nbsp; People who can be assigned a manuscript, with their workload.

Response `200`:
```json
{
  "reviewers": [
    {
      "id": 1,
      "name": "ITC Admin",
      "email": "admin@itc.local",
      "role": "admin",
      "title": "Editorial Board",
      "bio": "",
      "reviewerCode": "WK-BLIDA-463V",
      "createdAt": "2026-08-09T16:16:21.452Z",
      "openAssignments": 0
    }
  ]
}
```

### `GET /api/admin/reviews/verify`

**Who:** Admin &nbsp;|&nbsp; Checks the signature of every stored review (add `?articleId=` for one article). A review changed directly in the database shows up in `invalid`.

Response `200`:
```json
{
  "checked": 12,
  "valid": 12,
  "invalid": []
}
```

### `POST /api/admin/articles/:id/assign`

**Who:** Admin &nbsp;|&nbsp; Give a pending article to a reviewer (priority `normal` or `high`; deadline = 48h).

Request body:
```json
{
  "reviewerId": 2,
  "priority": "high"
}
```

Response `201`:
```json
{
  "assignment": {
    "id": 15,
    "articleId": 14,
    "reviewerId": 2,
    "priority": "high",
    "assignedAt": "2026-11-07T16:16:23.966Z",
    "dueAt": "2026-11-09T16:16:23.966Z",
    "status": "assigned"
  }
}
```

Other admin actions: `POST /api/admin/assignments/:id/cancel` (body `{ "reason" }` optional), `POST /api/admin/articles/:id/publish`, `POST /api/admin/articles/:id/unpublish` (takedown, body `{ "reason" }` optional: the article goes back to `approved`, `article.takenDown` shows when and why, and **only an admin** can publish it again; the author gets `409`), `POST /api/admin/articles/:id/feature` (`{ "featured": true }`), `PATCH /api/admin/articles/:id/ref-code` (`{ "refCode": "RFC-1049-DZ" }`), `POST /api/admin/categories` (`{ "name" }`), `GET /api/admin/users`, `PATCH /api/admin/users/:id` (`{ "role": "reviewer" }`; demoting a reviewer automatically takes back their open assignments), `POST /api/admin/users/:id/reset-password`. Each returns the updated object.


## Errors

Every error has the same shape. `details` only appears for validation errors (one message per field).

**400 validation** (`400`)
```json
{
  "error": {
    "code": "validation_error",
    "message": "Validation failed",
    "details": {
      "name": "must be at least 2 characters",
      "email": "must be a valid email address",
      "password": "must be at least 8 characters"
    }
  }
}
```

**401 not signed in** (`401`)
```json
{
  "error": {
    "code": "unauthorized",
    "message": "Authentication required"
  }
}
```

**403 wrong role** (`403`)
```json
{
  "error": {
    "code": "forbidden",
    "message": "This action requires the role: admin"
  }
}
```

**404 not found** (`404`)
```json
{
  "error": {
    "code": "not_found",
    "message": "Article not found"
  }
}
```

**409 not allowed in the current state** (`409`)
```json
{
  "error": {
    "code": "invalid_status",
    "message": "An article that is \"pending_review\" cannot be submitted"
  }
}
```

Common `code` values: `busy` (503, PDF generation is busy: try again), `storage_full` (507), `validation_error`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `invalid_status`, `article_locked`, `edit_conflict`, `already_assigned`, `conflict_of_interest`, `assignment_closed`, `email_taken`, `rate_limited` (also sends `Retry-After`), `upload_limit`, `upload_in_use`, `ref_code_taken`.
