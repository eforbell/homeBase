# Home Base Milestone 3 — UI Redesign Plan

## Context

Home Base has proven its capabilities (bootstrap, install, backup, restore) across multiple fresh VM rehearsals. Per `docs/next-phase-roadmap.md`, we've reached Milestone 3: **turn the raw operator console into a calm, guided, appliance-like interface**. The current UI is a single giant page with every form and button visible at once — useful for development, but not viable for anyone beyond the builder. The goal is "more App Store than Dev Console."

The sibling apps (familyPulse, familyDinner) have established a proven multi-page pattern with reactive nav bars (IIFE `nav.js` → sidebar on desktop, bottom bar on mobile). Home Base will adopt that same pattern.

**Key architectural constraint:** Home Base uses raw `http.createServer` with zero npm dependencies. We will add a minimal static file server rather than introduce Express.

---

## Files to create

```
public/
  style.css          Shared design system (CSS variables + components)
  theme.js           Dark mode stub (dark-only for now, structured for future light)
  nav.js             IIFE nav bar (sidebar desktop / bottom bar mobile)
  api.js             Shared fetch utility (getJson, postJson, escapeHtml, formatTimestamp)
  index.html         Dashboard page
  dashboard.js       Dashboard controller
  apps.html          App list + catalog page
  apps.js            Apps controller
  app.html           App detail page (reads appId from URL path)
  app-detail.js      App detail controller
  jobs.html          Job history page
  jobs.js            Job list controller
  job.html           Job detail page (reads jobId from URL path)
  job-detail.js      Job detail controller (migrated from renderJobPage)
  setup.html         First-run wizard
  setup.js           Setup wizard controller
  settings.html      Homebase configuration + admin actions
  settings.js        Settings controller
```

## Files to modify

- **`src/app.js`** — Replace `renderHomePage`/`renderJobPage` HTML routes with static file serving; add `GET /api/homebase/config`; add setup-redirect middleware for page routes
- **`src/ui.js`** — Remove entirely once migration is complete
- **`test/server.test.js`** — Update 2 tests that assert on server-rendered HTML content

---

## Phase 0: API + migration contract lock (required before UI coding)

### 0.1 Home Base config contract (read/write)

Current state is env-driven (`src/config.js`) and immutable at runtime. Before shipping page forms that edit config, define:

- Source of truth (persisted state record vs env file write-through)
- Writable fields (hostname, domain, git transport, ssh key path only)
- Validation rules (hostname/domain format, git transport enum)
- Read endpoint: `GET /api/homebase/config`
- Write endpoint: `POST /api/homebase/config`
- Runtime semantics: whether edits are immediate for new jobs or require restart

### 0.2 App detail action contract

`app-detail.js` proposes **Backup / Restore / Update / Restart** actions. Current server API supports install/backup/restore but not generic app restart/update endpoints.

Choose one path before implementing UI:

1. Add endpoints:
   - `POST /api/apps/:id/restart`
   - `POST /api/apps/:id/update`
2. Or adjust UX labels to existing behavior (for example "Deploy latest" / "Re-run install plan")

### 0.3 Setup redirect contract

Do not gate redirect solely on "no bootstrap plans + no installations". That can misclassify host state.

Define a deterministic predicate based on current signals:

- Always exclude `/setup`, `/api/*`, and static assets from redirect
- Redirect only when host is not operationally ready (for example missing core preflight checks and no installed apps)

### 0.4 Preflight severity map for nav status

`/api/preflight` does not currently include severity levels. Define a static client/server severity map:

- **critical** checks (e.g. `os`, `sudo`, `systemd`, `nginx-config`, `postgres-service`)
- **warning** checks (e.g. tailscale, optional transport checks)

Nav status color logic:
- green = all pass
- yellow = warning failures only
- red = any critical failure

---

## Phase 1: Foundation

### 1.1 Static file server in `src/app.js`

Add a `serveStaticFile(res, filePath)` function (~30 lines):
- `fs.createReadStream` to pipe the file
- MIME map: `.html` → `text/html`, `.css` → `text/css`, `.js` → `application/javascript`, `.svg` → `image/svg+xml`
- Directory traversal prevention (normalize path and ensure it stays under `public/`)
- Explicit file-extension allowlist for static serving
- 404 fallback if file doesn't exist
- Cache headers: HTML no-cache; static assets short cache (or conservative no-cache for first cut)

Add a helper: `servePublicPage(res, page)` that calls `serveStaticFile(res, path.join(__dirname, '..', 'public', page))`.

### 1.2 Route restructuring in `src/app.js`

Replace the two existing HTML routes and add new ones. Place HTML routes **before** API routes:

```
GET /              → public/index.html
GET /apps          → public/apps.html
GET /apps/:id      → public/app.html        (match /apps/<not-api>)
GET /jobs          → public/jobs.html
GET /jobs/:id      → public/job.html         (match /jobs/<digits>)
GET /setup         → public/setup.html
GET /settings      → public/settings.html
```

Static asset fallback after all named routes: any `GET` for an allowlisted file in `public/` (`.css`, `.js`, `.svg`, `.png`) is served from disk.
Define trailing-slash behavior (`/apps/` → `/apps` or same page) and unknown page behavior (404 vs redirect to `/`).

Remove `require('./ui')` and the calls to `renderHomePage` / `renderJobPage`.

### 1.3 New API endpoint: `GET /api/homebase/config`

Returns non-sensitive config for the client to display/edit:
```json
{
  "hostname": "sh-test-clean",
  "domain": "example.ts.net",
  "gitTransport": "ssh-key",
  "serviceUser": "sovereign",
  "baseInstallDir": "/opt/sovereign-home/apps",
  "baseBackupDir": "/var/lib/sovereign-home/backups",
  "port": 3080,
  "hostnameIsPlaceholder": true
}
```
`hostnameIsPlaceholder` is `true` when hostname is still `"homebase"` — drives the warning banner.

### 1.4 `public/style.css` — Design system

Extract and extend the inline CSS from current `ui.js`. Structure:

```css
/* Reset & base */
/* CSS variables (existing palette + new tokens) */
:root {
  --bg: #0b1220;  --surface: #111b2e;  --surface2: #1a2740;
  --input-bg: #08101c;  --border: #24324b;  --border-strong: #38507a;
  --accent: #3559e0;  --text: #e5eef9;  --muted: #9fb0cf;
  --link: #9cc2ff;
  --green: #22c55e;  --yellow: #eab308;  --red: #f87171;
  --green-soft: rgba(34,197,94,.12);
  --yellow-soft: rgba(234,179,8,.12);
  --red-soft: rgba(248,113,113,.12);
  --radius: 14px;  --radius-sm: 10px;
}

/* Typography */
/* Card component: .card */
/* Buttons: .btn, .btn-primary, .btn-danger, .btn-ghost */
/* Status: .status-dot, .status-dot--green/yellow/red */
/* Badges: .badge, .badge--running, .badge--completed, .badge--failed */
/* Form elements: input, select, textarea */
/* Pre/code blocks */
/* Grid utilities */
/* Nav shell: .hb-app-sidebar, .hb-app-bottom-bar (mobile-first) */
/* Page layout: body.app-has-nav */
/* @media (min-width: 980px) { sidebar visible, bottom bar hidden } */
```

Follow familyDinner's `fd-` prefix convention → use `hb-` prefix for nav components.

### 1.5 `public/nav.js` — IIFE reactive nav bar

Follow the familyDinner pattern (`familyDinner/public/nav.js`):

- Read `data-nav-page` from `<body>` to set active state
- 4 nav items: Dashboard (`/`), Apps (`/apps`), Jobs (`/jobs`), Settings (`/settings`)
- Sidebar on desktop (fixed left, 212px): Home Base branding + nav items
- Bottom bar on mobile: 4 items, no "More" sheet needed (only 4 items)
- Status dot: fetch `/api/preflight` → green if all pass, yellow if some fail, red if critical checks fail. Cache in `sessionStorage` for 30s.
- SVG inline icons for each nav item (home, package, list, gear)

### 1.6 `public/theme.js` — Dark mode stub

Simple IIFE: set `data-theme="dark"` on `<html>`. Expose `window.HomeBaseTheme` for future light mode.

### 1.7 `public/api.js` — Shared utilities

IIFE exposing `window.HB`:
- `HB.getJson(url)` — fetch GET, parse JSON, throw on error
- `HB.postJson(url, payload)` — fetch POST, parse JSON, throw on error
- `HB.escapeHtml(value)` — reuse from current `ui.js`
- `HB.formatTimestamp(iso)` — friendly relative time ("2 hours ago", "Apr 15, 12:37")
- `HB.statusBadge(status)` — returns HTML for a status badge span

---

## Phase 2: Core pages

Every page uses this HTML skeleton:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#0b1220">
  <title>Page - Home Base</title>
  <link rel="stylesheet" href="/style.css">
  <script src="/theme.js"></script>
</head>
<body data-nav-page="PAGE_ID">
  <div id="app"><!-- page content --></div>
  <script src="/api.js"></script>
  <script src="/nav.js"></script>
  <script src="/page-controller.js"></script>
</body>
</html>
```

### 2.1 `job.html` + `job-detail.js` — Job detail (build first)

Smallest page, most direct migration from `renderJobPage`. Validates the entire static pipeline.

- Read job ID from `window.location.pathname.split('/')[2]`
- Fetch `/api/jobs/{id}` on load
- Render: step summary (from parsed `planJson`), status badge, timestamps, plan/result cards, log `<pre>`
- Auto-refresh every 1.5s while status is `queued` or `running`
- "Back to Jobs" link

### 2.2 `jobs.html` + `jobs.js` — Job list

- Fetch `/api/jobs` on load
- Render as card list: job ID (linked to `/jobs/{id}`), kind, target, status badge, created timestamp
- Auto-refresh while any job is running/queued

### 2.3 `apps.html` + `apps.js` — App management (biggest UX win)

**Installed apps** (top section):
- Fetch `/api/state` for installations + `/api/catalog` for metadata
- Compact cards: app name, status indicator, port, `[Open ↗]` link, `[Backup]` button, last backup info
- Each card links to `/apps/{appId}` for detail

**Available to install** (collapsed `<details>` below):
- Filter catalog to show uninstalled apps
- Each card: name, purpose, runtime, `[Install]` button
- Install button reveals inline form: mount path, port, dry-run/execute

### 2.4 `app.html` + `app-detail.js` — App detail

- Read app ID from `window.location.pathname.split('/')[2]`
- Fetch `/api/state`, `/api/catalog`, `/api/apps/{id}/backups`
- Header: name, status, port, route, external URL `[Open ↗]`
- Action buttons: Backup, Restore (with backup picker), plus **Update/Restart only if corresponding API endpoints exist**
- Info: version/ref, service name, timestamps
- Backup history list
- Advanced `<details>`: manifest details, service unit info

### 2.5 `index.html` + `dashboard.js` — Dashboard (build last, most complex)

Lifecycle-aware states. Fetch `/api/state`, `/api/homebase/status`, `/api/preflight`, `/api/homebase/config` in parallel.

**State A — Not installed as service** (`homebaseStatus.paths.serviceFileExists === false`):
- "Welcome to Home Base" hero card
- Single CTA: install-self form (port, confirm) or link to `/settings`
- Nothing else visible

**State B — Installed, not bootstrapped** (no installations, no bootstrap plans):
- Checklist card: ✓ Home Base running / ○ Host not bootstrapped / ○ No apps installed
- "Begin host setup →" CTA linking to `/setup`
- Preflight summary below

**State C — Operational** (apps installed):
- System health card: preflight summary, hostname display
- Warning banner if `hostnameIsPlaceholder` is true
- Installed apps grid: compact cards (name, status, backup age, Open link) → link to `/apps/{id}`
- Recent jobs (last 5): kind, status, created → link to `/jobs/{id}`
- "Install another app →" link to `/apps`
- State polling while jobs are running

---

## Phase 3: Setup wizard + Settings

### 3.1 `setup.html` + `setup.js` — First-run wizard

Does NOT appear in the nav bar (`data-nav-page` omitted or special value).

Client-side step machine with progress indicator. Steps:

1. **Welcome** — what Home Base does, what we'll set up. `[Get started →]`
2. **Preflight** — fetch `/api/preflight`, show check results with pass/fail icons and hints. `[Continue →]` (enabled when os+sudo+systemd pass)
3. **Configure** — hostname, domain, git transport inputs. Pre-fill from `/api/homebase/config`. Save calls `POST /api/homebase/config`. `[Save & continue →]`
4. **Bootstrap** — `[Run bootstrap →]` button. Creates job, shows live log via polling. Auto-advances on success.
5. **Tailscale** — reminder to run `sudo tailscale up`. `[I've done this →]`
6. **Done** — "Your server is ready." `[Go install apps →]` links to `/apps`

### 3.2 `settings.html` + `settings.js` — Configuration + admin

- **Config section**: hostname, domain, git transport, SSH key path (editable form from `/api/homebase/config`)
- **Preflight detail**: full check list with pass/fail and hints
- **Home Base management**: Install-self form (moved from dashboard), Update-self form, current service status from `/api/homebase/status`

### 3.3 Setup redirect middleware in `src/app.js`

For page routes (`/`, `/apps`, `/settings`, `/jobs`): apply the Phase 0 redirect predicate (readiness + installations). Skip redirect for `/setup`, `/api/*`, static assets. Follow the bugBase `PAGE_BOOTSTRAP_TARGETS` pattern.

---

## Phase 4: Cleanup

### 4.1 Remove `src/ui.js`

Delete the file and the `require('./ui')` line from `app.js`. The `renderHomePage`, `renderJobPage`, helper functions, and all inline CSS/JS are fully replaced by the `public/` files.

### 4.2 Update tests in `test/server.test.js`

Two tests assert on server-rendered HTML content:

1. **"home page exposes setup links for onboarding-aware installed apps"** (line 56) — currently checks `GET /` HTML for "Set up household" text. Replace with: assert `GET /` returns 200 with `content-type: text/html`, and add a new assertion that `/api/state` installations contain the expected `externalUrl` values.

2. **"job detail page renders successfully"** (line 296) — currently checks `GET /jobs/{id}` for "Job #" and "Back to Home Base". Replace with: assert `GET /jobs/{id}` returns 200 with `content-type: text/html`.

Add new tests:
- Static asset serving returns correct MIME types (`.css`, `.js`)
- `/api/homebase/config` returns expected shape
- Setup redirect fires according to the finalized readiness predicate
- Config write endpoint validates and persists only allowed fields
- Unknown static path and directory traversal attempts are rejected

---

## Build order

1. **Phase 0** (contract lock) — config API semantics, app actions scope, redirect predicate, preflight severity map
2. **Phase 1** (foundation) — static server + style.css + nav.js + theme.js + api.js + route restructuring
3. **Phase 2.1** `job.html` — smallest page, validates pipeline end-to-end
4. **Phase 2.2** `jobs.html` — simple list, exercises api.js
5. **Phase 2.3** `apps.html` — biggest UX improvement (replaces button wall)
6. **Phase 2.4** `app.html` — per-app detail
7. **Phase 2.5** `index.html` — lifecycle dashboard (most complex, but other pages provide nav)
8. **Phase 3** — setup wizard + settings + redirect middleware
9. **Phase 4** — remove ui.js, update tests

---

## Verification

After each phase:
- `node --test` passes (currently 26 tests)
- Manual browser check: navigate to each page, verify nav active state, verify API data renders
- Test mobile viewport (responsive nav: sidebar → bottom bar)
- After Phase 2.5: verify all three dashboard states (A/B/C) by toggling server state
- After Phase 3: fresh-install flow works end-to-end through wizard
- After Phase 4: `grep -r 'renderHomePage\|renderJobPage' src/` returns nothing

Migration safety checks:
- `/api/*` response shapes remain backward-compatible during UI migration
- Existing install/backup/restore job flows still execute from API without UI regressions

---

## Implementation kickoff checklist (next commit sequence)

1. **Contract commit (Phase 0)**  
   - Add `GET /api/homebase/config` + `POST /api/homebase/config` with field validation and persistence strategy
   - Decide and codify app action scope (add restart/update APIs or defer buttons)
   - Add setup redirect predicate helper + preflight severity helper
   - Add tests for config shape/write validation + redirect predicate

2. **Static shell commit (Phase 1)**  
   - Add static file server + allowlist + path normalization + cache headers
   - Add `public/style.css`, `theme.js`, `api.js`, `nav.js`
   - Add route mapping for new page shells (`index.html`, `jobs.html`, `job.html` minimal first)

3. **Page migration commits (Phase 2+)**  
   - Migrate `job` → `jobs` → `apps` → `app` → `dashboard`
   - Then setup wizard + settings
   - Remove `src/ui.js` last
