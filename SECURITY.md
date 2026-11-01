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
| Streaks, badges, statistics, chain calendars, freezes (derived from check-ins) | the owner (streaks and calendars also admins) — never on the public habit record | the owner (freezes: 2 per month) |
| Reminder time of a habit (reveals a daily routine) | the owner only — not other users, not admins | the owner |
| Whom you follow | you | you |
| Who follows you | nobody — only the follower **count** is shown | — |
| Reactions | **counts** only, plus your own reactions | you, on other people's shared habits |
| Challenge leaderboard | any logged-in user: username + number of completed days in the window, only for members who explicitly consented when joining | you join / leave; admins create / delete challenges |
| Data export | the owner (attachment download) | — |

**Attackers considered:** anonymous visitors, logged-in users trying to reach other users' data or admin powers, and someone who can make a victim's browser send requests (CSRF) or render their content (XSS). Every request is assumed to come straight to the API, skipping the UI.

**Request pipeline** (`src/app.js`): security headers → body parsing (10 kB JSON limit) → **authenticate** (who are you?) → CSRF check → per-user write rate limit → route: **authorize** (may you do this, on this record?) → **validate** (is the input safe?) → handler.

## OWASP Top 10 (2025)

| # | Risk in this app | Defence — and where |
|---|------------------|---------------------|
| **A01 Broken Access Control** | IDOR (changing an id to read/edit someone else's check-in), privilege escalation to admin, reading private habits | All record rules live in one policy table, `src/middleware/authorize.js`. Routes never load a record by id themselves: `authorize('checkin','delete')` validates the id, loads the row, derives ownership from the database and returns 403/404 before the handler runs. Admin routes are guarded at router level by `requireRole('admin')` (`src/routes/admin.js`), and the role is re-read from the database on every request (`src/services/authService.js`), never taken from the token or the body. `/api/users/me` has no id parameter at all. Tests: `tests/*` "IDOR" suites. |
| **A02 Security Misconfiguration** | Missing headers, verbose errors, permissive CORS | `helmet` with a strict CSP (`script-src 'self'`, no inline script, `object-src 'none'`, `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy: no-referrer` (`src/app.js`; mirrored for CDN-served static files in `vercel.json`). No CORS headers are ever sent. The error handler returns only a status and a safe message, never stack traces or SQL (`src/middleware/errorHandler.js`). `X-Powered-By` is disabled. API responses are `Cache-Control: no-store`. |
| **A03 Software Supply Chain Failures** | Compromised or vulnerable dependencies, third-party scripts | Every dependency is pinned to an exact version with a committed `package-lock.json`. `npm audit` reports 0 vulnerabilities (the `body-parser` and `multer` denial-of-service advisories were fixed by upgrading to `body-parser` 2.4.0 and `multer` 2.5.0). Charts are plain SVG built in-house and reminders use the browser's Notification API, so no chart library, push service or other third-party code was added. No CDN scripts or fonts: fonts are self-hosted (`scripts/vendor-fonts.js`, OFL licences in `public/fonts`), so the CSP can stay `'self'`. The database driver needs no native install scripts. |
| **A04 Cryptographic Failures** | Weak password storage, forgeable sessions, secrets in the repo | bcrypt (cost 12) for passwords. Sessions are HS256 JWTs signed with a ≥32-character secret; `jwt.verify` pins the algorithm, so `alg: none` and algorithm-confusion tokens fail. The app refuses to start with a missing or placeholder secret (`src/config.js`). Cookie is `HttpOnly`, `SameSite=Strict` and `Secure` in production. Secrets live only in `.env` / Vercel's environment (git-ignored; `.env.example` has placeholders). |
| **A05 Injection** | SQL injection through search, ids or form fields; stored or reflected XSS | Every query uses `?` placeholders through `src/db/index.js`; LIKE wildcards in search are escaped (`src/routes/habits.js`). The only dynamic SQL fragments are column names taken from a strict schema's fixed key set. XSS: the frontend builds every node with `textContent` through one helper (`public/js/dom.js`) that also refuses `on*` attributes and non-relative URLs; there is no `innerHTML` anywhere. The CSP blocks inline script even if markup were injected. |
| **A06 Insecure Design** | Mass assignment (`"role":"admin"` on register), business-rule bypass, open redirects | All request schemas are strict (`src/validators/schemas.js`): unknown fields are a 400, so `role`, `user_id`, `is_admin` cannot be smuggled in. Owners are always set from the session. Business rules are enforced by the database as well (see triggers below). The login `?next=` redirect only accepts same-site page paths (`public/js/auth-stage.js`). |
| **A07 Authentication Failures** | Brute force and credential guessing (usernames such as `admin` are guessable), user/email enumeration, sessions that survive logout | Seeded accounts use 24-character random passwords (~140 bits) generated per seed run and never published. Database-backed **sliding-window** rate limits (`src/middleware/rateLimit.js`): 5 failed logins per account per IP and 50 per account per day across all IPs, 10 failed logins per IP across accounts, 30 login attempts of any kind per IP (successful ones included), plus limits on registration (20 attempts per IP per hour, 5 accounts created per IP per day) and password changes. The client IP cannot be spoofed with forwarding headers (`src/utils/clientIp.js`), and IPv6 clients are grouped by /64. Login returns the same message and similar timing for "no such user" and "wrong password" (dummy bcrypt compare). Registration only reports a taken *username* (usernames are public); emails are not unique, so the endpoint cannot confirm whether an address has an account. Each JWT is tied to a `sessions` row: logout revokes it immediately, deleting a user deletes their sessions, demoting an admin and changing a password revoke sessions too (`src/routes/users.js`, `src/routes/admin.js`). |
| **A08 Software or Data Integrity Failures** | Malicious uploads disguised as images, tampering with owned data, CSRF | Uploads are checked by content (see below). CSRF: state-changing requests need `X-Requested-With: fetch` (a header cross-site forms cannot send and cross-site `fetch` cannot send without a CORS preflight this server never approves) plus an `Origin` match (`src/middleware/csrf.js`), on top of the `SameSite=Strict` cookie. |
| **A09 Security Logging & Alerting Failures** | Admin abuse leaving no trace | Every admin sign-in, role change, user deletion and admin removal of someone else's content is written to `admin_audit_log`; changes are logged **in the same atomic batch** as the action (`src/services/auditLog.js`). The table is append-only, enforced by triggers. Unexpected server errors are logged server-side. *Gaps:* admin *reads* (viewing the user list) are not logged individually, and there is no alerting pipeline — known limitations of a course project. |
| **A10 Mishandling of Exceptional Conditions** | Crashes or partial writes revealing data or leaving inconsistent state | Async errors in Express 5 handlers reach one central handler. Multi-step writes (delete a user with all their data, change a password and revoke sessions, delete a habit with its check-ins) run as single atomic batches. Malformed JSON, oversized bodies, bad ids and failed uploads map to 400/404/413/415 without leaking internals. |

## Project-specific protections

- **Admin action audit log.** `admin_audit_log` records who did what to whom and when; it survives the deletion of the users it mentions (no foreign keys) and cannot be edited or deleted (triggers `admin_audit_log_no_update` / `_no_delete` in `src/db/schema.sql`). Visible to admins at `/admin.html`.
- **Database-backed sliding-window rate limiting.** Counters live in the `rate_limit_windows` table; each request is one atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING` that keeps the current and previous window's counts. The effective count weights the previous window by how much of it still overlaps, so bursting at a window boundary does not double the budget, and limits hold across serverless cold starts and instances. Failed-login limiters refund successful requests.
- **Unspoofable client IP.** On Vercel the IP comes only from `x-vercel-forwarded-for` / `x-real-ip`, which the platform sets itself after discarding client-supplied values; locally every forwarding header is ignored and the TCP peer is used. Express's `trust proxy` is off. Tested by rotating `X-Forwarded-For`, `X-Real-IP` and `X-Vercel-Forwarded-For` on every failed login (`tests/bruteforce.test.js`).
- **Upload validation by magic bytes** (`src/middleware/upload.js`). Files are kept in memory only (1 MB, one file, one field). The type is decided from the first bytes of the content (JPEG, PNG or WebP); the filename, extension and the client's Content-Type are ignored, so a `photo.jpg` containing PHP, HTML or SVG is rejected with 415. Photos are stored in the database, never on disk, so there is no file path to traverse. They are served only through `GET /api/checkins/:id/photo` after the same ownership check as the check-in, with a fixed whitelisted `Content-Type`, `nosniff`, `Content-Disposition: inline` with a server-generated filename and a sandboxing CSP.

- **Content Security Policy (CSP).** The application enforces a restrictive Content Security Policy to protect against cross-site scripting (XSS), unauthorized resource loading, and unsafe content embedding.
  - **Scripts and styles:** JavaScript and CSS are restricted to the application's own origin (`script-src 'self'` and `style-src 'self'`). Inline scripts and inline event handlers are not permitted.
  - **Fonts and images:** Fonts are served from the application's own origin. Images are restricted to the same origin and permitted blob URLs.
  - **Embedded maps:** The Contact page uses an OpenStreetMap iframe to display a clearly identified demonstration location in Bucharest. The `frame-src` directive explicitly permits the application's own origin and `https://www.openstreetmap.org`. Other external iframe sources remain blocked.
  - **Framing protection:** The `frame-ancestors 'none'` directive prevents other websites from embedding Habit Tracker in an iframe.
  - **Third-party privacy:** Loading the OpenStreetMap iframe sends browser requests to an external service. This integration is disclosed in the Privacy Policy.
  - **Deployment consistency:** CSP settings are configured in `src/app.js` and mirrored in `vercel.json` for static files served through Vercel.
  These restrictions preserve the application's security protections while allowing the explicitly approved OpenStreetMap integration.
- **Database triggers as a second line of defence** (`src/db/schema.sql`), so even an application bug cannot break these rules:
  - `users_keep_last_admin_on_update` / `_on_delete` — the last admin can never be demoted or deleted, even by two admins acting at the same moment (SQLite serializes writes).
  - `checkins_owner_must_match` — a check-in's `user_id` must equal its habit's owner.
  - `checkins_owner_immutable` — a check-in can never be moved to another habit or user.
  - `admin_audit_log_no_update` / `_no_delete` — the audit log is append-only.
  - plus `CHECK` constraints on roles, categories, lengths, dates and photo types, and `UNIQUE(habit_id, checkin_date)` for one check-in per habit per day.
- **Admins cannot change their own role or delete themselves**, and the app returns 409 when an action would leave no admin.
- **Account names are not published, and they are not the defence.** The README lists no usernames; the seed prints them once together with passwords that are random per run and handed to the evaluator privately. The names are still readable in `scripts/seed-data.js`, so the defence is the password strength, the login limits and the audit trail — not secrecy of a username or of `/admin.html`. Even with valid admin credentials, an account gets exactly the admin powers above and nothing more (`tests/admin-hardening.test.js`): there is no endpoint to set another account's password or to act as another user, identity always comes from the session, tokens carry no role, and every admin sign-in and action is audited. If an admin account is abused, the other admin can demote it — which revokes all of its sessions at once — or delete it. Failed logins by others cannot lock the owner out: 5 failures lock an account only for the address they came from (15 minutes), and over the 50-a-day account limit, networks the owner signed in from successfully in the last 30 days stay exempt (stored only as an HMAC). `npm run unlock -- <username>` clears an account's counters and is recorded in the audit log as `cli`. The limits of this exemption are listed under [Limits, edge cases and operations](#limits-edge-cases-and-operations).
- **Hidden admin panel link — defence-in-depth, not obscurity.** No page links to `/admin.html` and the page is `noindex`. This only reduces how visible the panel is; it is **not** what protects it. The page itself contains no data, and every admin API endpoint checks the caller's role in the database and answers 403 to anyone else (tested in `tests/admin.test.js`). Someone who guesses the URL gains nothing.
- **Text hygiene.** Free-text fields reject control characters and Unicode bidi overrides (text-spoofing) in addition to length limits.

## Security design of the newer features

Each feature was added only in a form that does not widen the attack surface; where a common design would have, a safer one was chosen instead.

- **Reminders without Web Push.** Push would make the server send requests to subscription URLs supplied by browsers (an SSRF-shaped surface) and depend on third-party push services. Reminders run in the open page instead (`public/js/reminders.js`): a system notification if the user allowed them, otherwise a toast. No service worker. The reminder time is serialized for the owner only.
- **Atomic allowances and caps.** Streak freezes (2 per user per month), follows (500), habits (100 per user, create and copy) and the measurable-habit `+1` are each a single `INSERT … SELECT … WHERE (count) < limit` or upsert, so parallel requests cannot exceed a limit or lose an update (`tests/schedule.test.js`, `tests/habits.test.js`, `tests/checkins.test.js`).
- **Following grants no access.** The feed only filters habits that are already public; check-ins stay private. Public profiles exist only for people who share at least one habit (404 otherwise), so user ids cannot be walked to list every username; profile lookups are also rate limited. Follower lists are never exposed (`src/routes/social.js`, `tests/social.test.js`).
- **Challenges.** Created by admins only (no user-generated challenge spam), audited in the same batch. Joining requires `share_progress: true`; leaderboard rows contain a username and a day count only. A trigger (`challenge_member_owns_habit`) and the route both require the linked habit to be the member's own (`tests/challenges.test.js`).
- **Badges** are computed from the user's own numbers on every request; nothing is stored, so there is no endpoint to claim one.
- **Export** (`GET /api/users/me/export`) contains only the caller's data and no photo bytes or password hash; it is an attachment with `nosniff` and a sandboxing CSP; CSV cells starting with `= + - @`, tab or CR are prefixed with `'` (CSV/formula injection); 10 exports per hour per user.
- **Reordering** (`PUT /api/habits/order`) must list exactly the caller's active habits and every `UPDATE` is also scoped to `user_id`.
- **Archived habits** are read-only (policy): no check-ins, freezes, reactions or copies.
- **Strict numbers.** Amounts accept a JSON number or a string of digits only (no booleans or exponents that a blanket coercion would allow); schedules are a strict discriminated union; years, ranges and formats are allow-listed.
- **More database triggers:** `freezes_owner_must_match`, `challenge_member_owns_habit`, plus `CHECK` constraints on every new column. `src/db/migrations.js` adds new columns to databases created by an older schema (tested against the first-release schema in `tests/fixtures/schema-v1.sql`).
- **Heavier reads are rate limited:** statistics and year calendars (300 / 10 min per user), public profiles (120 / 10 min).
- **Theme script.** `public/js/theme.js` is a same-origin classic script, so the CSP still allows no inline script.

## Limits, edge cases and operations

The limits below protect the service, and each has a cost for legitimate users. This section lists where they stop helping and what an operator does about it.

### Account lockout: where the exemption stops

Over the per-account daily limit (50 failed logins from all addresses together), a login is still let through when it comes from a **network the owner signed in from successfully in the last 30 days** (`isTrustedLoginIp` in `src/middleware/rateLimit.js`). A "network" is an IPv4 address or an IPv6 /64, stored only as an HMAC. The exemption does **not** help in these cases:

- **A new network or device.** An owner who has never signed in successfully from that address is limited like everyone else. This covers a new phone, a hotel or a different Wi-Fi network, and mobile data, where the IPv4 address often changes. While someone keeps the account over its daily limit, the owner can sign in only from a known network, or after `npm run unlock` (below).
- **The 30-day window.** A network not used for a successful sign-in in 30 days is forgotten. Each account keeps at most 10 networks; an 11th replaces the one used least recently.
- **`JWT_SECRET` rotation.** The HMAC key is derived from `JWT_SECRET`, so rotating it drops every remembered network (and signs everyone out). After a rotation, each owner has to sign in once more from each network.
- **Unknown addresses.** When the client address cannot be read (`clientIp()` returns `'unknown'`), the request is never remembered as a network and never gets the exemption. Such requests would otherwise all share one "network".

Only the daily per-account limit has this exemption. The other limits always apply, including from a known network: 5 failed logins per account per address per 15 minutes, 10 failed logins per address per 15 minutes, and 30 login attempts per address per 15 minutes.

### Shared networks (NAT, CGNAT, VPN, campus)

The exemption belongs to the **network, not the person**. Everyone behind the same public address shares it: a home or office router (NAT), a mobile carrier's CGNAT, a VPN exit, a university or campus network. Someone on the owner's network therefore also bypasses the 50-a-day account limit. They are still held by the per-address limits, which allow at most about 480 guesses per day against one account from one address, instead of 50.

The answer is a **strong password**, not a tighter limit. Passwords must be at least 8 characters with a letter and a digit; seeded accounts use 24 random characters. A password with enough entropy is not found at a few hundred guesses per day. Admin accounts in particular should use a long random password from a password manager.

### Daily registration limit and shared networks

At most `REGISTER_DAILY_LIMIT` accounts (default **5**) can be created from one address (IPv6: /64) per day. Only accounts actually created count; typos and taken usernames do not. Like the login exemption, this limit belongs to the **network**: all people behind one NAT, CGNAT, VPN exit or campus network share the same 5 accounts per day. A 6th person gets a 429 saying that too many accounts were created from this network.

**Before an event where many people sign up from the same network** (a class, a workshop, a hackathon), raise `REGISTER_DAILY_LIMIT` in the Vercel project's environment variables **in advance**. Vercel applies a changed variable only to new deployments, so redeploy after changing it. Lower it again after the event.

### Operations: admins and lockouts

- **Before a critical period** (a demo, an exam, a release), each admin should **sign in once from every network and device they will use**: home, office, phone on mobile data, the venue's Wi-Fi. That puts each of those networks in the admin's trusted list for 30 days, so a lockout campaign against the admin account cannot keep them out. Remember the limit of 10 networks per account.
- **If an account is locked anyway**, run:

  ```sh
  npm run unlock -- <username> --remote
  ```

  This needs the production `DATABASE_URL` and `DATABASE_AUTH_TOKEN` in the environment; without `--remote` the script refuses to touch a remote database. It clears only that account's failed-login counters: the daily per-account counter and the per-account-per-address counters. No password, session or role changes. Each run is written to `admin_audit_log` with actor `cli`. The per-address limits (10 failed and 30 total logins per 15 minutes) are not cleared; they expire on their own within 15 minutes.

### Proof-photo storage: per-user quota and service-wide cap

- **Per photo:** at most 1 MB, JPEG, PNG or WebP, checked by content. The check-in form resizes photos in the browser to 1280 px on the long edge (JPEG quality 0.8) before uploading.
- **Recent days only:** a photo can be added for the last 7 days only. A check-in with a photo cannot be moved to an earlier date outside that window.
- **Upload rate:** 20 photo uploads per hour per user.
- **Per user:** `PHOTO_QUOTA_MB` (default **25 MB**) for all of a user's photos together. Above it, a new photo gets **409** asking the user to remove an old one.
- **Service-wide:** `PHOTO_TOTAL_CAP_MB` (default **1024 MB**) for all users together. It is checked against the one-row `photo_storage` counter, which triggers keep up to date. Both limits are checked inside the write statement, so parallel uploads cannot exceed them.

**When the service-wide cap is full**, only **new photo uploads and photo replacements** are refused, with **507** and the message "Photo uploads are paused because storage is full". Nothing else changes: check-ins without a photo, existing photos, removing photos, comments, statistics and every other feature keep working.

**What an admin does:**

1. Open `/admin.html` and look at **Photo storage**. It shows the counter against the cap and warns from 90%. It also lists the 10 accounts storing the most, with their share of the per-user quota (`GET /api/admin/photo-storage`, admins only).
2. If the space is filled by **abuse** (for example many new accounts created to upload photos), delete those accounts from the user table. Deleting an account removes its check-ins and photos in one atomic batch, the counter goes down immediately, and the deletion is recorded in the audit log.
3. If the growth is **legitimate**, raise `PHOTO_TOTAL_CAP_MB` in Vercel and redeploy, staying within the database plan's storage. Alternatively, lower `PHOTO_QUOTA_MB` for future uploads; existing photos are kept.

### Deploy checklist

1. **Environment variables in Vercel** (Project → Settings → Environment Variables → Production), in addition to the required `JWT_SECRET`, `DATABASE_URL` and `DATABASE_AUTH_TOKEN`. Set them explicitly, so the running limits do not depend on code defaults changing:

   | Variable | Default | Allowed | Meaning |
   |----------|---------|---------|---------|
   | `PHOTO_QUOTA_MB` | 25 | 1–1024 | Proof-photo storage per user |
   | `PHOTO_TOTAL_CAP_MB` | 1024 | 1–1048576 | Proof-photo storage of all users together |
   | `REGISTER_DAILY_LIMIT` | 5 | 1–1000 | Accounts created per address per day |

   A value outside the allowed range stops the app at start-up with an error naming the variable. Vercel applies a change only to new deployments: redeploy after every change.
2. **After the deploy, check caching.** HTML, JS and CSS must be revalidated by the browser (`vercel.json`), and API responses must not be cached:

   ```sh
   curl -sI https://<domain>/ | grep -i '^cache-control'                  # no-cache
   curl -sI https://<domain>/js/pages/habit.js | grep -i '^cache-control' # no-cache
   curl -sI https://<domain>/api/auth/me | grep -i '^cache-control'       # no-store
   ```

   While you are there, confirm that the static responses still carry `content-security-policy`, `strict-transport-security` and `x-content-type-options: nosniff`.

## Reporting

This is a course project. Report issues privately to the repository owner rather than in a public issue.
