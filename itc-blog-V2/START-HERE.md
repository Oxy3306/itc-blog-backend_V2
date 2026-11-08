# Start here (for the frontend team)

The ITC blog backend is ready for you to integrate. Everything you need is in this folder.

## What is in this folder

| File | What it is |
|------|------------|
| `API-REFERENCE.md` | **Read this first.** Every endpoint with real example responses, plus the rules that apply everywhere (sign-in, errors, paging, statuses). |
| `README.md` | Features, how the numbers in the design are calculated, backups, deployment, and the assumptions that were made. |
| `src/` | The backend code. |
| `test/` | The automated tests (`npm test`, 120 tests). |

## Run it locally

You need Node.js 22.13 or newer. In a terminal, in this folder:

1. `npm install`
2. Copy `.env.example` to `.env` (Windows CMD: `copy .env.example .env`). In `.env`, set `CORS_ORIGIN` to the address of your dev server. The default is `http://localhost:5173`; separate several addresses with commas.
3. `npm run seed` fills the database with sample data from the design.
4. `npm run dev` starts the API at `http://localhost:3000`.

Check it works: open `http://localhost:3000/api/health` in a browser. You should see `{"status":"ok", ...}`.

## Sample logins

The password for all of them is `Password123!`.

| Email | Role | Good for building |
|-------|------|-------------------|
| `yacine@itc.local` | author | My Articles and the Editor (has articles in every status) |
| `reviewer2@itc.local` | reviewer | Review Queue and Review Article (has 2 manuscripts waiting) |
| `reviewer1@itc.local` | reviewer | The same, with a different workload |
| `admin@itc.local` | admin | The admin endpoints |

The public pages (Homepage, Explore, Article Details) need no login.

## Things to know

- **No admin screens in the design.** Assigning reviewers, publishing, featuring and managing roles only work through the `/api/admin/...` endpoints for now. Until someone builds a page for them, reviewers cannot be given manuscripts from the website.
- **Login and register are a temporary implementation of ours.** They may change if ITC already has a member system, so keep your sign-in code in one place.
- **Image URLs are relative** (`/uploads/ab12.png`): put the API address in front of them.
- **Article bodies are Markdown text.** Sanitize them before rendering (for example with DOMPurify).
- **Read time, word count and the section list are calculated by the server.** Do not compute them in the browser.
- **Dates are UTC** (ISO 8601). Convert them to local time in the browser.
- **PDF downloads show Arabic text as `?`.** The website itself handles Arabic fine.

## If something does not fit a page

If a response is missing a field a page needs, or has the wrong shape, tell the backend developer which page and what is missing. It is usually a small change.
