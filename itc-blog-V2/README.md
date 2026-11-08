# ITC Blog Backend

**Frontend team: start with [START-HERE.md](START-HERE.md)**, then [API-REFERENCE.md](API-REFERENCE.md) (every endpoint with real example responses).

REST API for the ITC Club blog, built from the Figma design ("ITC blog"). Node.js + Express + SQLite.
It covers: public reading and search, author dashboard and editor, and the peer-review workflow
(reviewers, an admin queue, approve / request changes / return assignment).

## Requirements

- Node.js **22.13 or newer** (it uses the SQLite built into Node, so there is nothing native to compile).
- Check with: `node -v`

## Setup (Windows)

Terminal: **CMD**. Directory: the project folder (the one containing `package.json`).

| Step | Command | What it does | How to check |
|------|---------|--------------|--------------|
| 1 | `npm install` | Downloads the 3 dependencies | A `node_modules` folder appears |
| 2 | `copy .env.example .env` | Creates your settings file | A `.env` file appears |
| 3 | `npm test` | Runs the 120 automated tests | Ends with `# fail 0` |
| 4 | `npm run seed` | Fills an **empty** database with sample data from the design | Prints the sample accounts |
| 5 | `npm run dev` | Starts the API (restarts on file changes) | Prints `ITC Blog API running on http://localhost:3000` |

Then open `http://localhost:3000/api/health` in the browser. You should see `{"status":"ok", ...}`.

Sample accounts (after `npm run seed`, password `Password123!` for all):
`admin@itc.local`, `reviewer1@itc.local`, `reviewer2@itc.local`, `yacine@itc.local` (author with articles in every status).

To start over with fresh sample data: stop the server, delete the `data` folder, run `npm run seed` again.
That deletes all data in the database, so only do it on your development copy.

Making your first real admin: register normally, then run `npm run make-admin -- you@example.com`.

## How it works

Roles: **author** (every new account), **reviewer**, **admin** (editorial board). Anyone can read published articles.

Article lifecycle:

`draft -> pending_review -> changes_requested -> (edit, resubmit) pending_review -> approved -> published`

- Submitting needs a subtitle, a topic and at least 20 words.
- An admin assigns a reviewer (priority normal/high, 48h deadline). There is no automatic routing, as in the design.
- A reviewer can approve, request changes (feedback required, at least 10 characters), or **return** the assignment
  ("outside my expertise"): it goes back to the admin queue with the reason, and the article stays `pending_review`.
- Approved articles stay hidden until the author (or an admin) publishes them.
- Set the cover image before submitting: an article is locked while it is in review, approved or published.
- Only drafts can be deleted. Resubmitting keeps the same reference code and increases `revision`.
- Authors see review feedback with the reviewer's public code (for example `WK-BLIDA-K7QX`), never the reviewer's name. The code is
  random and is not derived from the user id, and people without published articles have no public profile, so a code cannot be
  traced back to a person.
- Once a reviewer's assignment is closed (finished, returned, cancelled or withdrawn), the reviewer keeps their own record but can no longer
  read the manuscript text: later drafts stay private.
- If an admin removes someone's reviewer role, their open assignments are cancelled automatically and the articles go back to the admin queue.
- Every review decision is stored with an HMAC signature. `GET /api/admin/reviews/verify` (optionally `?articleId=`) recomputes them
  and lists any review that was changed after it was written.
- An admin can take a published article offline (`unpublish`, with an optional reason). It then stays offline: the author sees the
  reason and cannot republish it; only an admin can publish it again.

## Authentication

Only **failed** logins are counted, so a whole campus sharing one Wi-Fi address is not locked out: 8 wrong passwords for one account
from one address (then it waits 15 minutes), 40 for one account from anywhere, 150 from one address. A correct login resets the first counter.
Creating accounts is limited to 100 per address per hour (`REGISTER_RATE_LIMIT_MAX`). The counters are stored in the database, so a server restart does not reset them. A missing, expired or bad token on a public page
is treated as an anonymous visitor.

`POST /api/auth/login` returns a `token`. Send it on protected requests as `Authorization: Bearer <token>`.
Roles are checked in the database on every request, so a role change takes effect immediately.

## Endpoints

Errors always look like `{ "error": { "code": "...", "message": "...", "details": { "field": "problem" } } }`.
Lists return `{ items, page, limit, total, hasMore }` (use `?page=2&limit=10`).

**Auth**: `POST /api/auth/register`, `POST /api/auth/login`, `GET|PATCH /api/auth/me`,
`POST /api/auth/change-password` body `{ "currentPassword", "newPassword" }` (signs out all other devices and returns a fresh token).
There is no logout endpoint: the frontend simply forgets the token.

**Public** (no login)
- `GET /api/categories` topics with article counts
- `GET /api/articles` published list. Query: `search`, `category` (slug), `author` (id), `node` (target node code), `sort` (`latest|oldest|popular|shortest`), `page`, `limit`
- `GET /api/articles/featured` homepage highlights (`?limit=` up to 6, default 2)
- `GET /api/articles/stats` Explore header: `activeTracks`, `meanReadMinutes`, `acceptanceRate`
- `GET /api/articles/:slug` article + author card + related articles (counts one read per reader)
- `GET /api/articles/:slug/downloads` the download button info: `{ pdf: { url, bytes }, markdown: { url, bytes } }` (shows "1.8 MB")
- `GET /api/articles/:slug/download` the article as a PDF (default) or `?format=md` for a Markdown file
- `GET /api/authors` members directory: everyone with at least one published article. Query: `search`, `sort` (`articles|name|recent`), `page`, `limit`
- `GET /api/authors/:id` author profile + their published articles (`404` for anyone without published articles)
- `GET /api/nodes` target nodes in use with article counts, plus the default one

**Author** (`/api/me`, any logged-in user)
- `GET /api/me/articles` my articles. Query: `status`, `search`. Includes `counts` per status and the three `stats`
- `POST /api/me/articles` create a draft (only `title` is required)
- `GET|PATCH|DELETE /api/me/articles/:id` read / save draft / delete draft
- `POST /api/me/articles/:id/submit`, `POST /api/me/articles/:id/publish`
- `POST /api/me/articles/:id/withdraw` take back an article that is waiting for review (a draft again, or "changes requested" if it already had feedback); any active reviewer assignment is cancelled
- `POST /api/me/uploads` upload an image: send the **raw bytes** as the body with `Content-Type: image/jpeg|png|webp` (max 5 MB).
  Returns `{ upload: { id, url } }`. `GET /api/me/uploads` lists mine, `DELETE /api/me/uploads/:id` removes one.
- Target node: send `targetNode` (for example `ITC-BLIDA-MAIN`, the default) when creating or saving an article.
- Cover figure: send `coverImageId` (an upload id, or `null` to remove it) and `coverCaption` when creating or saving an article.
- Autosave: send `baseUpdatedAt` (the `updatedAt` you last received) with Save Draft. If the article changed elsewhere
  (another tab or device) you get `409 edit_conflict` instead of silently overwriting it.

**Reviewer** (`/api/reviews`, reviewer or admin)
- `GET /api/reviews/queue` stat cards + assigned manuscripts (`?status=assigned|completed|returned`)
- `GET /api/reviews/assignments/:id` full manuscript + earlier feedback
- `POST /api/reviews/assignments/:id/decision` body `{ "decision": "approve" | "request_changes", "feedback": "..." }`
- `POST /api/reviews/assignments/:id/return` body `{ "reason": "...", "suggestedExpertise": "..." }`

**Admin** (`/api/admin`)
- `GET /queue` unassigned articles (with the last return reason) and active reviews
- `GET /reviewers`, `POST /articles/:id/assign` body `{ "reviewerId": 3, "priority": "high" }`
- `POST /assignments/:id/cancel` body `{ "reason": "..." }` (optional) takes a manuscript back from a reviewer who went quiet; the queue flags late ones with `overdue: true`
- `POST /articles/:id/publish` (also puts back an article that was taken down), `POST /articles/:id/unpublish` body `{ "reason": "..." }` (optional; takes the article offline and keeps it offline until an admin publishes it again), `POST /articles/:id/feature` body `{ "featured": true }`
- `GET /reviews/verify` checks the signature of every review (`?articleId=` for one article): `{ checked, valid, invalid: [...] }`
- `PATCH /articles/:id/ref-code` body `{ "refCode": "RFC-1049-DZ" }` (unique, letters/digits in dash-separated groups)
- `POST /categories`, `GET /users`, `PATCH /users/:id` body `{ "role": "reviewer" }`
- `POST /users/:id/reset-password` returns a one-time `temporaryPassword` for members who forgot theirs (there is no email service). Give it to them in person; their old sessions are signed out

## How the numbers in the design are calculated

- **Read time**: words / 200, rounded up (minimum 1). Word count and code-block count are calculated on every save.
- **Sections**: every article with a body also returns `sections` (title, level, words, `readMinutes`) built from its `#`, `##`, `###` headings, for the numbered "§ 01 // OVERVIEW  READ TIME: 3 MIN" blocks.
- **Acceptance rate**: articles that are approved or published, divided by all articles ever submitted.
- **Publish rate (My Articles)**: share of an author's reviewed manuscripts whose *first* review was an approval.
- **Avg review latency**: hours from submission to the reviewer's decision. **Community reads**: unique readers whose first visit to one of the author's published articles happened this calendar quarter. `reviewTargetHours` (default 24) is the benchmark shown under the latency card.
- **Reviewer turnaround**: hours from assignment to decision. `null` is returned when there is nothing to measure yet.

## Secrets

The secret key (`JWT_SECRET`) signs every login. Anyone who knows it can pretend to be any user, including an admin.

- Generate one (Windows CMD, any folder): `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` and put the result **only** in your private `.env` file.
- Never put it in `.env.example` (that file is shared and committed). The server refuses to start in production with a short key, a
  `change-me...` placeholder, or the same value that is written in `.env.example`.
- In development with no secret set, the server creates a private random one in `data/.jwt-secret` instead of using a value written in the code.
- If a real secret was ever committed or shared, replace it: everybody is signed out, which is expected. To keep old review signatures valid
  after replacing it, set `REVIEW_SIGNING_KEY` to `<old secret>:reviews`.

## Backups and restore

Terminal: CMD, in the project folder.

| Step | Command | Check |
|------|---------|-------|
| Make a backup | `npm run backup` | Prints `Backup saved to: ...\backups\<date>`; that folder holds `itc-blog.db` and `uploads` |
| Keep it safe | copy the folder to a USB drive or another computer | |

It is safe to run while the server is running. Do this regularly (for example before every meeting where new content is added).

To restore: stop the server, then copy `itc-blog.db` from the backup folder over `data\itc-blog.db` and **delete** `data\itc-blog.db-wal`
and `data\itc-blog.db-shm` if they exist; copy the backup's `uploads` folder over `data\uploads`. Start the server again.
Restoring replaces everything that was added after the backup was made.

## Deploying for real

- Set `NODE_ENV=production` and a random `JWT_SECRET` (32+ characters; the server refuses to start with a weak one).
- Set `CORS_ORIGIN` to the website's address, and `TRUST_PROXY=true` if the API sits behind nginx or a hosting platform (so rate limits see real visitor addresses).
- Keep the `data` folder (database + images) on a disk that survives restarts. Hosts with temporary disks will lose it.
- This is a single-process app with a file database, which is right for a club blog. If it must run on several servers, move to PostgreSQL first.
- Put HTTPS in front of it (the hosting platform or nginx), because passwords and tokens travel in requests.

## Settings (`.env`)

See `.env.example`. In production set `NODE_ENV=production` and a random `JWT_SECRET` of 32+ characters
(the server refuses to start otherwise). `CORS_ORIGIN` must be your frontend's address.

## Images

- Uploaded images are served at `/uploads/<random-name>.<ext>` (relative to the API address, e.g. `http://localhost:3000/uploads/...`).
- Inside an article body use normal Markdown: `![Figure 2: latency](/uploads/abc123.png)`. The frontend must prefix the API address.
- Only JPEG, PNG and WebP are accepted, checked by content (not just the file name). SVG is refused on purpose (it can carry scripts).
- Images used by an article that is in review or published cannot be deleted.
- Files are public to anyone who knows the (unguessable) address, including images of unpublished drafts.
- Disk limits: 50 images and 50 MB per account, 2 GB for the whole site (`MAX_UPLOADS_PER_USER`, `MAX_STORAGE_MB_PER_USER`, `MAX_TOTAL_STORAGE_MB`).

## PDF notes

- The PDF has a header (topic, reference code, title, subtitle, author, date), the cover figure, the body (headings, lists, code,
  tables, quotes, images) and a footer with page numbers.
- The built-in PDF fonts cover English and French. Arabic or other scripts show as `?` in the PDF (the web page is not affected).
  Supporting them means bundling a Unicode font file.
- PDFs are generated in a separate worker thread. A corrupt image can never crash the server; the PDF is then produced without images.
- Load limits: requests for the same PDF at the same moment share one build, 2 PDFs are built at once and 20 more may wait (others get `503 busy`),
  and finished PDFs are kept in memory up to 32 MB in total (`PDF_MAX_CONCURRENT`, `PDF_MAX_QUEUE`, `PDF_CACHE_MB`).
- WebP images are not embedded in PDFs (the PDF library cannot read them); a placeholder line is shown instead.

## Notes for the frontend

- Article bodies are Markdown text. Sanitize them when rendering (for example with DOMPurify).
- A code block with a file name, as in the design (`cache_partition_v2.go`), is a frontend convention; Markdown itself only stores the language (` ```go `).
- Read counts: a signed-in reader counts once per article; an anonymous reader is identified by network address only (stored as a hash, the browser name is ignored),
  so everyone on one shared Wi-Fi counts as one anonymous reader. Authors reading their own article are not counted.
- Not included: email notifications (an admin resets forgotten passwords by hand). Comments, likes and bookmarks are not in the design either.

## Assumptions (made without answers from the project owner)

These are best guesses. Each one is small and easy to change.

- **Target node** (editor field "ITC-BLIDA-MAIN"): treated as the ITC chapter or channel an article is published to. It is stored per
  article (default `ITC-BLIDA-MAIN`, set with `DEFAULT_TARGET_NODE`), editable while the article is a draft or has changes requested,
  and can be used as a filter. Nothing else depends on it.
- **Reviewer token** (`0x7F...C84A (Active)` on the Review Queue): not stored. The reviewer's random public code (`WK-BLIDA-K7QX`) is returned instead,
  and there is no "inactive reviewer" state.
- **Navigation** (Events, Members, Departments, Stats, About, Projects): Members maps to `GET /api/authors`, Departments to
  `GET /api/categories`, Stats to `GET /api/articles/stats`. Events, About and Projects are assumed to belong to the main ITC site,
  so the backend has nothing for them.
- **Login**: this API has its own register and login. If ITC already has a member system, replace `src/routes/auth.js`.
