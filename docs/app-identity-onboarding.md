# Onboarding an app into suite identity

How to take an app that Home Base already installs and make it trust the household member's tailnet identity through [sovereignAuth](https://github.com/eforbell/sovereignAuth), instead of its own passphrases or PINs. Written from the first two apps that did it, Family Plan and Family Pulse, for whoever does the next one: a person or an agent picking the work up cold.

**Before you start, read:**
- sovereignAuth's [wire contract](https://github.com/eforbell/sovereignAuth/blob/main/docs/wire-contract.md), sections 1 to 5 at least, and section 8 (assurance) and section 10 (OAuth) if your app needs them. It is the contract. This guide is the practice.
- [executor-app-runbook.md](executor-app-runbook.md): how an app gets into Home Base's catalog at all. This guide assumes the app already installs, updates, backs up and restores under the executor.
- [suite-identity-rollout-runbook.md](suite-identity-rollout-runbook.md): what the operator does to a host before any app can switch. Know which part of the rollout your work depends on.

**Reference implementations.** Read them side by side with this guide:

| | Family Plan | Family Pulse |
|---|---|---|
| Class | low-friction, shared hostname | sensitive, its own hostname |
| Identity module | `familyPlan/lib/suite-identity.js` | `familyPulse/lib/suite-identity.js` |
| Socket listen | `familyPlan/server.js` (end of file) | `familyPulse/lib/listen.js` |
| Member linking | `public/link.html`, `db/migrations/005-suite-member-link.sql` | `lib/routes/suite-links.js`, `public/link.html` |
| Passkeys | none (policy `use-app`) | `public/passkey.js`, `RECENT_ROUTES` |
| External callbacks | Google Calendar OAuth | Plaid OAuth (`lib/routes/link.js`, `public/oauth-return.html`) |
| Home Base PRs | homeBase #37, #38 | homeBase #46 |

## 1. What "done" looks like

An onboarded app runs in exactly one of two modes, from `SOVEREIGN_AUTH_MODE` in its `.env`:

- **`local`**: its own sign-in, exactly as before. Every install starts here, and every host that never cuts over stays here forever. Nothing in this guide may change local mode's behavior.
- **`tailnet`**: nginx tells the app who is asking (identity headers), the app looks that person up in the household directory Home Base publishes (the snapshot), and the directory's role decides what they may do. No passphrase, no PIN, no picker.

The administrator switches an app between them on Home Base's Network page. The executor writes the mode into `.env` and restarts the app. The app never decides its own mode, and nobody edits these keys by hand.

Done means all of this holds:
- [ ] The app listens on its own Unix socket under Home Base, so nothing but nginx and the app's own Unix user can reach it (section 2: for a low-friction app, that user is shared).
- [ ] In tailnet mode it refuses to start on a bad configuration, instead of starting open.
- [ ] Every request but health probes and static assets needs a household member with access to this app, linked to one of the app's own people.
- [ ] The directory's role (parent or kid), read on every request, decides what they may do. The app's own stored role never grants anything.
- [ ] Writes come only from the app's own origin, as JSON. A sensitive app also refuses every request from a sibling hostname's page.
- [ ] A sensitive app asks parents for a passkey, as sovereignAuth's policy matrix says.
- [ ] External callbacks (OAuth) follow the contract's three steps.
- [ ] Local mode is unchanged, its credentials kept, so **Return to its own sign-in** works.
- [ ] Home Base's catalog says `runtime.identity: 'tailnet'`, and the switch has been proven on a test host and walked by the operator.

## 2. Decide the app's class first

Everything else follows from this. Ask the household's administrator if it's unclear: it is a security decision, not a code one.

| | Low-friction | Sensitive |
|---|---|---|
| Examples | dinner, calendar, fasting, help desk | finance, estate documents, trading, Bitcoin accounting |
| Hostname | shared: `https://<instance>-home.<tailnet>/<app>/` | its own: `https://<instance>-<key>.<tailnet>/<app>/` |
| Catalog | `runtime.listen: 'unix'` | also `network.dedicatedHostname: true` |
| Unix user | shared `sovereign` | its own `sovereign-<key>`; the operator moves an existing install before the switch |
| Request guard | mutation guard only (`isolate: false`) | resource isolation and mutation guard |
| Passkeys | none (`use-app`: the tailnet identity is enough) | yes: a session policy to open it, recent checks for risky actions |
| Kids | as the app decides | no passkeys (D7), so kids get an explicit allowlist of routes |

All service hostnames in a tailnet are one browser *site*, because `ts.net` is a public suffix. SameSite cookies give no isolation between apps. That is why the guards exist and why a sensitive app needs its own hostname.

**The socket boundary is the Unix user.** Each app's socket directory is `2750 <app user>:www-data`: nginx (through `www-data`) and the app's own user can connect, nobody else. Low-friction apps all run as the shared `sovereign` user, so each of them can connect to the others' sockets and send identity headers of its choosing. That is an accepted trust boundary: the low-friction apps trust each other. It is exactly why a sensitive app must run as its own user before it may switch, and why you must not classify an app as low-friction to avoid that move.

## 3. Work in slices, in this order

Each slice is its own small PR, mergeable alone, and none of them changes behavior on a host until the last one. Family Pulse took eight PRs this way. Splitting by slice kept every review small and let production pick up each piece safely.

| # | Slice | Repo | Behavior change on a live host |
|---|---|---|---|
| 1 | Listen on `SOVEREIGN_LISTEN` | app | none until Home Base sets it |
| 2 | Catalog: `runtime.listen: 'unix'`, `APP_PUBLIC_URL` | Home Base | the app moves to its socket on its next update |
| 3 | Identity module: gate and guards, behind the mode | app | none: local mode unchanged |
| 4 | Member linking | app | none in local mode |
| 5 | Directory roles replace local sign-in | app | none in local mode |
| 6 | Passkeys (sensitive apps) | app | none in local mode |
| 7 | External callbacks (if any) | app | none in local mode |
| 8 | Catalog: `runtime.identity: 'tailnet'` | Home Base | the Network page offers the switch |

Slice 8 goes **last**, after every app slice is merged and deployed. An app on its socket but older than slice 3 would accept the switch and ignore it: not unsafe, but the Network page would say tailnet while the app still asks for a passphrase.

## 4. Slice 1: listen on the socket

Rules (also in [executor-app-runbook.md](executor-app-runbook.md), section 3):
- `SOVEREIGN_LISTEN=unix:<path>`: bind that socket. Set at all, even blank, it must name a socket. A blank value never quietly falls back to TCP.
- Remove a stale socket left by the previous run, but only a socket: any other file at that path is an error.
- `chmod 0660` the socket after binding, so nginx's group can connect. The directory (`2750 <app user>:www-data`, made by Home Base) decides who else can.
- Without `SOVEREIGN_LISTEN`, listen on `HOST`, defaulting to `127.0.0.1`. Never `0.0.0.0`.
- Load `.env` **before** deciding where to listen. Bitcoin Accounting's launcher loaded it only on import, so it ignored the socket and started on TCP.
- A socket has no peer address. Anything keyed on the client address (rate limits, logs) reads `X-Forwarded-For`, trusting one hop (Express `trust proxy` 1).
- Keep every path unchanged. nginx decides whether the mount (`/pulse/`) is stripped.

Copy `familyPulse/lib/listen.js` for Node. The Python listeners (`helm/src/python/schwab_helm/web/listen.py`, `bitcoinAccounting/src/python/web/listen.py`) still treat a blank `SOVEREIGN_LISTEN` as TCP, which the rule above forbids: fix that before copying either.

## 5. Slice 2: Home Base catalog, socket and address

In `src/catalog.js`, the app's entry:

```js
runtime: {
  // ...
  listen: 'unix',
},
network: {
  // ...
  dedicatedHostname: true,        // sensitive apps only
},
config: {
  env: {
    // ...
    APP_PUBLIC_URL: '{{externalUrl}}',
  },
},
```

- `APP_PUBLIC_URL` is the app's own address as members open it, ending in its mount path (`https://<instance>-pulse.<tailnet>/pulse/`). The app checks every write's `Origin` against it in tailnet mode. It is re-rendered on every update, which is how it follows the host's cutover: **the cutover itself doesn't rewrite apps' `.env` files**, so after a cutover each app needs an ordinary update to learn its new address. The executor refuses the tailnet switch until `APP_PUBLIC_URL` is exactly that address.
- Update the tests that pin each app's layout and environment: `test/identity-mode.test.js` and `test/fixtures/env/legacy-golden.json` (every entry of the app gains the new key).

## 6. Slice 3: the identity module

### 6.0 Add the library

```json
"dependencies": {
  "sovereign-auth": "github:eforbell/sovereignAuth#<commit>"
}
```

Pin a commit, not a branch: hosts install it with no GitHub credentials and no registry. Commit the updated `package-lock.json`, and check that `npm ci --omit=dev` (the catalog's install command) still works from a clean checkout. The library is plain CommonJS for **Node 22 or later**, with no build step and no install scripts. When it changes, move the pin deliberately, in its own PR, and run the app's tests against it.

**Python apps can't onboard yet.** sovereignAuth is Node only. A Python port must pass the same conformance vectors (`vectors/`) before Helm or Bitcoin Accounting can use it; until then they can take the socket (slice 1) and nothing more.

One module, `lib/suite-identity.js`, owns everything about who is asking. Its factory runs once at startup and returns middleware. Copy the shape of Family Pulse's.

### 6.1 Check the configuration at startup

`createSuiteIdentity(env)` reads the mode and, in tailnet mode, **refuses to start** on:
- a mode other than `local` or `tailnet` (sovereignAuth's `createIdentity` throws; an unset mode means `local`, for installs from before the switch existed);
- tailnet mode without `SOVEREIGN_LISTEN` naming a socket (also `createIdentity`): the identity headers are trustworthy only because nothing but nginx can connect;
- `SOVEREIGN_HOMEBASE_UID` that isn't a positive uid (never root): the snapshot reader trusts files owned by that user only;
- `APP_PUBLIC_URL` that isn't `https:` with a plain path (`/^\/(?:[A-Za-z0-9._~-]+\/)*(?:[A-Za-z0-9._~-]+)?$/`). Redirects are built on that path, so `//elsewhere/` would send the browser off the host.

An app that starts open on a typo is the worst outcome. Starting not at all is loud, and **Return to its own sign-in** fixes it.

### 6.2 Middleware order

```js
const suite = createSuiteIdentity(process.env, { findLinked });
app.use((req, res, next) => suite.guard(req, res, next));          // method and headers only: before any body parser
app.use((req, res, next) => suite.requireMember(req, res, next));  // who is asking, and may they
// ...body parsers, then routes
```

In local mode both are pass-throughs, and local mode's existing sign-in runs as before. Wrap them in closures as above if tests rebuild `suite` with a different environment.

### 6.3 The request guard

```js
const { createRequestGuard, guardExpress } = require('sovereign-auth');
const origin = new URL(env.APP_PUBLIC_URL).origin;

// Sensitive: resource isolation and mutation guard.
const writes = guardExpress(createRequestGuard({ origin }), { mode: 'enforce' });
// Routes that take uploads accept multipart too; the Origin check still applies.
const uploads = guardExpress(createRequestGuard({ origin, contentTypes: ['application/json', 'multipart/form-data'] }), { mode: 'enforce' });
// Low-friction on the shared hostname: mutation guard only.
const shared = guardExpress(createRequestGuard({ origin, isolate: false }), { mode: 'enforce' });
```

- Skip the guard only for Home Base's health and readiness paths. Home Base probes them over the socket through the executor, with no identity headers and no fetch metadata.
- Every write is JSON from the exact origin. **Every write your pages send must say `Content-Type: application/json`, even one with no body** (a `DELETE`, a `POST` that only triggers something). Family Pulse's pages sent several without it; they worked in local mode and were refused in tailnet mode. Make the pages' fetch helper send it by default, find the direct writes (grep for `fetch(`, `<form`, `FormData`, `XMLHttpRequest`), and add a test that fails when a page write forgets it (Pulse: `test/page-writes.test.js`).
- Isolation refuses a request with no `Sec-Fetch-Site` header. Browsers always send it to secure origins. The guard checks headers, not the transport: a request over the socket is refused the same way. Only Home Base's health and readiness probes are exempt, by path. In tailnet mode every other client is a member's browser; a script or sidecar that needs the app's API (an MCP server, say) is outside this scheme and needs its own design.

### 6.4 Who is asking

```js
const { member, reason } = identity.identify(req.headers);
```

`member` is `{ memberId, userId, login, name, role, status, epoch, apps }` or null. Answer each `reason` with a page a person can act on, never a stack trace:

| Situation | Status | Says |
|---|---|---|
| `no_snapshot` | 503 | can't check who you are right now; try again, then tell whoever runs Home Base |
| any other null member | 403 | this app doesn't know you yet; ask whoever runs Home Base for access |
| member, not linked, not a parent | 403 | ask a parent to link you |
| linked to a parent's row, but a kid now | 403 | ask a parent to link you again |

API paths get JSON (`{ error, code }`); page paths get a small HTML page with the member's name. Send `Cache-Control: no-store` on every refusal.

### 6.5 Open paths, and nothing else

Open without a member: the health and readiness paths, and static assets by an exact pattern (`/^\/[\w.-]+\.(?:css|js|svg|ico|png|woff2?)$/`, reads only). Everything else needs a member. Pages are not assets: an HTML page with data in it goes through the gate.

### 6.6 Match routes the way your framework does

**This was the most serious defect found in this work.** Express routes a path in another letter case, or with a trailing slash, to the same handler. A check that compared `req.path` exactly, to decide something was *not* an API path, let other spellings through to the handler without the check. The rule:
- **A check that refuses** must see every spelling that reaches the route: lower-case it and drop trailing slashes (`routeSpelling`) before testing.
- **An allowlist that admits** stays exact. A spelling it doesn't know is refused.
- Test both directions: every refusal in another letter case, with a trailing slash, with encoded dot segments, and with a doubled slash.

### 6.7 Reads change nothing

A sibling hostname can navigate to your app with the member's identity (a link, an `<a target>`). So:
- `GET` and `HEAD` have no side effects. Anything that acts is a `POST`.
- A page never acts on load from its URL parameters (the one exception is an OAuth callback, section 10).
- Your JSON API is for your own pages. Refuse an API request whose `Sec-Fetch-Mode` is `navigate`, except the few routes a link may open directly (Family Pulse: attachment downloads).

## 7. Slice 4: member linking

The directory knows household members; your app knows its own people (Family Pulse's `family_members` rows, with their history). A parent links each one, once.

- Migration: a nullable, **unique** column on the app's people table, `suite_member_id TEXT UNIQUE`. Idempotent like every migration.
- `findLinked(memberId)` returns the row linked to a directory member, or null. Pass it to `createSuiteIdentity`.
- A `/link` page and `GET /api/suite/links`, `PUT /api/suite/links/:id`, for **parents only, by the directory's role**. The page lists the directory members who have access to this app (`directory()`: active, this app in `apps`, never `tagged-devices`) beside the app's people.
- A kid's account never takes a parent's row: a kid's pages show the data of the row they're linked to. Enforce it in the `UPDATE`'s `WHERE`, not only in the page.
- A parent nobody has linked yet may reach only the link page, its API, and first-run setup while the app has no household. Every other page redirects (303) to `<mount>link`. Make sure setup's own endpoints refuse once a household exists, and that no setup or status endpoint an unlinked parent can reach reveals anything about the household's data.
- Log each link change with who made it (the member ID, never a name).

## 8. Slice 5: the directory's role replaces local sign-in

- In tailnet mode set the app's request user from the linked row, but take the **role from the directory, on every request**. The directory can make a parent a kid at any time after the link was made.
- Kids get an explicit allowlist of method and route pairs. Everything else is refused, API with 403 JSON, pages with a redirect to the kid's page. Each allowed route must already scope its answer to the requesting member on the server.
- Local sign-in routes (`POST /api/auth/login`, passphrase changes) answer `409` in tailnet mode. Don't delete the saved passphrases or PINs: they are the rollback.
- The page that used to show a login or picker redirects to the app.
- `/api/auth/me` (or equivalent) says `tailnet: true`, so the pages hide sign-out and passphrase settings.

## 9. Slice 6: passkeys (sensitive apps)

The policy matrix is sovereignAuth's `src/policy.json`. The app names a policy key; the level, credential kind and window come from the matrix, never from the app.

```js
const assurance = createAssurance({ appId, hostname, identity, log });
const decision = await assurance.check('open-documents', { method: req.method, url: req.originalUrl, headers: req.headers });
```

- Run it for parents only (kids have no passkeys), after the member and link checks.
- A session policy to open the app (Pulse: `open-documents`, 30 days per device). Recent policies (a check in the last five minutes) for risky changes: linking external accounts (`link-account`), exports and anything that redirects money or alerts (`export-data`), changing who is linked to whom (`change-role`). Match them on the route's spelling, by prefix, so a route added later under them is covered.
- A refused **page** GET gets a small HTML page that loads `public/passkey.js`. That script loads Home Base's `/_sovereign/auth/stepup.js` from the same hostname, runs the check and reloads. A refused **API** call gets the library's `401` JSON, and the page's fetch wrapper runs the check and retries. Share one check per batch of parallel requests, and guard against a reload loop.
- Passkeys are enrolled only on Home Base's own hostname. On your hostname, `/_sovereign/auth/` serves checks and nothing else.

Prove it in a real browser with a virtual authenticator (Chrome DevTools Protocol `WebAuthn.addVirtualAuthenticator`). Unit tests can't show that the page reloads into the right state.

## 10. Slice 7: external callbacks (OAuth)

The one place an app acts on URL parameters. Contract, section 10. sovereignAuth's `createOAuthFlow` implements the three steps:
1. a guarded `POST` starts the flow, bound to the member and this hostname (a `__Host-` cookie, 10 minutes, its hash stored);
2. the provider's redirect lands on a page that **changes nothing**;
3. that page posts back once, same-origin, carrying the cookie.

What Family Pulse learned:
- **A public callback arrives with no identity and no cookie.** If the provider's redirect URI goes through a public tunnel (cloudflared) instead of the tailnet, the callback has no member. Exempt only the exact callback and return-page spellings from the member and passkey checks, reads only. The callback redirects to a static return page on the app's own hostname, whose same-origin request does carry the member and the cookie.
- **Resume is read-only.** It finds the pending link by cookie, member, hostname and age, and returns it. It never binds a link to a parameter from the URL: a crafted link could poison it.
- **Finishing takes the link conditionally**: one `UPDATE … WHERE started_by = $member AND hostname = $host`, so another member, or a guessed ID (IDs are serials), burns nothing.
- Clear the cookie at the entry of every finishing handler.
- Plaid Link uses a **popup** for OAuth banks on desktop and in mobile browsers, so the redirect URI is used only inside webviews (an iOS wrapper). Test both paths: the popup on desktop, and the redirect with a webview user agent.
- **Provider registration is the operator's call.** A provider may not separate sandbox from production redirect URIs (Plaid doesn't), so registering a test host's address may be unacceptable. Make the redirect URI an operator setting that updates keep (`preserveExistingKeys`, section 11.2), and never force a re-registration on update.

## 11. Slice 8: Home Base catalog, the switch

### 11.1 The catalog entry

```js
runtime: {
  // ...
  listen: 'unix',
  identity: 'tailnet',   // requires listen: 'unix'
},
```

That is all Home Base needs. What the executor checks before it writes `SOVEREIGN_AUTH_MODE=tailnet` (`app.set-identity-mode` in `executor/handlers.js`):
- the catalog says `identity: 'tailnet'`;
- the app's `.env` has `SOVEREIGN_LISTEN` set to its socket;
- a sensitive app already runs as `sovereign-<key>` (moved on its app page);
- the host is cut over and the directory snapshot is in place;
- `APP_PUBLIC_URL` equals the app's address on its service hostname (an update after the cutover writes it).

A restore keeps the current `APP_PUBLIC_URL` and the current mode, never the backup's.

### 11.2 The reinstall contract will surprise you

`src/operations/env.js` re-renders every templated key on every update, unless it is kept. Read its header. Kept: keys in `config.preserveExistingKeys`, empty-template keys, `{{secret…}}`, database wiring, operator-added keys, and keys whose **name** matches `SECRET|TOKEN|PASSWORD|PASSPHRASE|API_KEY|CLIENT_SECRET|CLIENT_ID|AUTH_`.

- Any setting the operator chooses (sandbox vs production, a registered redirect URI) goes in `preserveExistingKeys`. An update reset the test host's `PLAID_ENV` from `sandbox` to `production` before Pulse's entry listed it.
- Don't rely on the name pattern. `PLAID_OAUTH_REDIRECT_URI` was kept only because `OAUTH_` happens to contain `AUTH_`. `GOOGLE_REDIRECT_URI` is not kept: an update after a cutover rewrites Family Plan's Google callback to the new hostname, and the operator must register it with Google.
- A test that renders the app's `.env` before and after cutover, and an update that keeps a hand-set value, pins all of this (`test/identity-mode.test.js`, "Family Pulse is told its own address…").

### 11.3 Docs

Add the app to the tailnet identity row in [executor-app-runbook.md](executor-app-runbook.md), and to the rollout runbook if it needs anything an operator must do (a provider callback, a move to its own user).

## 12. Testing

### 12.1 In the app

- A fake snapshot reader (pass `reader` to `createSuiteIdentity`) and requests with identity headers. Never stand up Home Base for unit tests.
- Every refusal reason, every open path, each kid allowlist entry and a route just outside it, each passkey policy, every guard refusal (no Origin, other origin, `text/plain`, form post, missing fetch metadata on a sensitive hostname).
- Path spellings (section 6.6) for every check that refuses.
- Startup refusals: each bad configuration in section 6.1 throws.
- Local mode unchanged: the existing suite passes untouched.
- **Mutation-test the gate.** Break each check by hand, one at a time, in a scratch worktree, and confirm a test fails. Pulse's gate slices ran 19 to 26 mutants each; an uncaught one means a missing test.

### 12.2 In a real browser

Run the app in tailnet mode over HTTPS in Chromium (Playwright), with a throwaway certificate and `*.test` hostnames (`--host-resolver-rules`). **Chromium sends fetch metadata only to secure origins**, so plain HTTP tests the wrong thing. A stand-in tunnel for a public callback must be HTTPS too. Check at 390 px wide as well: members use phones and an iOS wrapper.

Never publish the screenshots: seed data and test databases carry real-looking names.

### 12.3 On the test host

Deploy the app's branch and Home Base's branch to the test VM, then:
1. Update the app from Home Base. Check its `.env`: `SOVEREIGN_LISTEN`, `APP_PUBLIC_URL` on the service hostname, `SOVEREIGN_AUTH_MODE=local`, operator settings kept.
2. Switch it to tailnet (Network page, or the executor's `identity-mode` action from a root shell on the test host only).
3. Probe from a tailnet device. Through nginx a request needs fetch metadata, as a browser sends it:
   ```sh
   curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' \
     -H 'Sec-Fetch-Site: none' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: document' \
     https://<instance>-<key>.<tailnet>/<app>/
   ```
   Send each header once: a duplicated `Sec-Fetch-Site` is malformed and refused, correctly.
4. Check: pages go to `/link` for an unlinked parent; a cross-site `POST` is refused; the app's mount on another service's hostname is 404; an update keeps tailnet mode and every operator setting.
5. Switch back to local, unless the operator is about to rehearse. **The Network page switch is the operator's.**

### 12.4 The operator's rehearsal

The administrator walks it on the test host before production: switch on the Network page with the hardware key, link their own member at `/<app>/link`, add a second member from the Members card, enroll that member's phone passkey with an enrollment code, link them, and use the app as each. That rehearsal is the acceptance test, and it finds what tests don't. Family Pulse's found that adding a member needed the browser console, which led to the Members card's **Add member**.

## 13. Pitfalls, collected

- A check that refuses compared paths exactly; another spelling skipped it (section 6.6).
- Pages sent writes without a JSON content type, some with no body at all; tailnet mode refused them.
- An update reset an operator's choice (`PLAID_ENV`) the catalog didn't list in `preserveExistingKeys`.
- A setting was kept only by an accident of its name (`AUTH_` in `OAUTH_`).
- The cutover doesn't update `.env` files; an app needs an update after it to learn its address.
- A setup or status endpoint an unlinked parent could reach revealed facts about the household's data.
- A kid could be linked to a parent's row, then see the parent's data.
- The directory changed a role after linking; the stored role still granted parent.
- A resume endpoint bound a pending link to a URL parameter; a crafted link could have poisoned it.
- A launcher loaded `.env` after deciding where to listen.
- Tests ran in plain HTTP and passed; Chromium sends no fetch metadata there.
- curl probes without fetch metadata got `fetch_metadata_missing`, which is correct behavior and not a bug.
- `node:test` runs `t.after` hooks first-in, first-out: a helper that sets and restores catalog state, called twice in one test, restores the wrong value.

## 14. Working rules for an agent picking this up

- One PR per repo per slice, each touching few files. The reviewer judges a PR by the files it touches.
- Never run anything against a production host, not even a read-only `curl`. The operator runs production checks and pastes the output.
- Keep the tailnet's name, node and member IDs, and any real names out of commits, PRs, docs and logs you paste. Use `smith` and `example-tailnet` as in this guide.
- Both Home Base and sovereignAuth are public repositories. Describe a security fix by what it guarantees, never with a working exploit.
- Get an independent review (a second model) of every PR before asking for a merge, and fix or answer each finding.
- Merge only when the repository's owner says so.
