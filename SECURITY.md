# Security

Threat model and defences for Habit Tracker. Every claim points at the code that enforces it; the automated tests in `tests/` exercise each one.

## What is sensitive, and who may see it

| Data | Who may read | Who may change |
|------|--------------|----------------|
| Password hashes, session tokens | nobody (never sent to clients) | the account owner (password change) |
| Email address | the owner and admins | — |
| Check-ins, notes and proof photos (F5) | the habit owner and admins — even when the habit is public | the owner; admins may delete |
| Private habits | the owner and admins | the owner; admins may delete |
| Public habits | any logged-in user | the owner; admins may delete |
| Comments (F6) | anyone who can read the habit | the author edits; author, habit owner or admin deletes |
| User roles, user list, audit log | admins | admins (never their own role; never the last admin) |

**Attackers considered:** anonymous visitors, logged-in users trying to reach other users' data or admin powers, and someone who can make a victim's browser send requests (CSRF) or render their content (XSS). Every request is assumed to come straight to the API, skipping the UI.

**Request pipeline** (`src/app.js`): security headers → body parsing (10 kB JSON limit) → **authenticate** (who are you?) → CSRF check → per-user write rate limit → route: **authorize** (may you do this, on this record?) → **validate** (is the input safe?) → handler.

## OWASP Top 10 (2025)

| # | Risk in this app | Defence — and where |
|---|------------------|---------------------|
| **A01 Broken Access Control** | IDOR (changing an id to read/edit someone else's check-in), privilege escalation to admin, reading private habits | All record rules live in one policy table, `src/middleware/authorize.js`. Routes never load a record by id themselves: `authorize('checkin','delete')` validates the id, loads the row, derives ownership from the database and returns 403/404 before the handler runs. Admin routes are guarded at router level by `requireRole('admin')` (`src/routes/admin.js`), and the role is re-read from the database on every request (`src/services/authService.js`), never taken from the token or the body. `/api/users/me` has no id parameter at all. Tests: `tests/*` "IDOR" suites. |
| **A02 Security Misconfiguration** | Missing headers, verbose errors, permissive CORS | `helmet` with a strict CSP (`script-src 'self'`, no inline script, `object-src 'none'`, `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy: no-referrer` (`src/app.js`; mirrored for CDN-served static files in `vercel.json`). No CORS headers are ever sent. The error handler returns only a status and a safe message, never stack traces or SQL (`src/middleware/errorHandler.js`). `X-Powered-By` is disabled. API responses are `Cache-Control: no-store`. |
| **A03 Software Supply Chain Failures** | Compromised or vulnerable dependencies, third-party scripts | Every dependency is pinned to an exact version with a committed `package-lock.json`; `npm audit` reports 0 vulnerabilities. No CDN scripts or fonts: fonts are self-hosted (`scripts/vendor-fonts.js`, OFL licences in `public/fonts`), so the CSP can stay `'self'`. The database driver needs no native install scripts. |
| **A04 Cryptographic Failures** | Weak password storage, forgeable sessions, secrets in the repo | bcrypt (cost 12) for passwords. Sessions are HS256 JWTs signed with a ≥32-character secret; `jwt.verify` pins the algorithm, so `alg: none` and algorithm-confusion tokens fail. The app refuses to start with a missing or placeholder secret (`src/config.js`). Cookie is `HttpOnly`, `SameSite=Strict` and `Secure` in production. Secrets live only in `.env` / Vercel's environment (git-ignored; `.env.example` has placeholders). |
| **A05 Injection** | SQL injection through search, ids or form fields; stored or reflected XSS | Every query uses `?` placeholders through `src/db/index.js`; LIKE wildcards in search are escaped (`src/routes/habits.js`). The only dynamic SQL fragments are column names taken from a strict schema's fixed key set. XSS: the frontend builds every node with `textContent` through one helper (`public/js/dom.js`) that also refuses `on*` attributes and non-relative URLs; there is no `innerHTML` anywhere. The CSP blocks inline script even if markup were injected. |
| **A06 Insecure Design** | Mass assignment (`"role":"admin"` on register), business-rule bypass, open redirects | All request schemas are strict (`src/validators/schemas.js`): unknown fields are a 400, so `role`, `user_id`, `is_admin` cannot be smuggled in. Owners are always set from the session. Business rules are enforced by the database as well (see triggers below). The login `?next=` redirect only accepts same-site page paths (`public/js/auth-stage.js`). |
| **A07 Authentication Failures** | Brute force, user enumeration, sessions that survive logout | Database-backed rate limits on failed logins per IP and per account, on *all* login attempts per IP (so the public demo passwords cannot be used to mint sessions without limit), registration and password-change attempts (`src/middleware/rateLimit.js`). Login returns the same message and similar timing for "no such user" and "wrong password" (dummy bcrypt compare). Each JWT is tied to a `sessions` row: logout revokes it immediately, deleting a user deletes their sessions, and a password change signs out all other sessions (`src/routes/users.js`). |
| **A08 Software or Data Integrity Failures** | Malicious uploads disguised as images, tampering with owned data, CSRF | Uploads are checked by content (see below). CSRF: state-changing requests need `X-Requested-With: fetch` (a header cross-site forms cannot send and cross-site `fetch` cannot send without a CORS preflight this server never approves) plus an `Origin` match (`src/middleware/csrf.js`), on top of the `SameSite=Strict` cookie. |
| **A09 Security Logging & Alerting Failures** | Admin abuse leaving no trace | Every admin sign-in, role change, user deletion and admin removal of someone else's content is written to `admin_audit_log`; changes are logged **in the same atomic batch** as the action (`src/services/auditLog.js`). The table is append-only, enforced by triggers. Unexpected server errors are logged server-side. *Gaps:* admin *reads* (viewing the user list) are not logged individually, and there is no alerting pipeline — known limitations of a course project. |
| **A10 Mishandling of Exceptional Conditions** | Crashes or partial writes revealing data or leaving inconsistent state | Async errors in Express 5 handlers reach one central handler. Multi-step writes (delete a user with all their data, change a password and revoke sessions, delete a habit with its check-ins) run as single atomic batches. Malformed JSON, oversized bodies, bad ids and failed uploads map to 400/404/413/415 without leaking internals. |

## Project-specific protections

- **Admin action audit log.** `admin_audit_log` records who did what to whom and when; it survives the deletion of the users it mentions (no foreign keys) and cannot be edited or deleted (triggers `admin_audit_log_no_update` / `_no_delete` in `src/db/schema.sql`). Visible to admins at `/admin.html`.
- **Database-backed rate limiting.** Counters live in the `rate_limits` table and are incremented with one atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so limits hold across serverless cold starts and instances. Successful logins are refunded, so only failures count.
- **Upload validation by magic bytes** (`src/middleware/upload.js`). Files are kept in memory only (1 MB, one file, one field). The type is decided from the first bytes of the content (JPEG, PNG or WebP); the filename, extension and the client's Content-Type are ignored, so a `photo.jpg` containing PHP, HTML or SVG is rejected with 415. Photos are stored in the database, never on disk, so there is no file path to traverse. They are served only through `GET /api/checkins/:id/photo` after the same ownership check as the check-in, with a fixed whitelisted `Content-Type`, `nosniff`, `Content-Disposition: inline` with a server-generated filename and a sandboxing CSP.
- **Content Security Policy.** Scripts, styles, fonts and images only from this origin; no inline script or event handlers (all JavaScript is in `/js/*.js` and attached with `addEventListener`); framing forbidden.
- **Database triggers as a second line of defence** (`src/db/schema.sql`), so even an application bug cannot break these rules:
  - `users_keep_last_admin_on_update` / `_on_delete` — the last admin can never be demoted or deleted, even by two admins acting at the same moment (SQLite serializes writes).
  - `checkins_owner_must_match` — a check-in's `user_id` must equal its habit's owner.
  - `checkins_owner_immutable` — a check-in can never be moved to another habit or user.
  - `admin_audit_log_no_update` / `_no_delete` — the audit log is append-only.
  - plus `CHECK` constraints on roles, categories, lengths, dates and photo types, and `UNIQUE(habit_id, checkin_date)` for one check-in per habit per day.
- **Admins cannot change their own role or delete themselves**, and the app returns 409 when an action would leave no admin.
- **Public demo admin credentials.** The README publishes the seeded admin passwords on purpose, so evaluators can try every role. Knowing them grants exactly the admin powers above and nothing more (`tests/admin-hardening.test.js`): there is no endpoint to set another account's password or to act as another user, identity always comes from the session, tokens carry no role, and every admin sign-in and action is audited. If an admin account is abused, the other seeded admin can demote it — which revokes all of its sessions at once — or delete it. Known trade-off: because the per-account failed-login limit applies to public account names, anyone can temporarily lock a demo account for 15 minutes by failing its login ten times (a denial of service, outside the challenge's scope).
- **Hidden admin panel link — defence-in-depth, not obscurity.** No page links to `/admin.html` and the page is `noindex`. This only reduces how visible the panel is; it is **not** what protects it. The page itself contains no data, and every admin API endpoint checks the caller's role in the database and answers 403 to anyone else (tested in `tests/admin.test.js`). Someone who guesses the URL gains nothing.
- **Text hygiene.** Free-text fields reject control characters and Unicode bidi overrides (text-spoofing) in addition to length limits.

## Reporting

This is a course project. Report issues privately to the repository owner rather than in a public issue.
