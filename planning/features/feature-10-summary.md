# Feature-10: Suite Identity — Tailnet Sign-In and Passkey Step-Up

## Purpose

Give every household member one identity across all Home Base–managed apps, with no passwords to remember. The tailnet login identifies the person on every request. Sensitive apps add a passkey tap. Home Base keeps the household directory and runs the passkey service.

## Why This Is Worth Shipping

Each app has its own auth today:
- **Per-member passphrases:** finance, home ops, photos, estate documents.
- **Shared settings PINs:** help desk, calendar.
- **Single-operator passphrases:** trading, Bitcoin accounting, Home Base itself.
- **No real login at all:** dinner, fasting, help desk and calendar use a name picker, so any tailnet device can act as any member.

That's a pile of credentials for families to manage, and it still leaves the picker apps spoofable. The tailnet already authenticates each person, with the household's identity provider, MFA and its own allowlist. The suite just isn't using it.

## Trust boundaries

- **Who:** only members the administrator has admitted, matched on the tailnet's stable user ID. On every request, nginx asks Home Base to look up the caller's stable ID; if that lookup fails, the request has no identity. Tagged devices, unknown logins and externally shared users get no identity.
- **Hostnames:** low-friction apps share the suite hostname. Each sensitive app and Home Base admin gets its own hostname (a Tailscale Service), so a compromised sibling app can't drive them from a member's browser. Service names carry the household instance (`svc:<instance>-<app>`), and each service has exactly one host.
- **Ingress:** each hostname's Serve config → its own root-only nginx socket → only that hostname's allowlisted mounts → the app's own socket. nginx overwrites identity headers in every location.
- **Snapshot and tokens:** apps read the directory from a file Home Base owns and they can only read. They redeem every-time tokens over their own Home Base socket.
- **Processes:** each sensitive app runs as its own user and owns its whole footprint: code, `.env`, data, backups, dependencies. Only root, nginx and the app itself can reach it.
- **Requests:** the tailnet identity is ambient, like a cookie. Every mutation needs an exact Origin match and a JSON content type, and authorization runs before any mutation or prompt. All service hostnames are one browser site (D20), so SameSite doesn't separate them: cookies are `__Host-` and bound to their hostname, and GETs change nothing.

## Scope

1. **Identity-safe ingress (SID-001):** per-hostname sockets, header normalization in every location, on both the planner and executor paths. Rollback refuses to reopen TCP while any app trusts headers.
2. **Listen contract and ownership (SID-002):** apps on owner-restricted sockets; sensitive apps' whole ownership graph moves to their own user; each app's URI behavior is preserved.
3. **sovereignAuth core library (SID-003):** the wire contract, snapshot reader, mutation guard, assurance checks, and conformance vectors. Node first; Python when the first Python app migrates.
4. **Directory, bootstrap and recovery (SID-004):**
   - stable user IDs;
   - setup → active → recovery states, with a defined recovery exception and exit;
   - enrollment grants and a root reset CLI;
   - a snapshot with generations, member epochs and a global epoch, so revocation lands within seconds.
5. **Passkey service (SID-005):**
   - multiple credentials per member;
   - hardware keys proven by attestation to pinned vendor roots, with a policy for maintaining those roots;
   - host-scoped assurance cookies;
   - every-time tokens bound to the resolved target or frozen plan, consumed once by Home Base.
6. **Home Base admin (SID-006):** its own hostname, a route authorization matrix that covers every route, and an attested hardware key every time for administrator actions.
7. **Pilots (SID-007):** one low-friction app and the finance app as a sensitive canary.
8. **Runbook + rehearsal (SID-008):** a VM rehearsal, including an interrupted cutover and a rollback, before any production host changes.

## Assurance levels

| Level | Meaning | Used for |
|---|---|---|
| Tailnet | An admitted member's identity on the request | Low-friction apps, every request |
| Session | A passkey check within the app's window, on this hostname | Opening sensitive apps (8h Home Base admin, 24h trading and Bitcoin accounting, 30d finance and estate documents) |
| Recent | A check within 5 minutes | Linking accounts, exports, changing parent/kid, a member's own passkeys |
| Every time + hardware key | A single-use token for one exact request | Administrator actions: privileged plans, config and publishing changes, rotating secrets, administrator credentials, granting administrator |

The full matrix is `assurancePolicy` in the PRD.

## Evidence

Two spikes on a test VM (2026-10-23):
- **Serve identity:**
  - The correct login arrives from macOS, the iOS web wrapper and a kid's Windows PC.
  - Forged headers are replaced.
  - A tagged host gets no identity.
- **Passkey step-up:**
  - Works with 1Password on desktop and iPhone, as long as PRF isn't requested.
  - Works with Apple Passwords and a USB-C YubiKey.
  - The tailnet-level RP ID is accepted by Chrome and Safari.
  - Cookie and token rejection rules held.
  - A non-administrator member was refused the administrator action before any prompt.
- **Limits:**
  - Hardware classification came from flags, which isn't proof; attestation is now required.
  - Single process, single origin.
  - Parent/kid roles weren't exercised.

**Spike 3 (2026-10-25, Tailscale 1.102.4, tagged test VM, two test services):**
- **Services:** identity headers and socket targets work on Tailscale Services traffic. Each service reaches only its own socket and mounts; a hostname sent to the wrong service gets 421.
- **Forwarded headers:** Serve overwrites client-sent `X-Forwarded-For` and `X-Forwarded-Host`.
- **Identity lookup:** nginx's per-request lookup returns the stable user ID, ignores forged headers, and fails closed when the endpoint is down.
- **Local processes:** on a user-owned host, any local process reached the host's own URL as the owner (why D2 requires tagged hosts). Once the host was tagged, local requests carried no login.
- **Service takeover:** a user-owned node is refused as a service host. A second *tagged* host wasn't available; see spike 3b below.
- **Hardware keys:** a YubiKey's attestation verified against the pinned Yubico root and failed with a wrong one. A software authenticator was refused hardware under both attestation settings.
- **Cross-hostname:** reads are blocked by the browser, and a JSON post stops at the preflight. A form post reaches the app with the member's identity. The test app had no guards, so this shows what arrives; server-side refusal is tested in SID-003 and the rehearsal.

**What spike 3 changed (D20).** Every service hostname in a tailnet is the same browser *site*, because `ts.net` is a public suffix:
- A sibling hostname's requests arrive as `same-site`.
- A cookie set for the tailnet domain reaches every hostname, even with `SameSite=Strict`.

So the plan now requires:
- **Cookies:** `__Host-` assurance cookies, bound to their hostname.
- **GETs:** side-effect free. Pages also must not mutate on load from URL parameters.
- **Sensitive and Home Base hostnames:**
  - accept only same-origin requests and top-level document navigations;
  - refuse requests with missing fetch metadata;
  - send `frame-ancestors 'none'`.
- **Passkey ceremonies (D17, D21):**
  - run only on the Home Base and sensitive hostnames, never on the low-friction hostname;
  - all credential management happens on the Home Base hostname;
  - each challenge is stored with its hostname, member and purpose, and verified once.
- **OAuth callbacks (D22):** a read-only landing page, then a same-origin POST, with single-use state bound to the member and hostname. This is the only page allowed to act on URL parameters, and apps that can't follow it stay entirely in local mode.
- **Supported browsers:** Safari 16.4+ (including the iOS wrapper), Chrome/Edge 80+ and Firefox 90+. Older browsers are refused on sensitive and Home Base hostnames.

New service hostnames take 35–40 s on first use while their certificate is issued, so publishing waits for it.

**Spike 3b (2026-10-26): a second tagged node, driven with the raw Tailscale CLI.**
- **Tailnet Lock:** the node was locked out until a trusted key signed it, so a leaked auth key alone isn't enough.
- **Shared approver tag:** once signed, it was auto-approved as a hidden standby, with a valid certificate for the service hostname. It took all traffic when the real host stopped serving.
- **Tightening the policy:** switching approvers to a per-host tag **left its existing approval in place**, so it still took over. The real host lost its approvals until it had the new tag.
- **Fresh advertisement:** after withdrawing and advertising again, the node stayed unapproved and got no traffic.

The local host can't see standby hosts, and a correct policy doesn't prove there's no stale approval. So D23 decides on the service's **host list**, which the Tailscale API returns with every host and its approval level, standbys included. The check passes only if exactly one host is approved, and it's this one. A missing or partial list means unverified.

Without an API credential, the administrator confirms the same list from the console, with the hardware key. On a fresh install, only the Home Base hostname can be published before the first hardware key exists. The runbook adds:
- the order for changing the policy;
- a review of existing approvals after every change;
- Tailnet Lock.

**SID-001 rehearsal (2026-10-27, test VM, Tailscale 1.102.4).** The cutover, three published services, a rollback and a second cutover all ran through the real executor:
- **Verification:** each service verified automatically with a read-only API credential. Services, devices and policy can all be read without write scopes, which settles the open D23 question.
- **Isolation:** each address served only its own apps. Forged identity headers never reached an app, and a local process on the host got no identity.
- **Identity:** the lookup returned a member's stable ID only for their own device and login.
- **Fixed along the way:** app snippets now follow the host's ingress mode, the identity socket has its own directory, the executor accepts the new host actions, and the live API's field names are handled. Serve is changed only with `set-config --all`, because `set-raw` wipes the node's own Serve entries.

Until the household directory exists, services may be published but no app can use tailnet identity.

**SID-002 rehearsal (2026-10-28, test VM).** All four sensitive apps ended up on their own users and sockets, reached from a member device through their own service hostnames:
- **Moved in place:** Home Source, installed before SID-002, was moved to `sovereign-source` and then switched from TCP to its socket. Afterwards the shared user couldn't read its code, `.env`, data or backups, or write into its checkout; update, backup and restart still worked.
- **Fresh installs:** Pulse, Helm and Bitcoin Accounting came up on their own users. Only nginx and the app's own user could connect to each socket; the shared user, Home Base and the other apps' users were refused.
- **Both URI styles:** pages, the mount redirect, assets, nested APIs and the OAuth callback routes worked for prefix-stripping (Pulse, Home Source) and mount-preserving (Helm, Bitcoin Accounting) apps. The D22 callback contract itself is app behavior and is checked as each app enters tailnet mode.
- **Loopback:** most apps had bound every interface, so any device the policy let through could reach them around nginx. Every app now listens on loopback, and a new verification check fails when one doesn't.
- **Fixed along the way:** Bitcoin Accounting's launcher ignored its socket (it loaded `.env` too late) and its lock had no Python 3.14 wheels; an app switching listen modes kept the other mode's setting; health-page setup links still used the host name after cutover.
- **Follow-ups:** warn when no grant reaches a published service; redirect a sensitive hostname's bare `/` to its app; move sidecars (Pulse's MCP server) off loopback TCP.

**SID-002 code review (PR #16, merged 2026-10-28).** Eight rounds of external review hardened the move's root hand-over:
- **What changed:** directories are locked to root 0700 before they are read; hardlinks owned by anyone else are never copied or chowned; a root-only marker makes an interrupted move refuse every other plan and resume on a re-run; copies are staged once per tree; mounts inside an app's trees are refused, using the kernel's mount table and each directory's mount ID; restore re-applies the listen mode; timer services are stopped; the probe has a hard deadline.
- **Accepted limitation:** a root process mounting inside an app's tree while its hand-over runs. The shared user can't mount; the full fix would be a private mount namespace for the hand-over. See the runbook, section 4.

**SID-002 production rollout (2026-10-28, both production hosts, not cut over).** Every app was updated and the three sensitive apps on one host and Bitcoin Accounting on the other were moved to their own users, behind the old TCP gateway (sockets don't need the SID-001 cutover). It surfaced four bugs, all fixed:
- **False health between updates:** after Home Base updated, health asked a socket the app didn't have yet. The probe now falls back to the app's port until the app is updated (PR #17).
- **False dependency drift:** Bitcoin Accounting's lock pins numpy and contourpy per Python version, and Home Base ignored the markers. It now reads them for the venv's interpreter (PR #17).
- **Double submits:** the app page wired its forms on every refresh, so one click after a job made two backups. Pages now wire once (PR #17).
- **The move broke Helm's database login:** a move generated a fresh database password, which only an app with its own URL key (Helm's `HELM_DATABASE_URL`) actually used. An Update repaired it. The move now keeps the existing password and refuses without one (PR #18).
- **The move refused legacy data parents:** the legacy installer made `/var/lib/sovereign-home/<app>` the shared user's (0750). It was fixed by hand there; the move now takes it back for root itself, and checks before writing its marker (PR #18).

**Where Feature-10 stands after SID-002 (2026-10-28):**
- **Production:** both hosts run SID-002. Every app is on loopback, the sensitive apps are on their own users and sockets, and neither host is cut over (SID-001 cutover not run; no service names published).
- **Test VM:** cut over (instance `rehearsal`), with five services published and all five apps on SID-002. It keeps its read-only Tailscale credential for the rehearsals through SID-008.
- **Open follow-ups:**
  - Standardize Helm on `DATABASE_URL`: Helm reads it with a fallback to `HELM_DATABASE_URL`, then the catalog drops `urlEnvKey`.
  - A policy warning for a published service no grant reaches.
  - Redirect a sensitive hostname's bare `/` to its app.
  - Sidecars on sockets.
  - A private mount namespace for the move's hand-over.
  - The health message for an app on its port but not yet updated still says "socket".
- **Next:** SID-003, the sovereignAuth core library. The public repo exists and is empty. SID-003 has no dependencies; SID-004 onwards build on it.

**SID-003, the sovereignAuth core library (passing, 2026-10-29).** sovereignAuth #1-#5 hold the request guards, the snapshot reader and identity, token, assurance and step-up verification, the redemption client, the OAuth callback helper and the WebAuthn helpers, with conformance vectors for a later Python port. Home Base wires the guards and an identity preview behind flags (`HOME_BASE_REQUEST_GUARDS`, `HOME_BASE_IDENTITY_PREVIEW`, both off by default) and pins the library at `v0.1.0` (8e64765). Every PR had a Codex security review until it came back clean.
- **Proven on the test VM in enforce mode:** a credential-free install; a member resolved end to end; every sibling-hostname request refused in Home Base's log while a top-level link opens; tossed cookies ignored by the library's check; the iOS wrapper passes.
- **Found along the way:** a cached answer could bypass resource isolation (fixed with `Vary`); a Referer can't tell same-origin pages apart, so the OAuth boundary is the origin; `@simplewebauthn/server` fetches CRL URLs from client certificates for some formats, which Home Source was exposed to (bugBase #151, fixed in homeSource #46).
- **Fixed at close-out:** `GET /api/apps/health` sent health-alert webhooks, so a sibling hostname's top-level navigation could send one. The GET now only reads; alerts go out from a background check every 5 minutes while they are on. Likewise `GET /api/apps/updates` returns stored statuses and the update check is a POST.
- **Open follow-up:** health-alert and service-host alert links are built from the configured hostname, so after cutover they still point at the legacy host instead of Home Base's service hostname.
- **Moved on:** the iOS OAuth callback check and WebKit runs (SID-007), real-authenticator WebAuthn (SID-005).
- **Next:** SID-004, the Home Base directory, replacing the preview members file.

## Review

Two rounds of external plan review:
- **Round 1 (2026-10-24):** requested changes, with 9 high and 5 medium findings.
- **Round 2:** found 8 of those resolved, 6 partly resolved, and 9 new issues.

Revision 3 (2026-10-25) addresses all of them. A review of the spike-3 change (2026-10-26) requested changes (2 high, 2 medium: ceremonies on the low-friction hostname, framing, OAuth callbacks, service approval), addressed in the same PR. Its re-review found both high findings resolved and raised one new high (the planner can't see the policy, answered by D23) and two mediums (OAuth vs. the navigation rule, browser minimums). These are addressed with the spike 3b evidence. The PRD's `reviewResolution` maps each finding to the change that answers it.

## Definition of Done

- The pilot app and the finance canary run in tailnet mode. A member lands as themselves with no picker or PIN; the canary asks for a passkey tap instead of a passphrase.
- Administrator actions ask for an attested hardware key every time, and every Home Base route is in the authorization matrix.
- Forged headers, cross-site posts, sibling-hostname requests, tagged hosts and unknown logins are all refused in tests and in the rehearsal.
- Only root, nginx and the app itself can reach a sensitive app's socket, code, secrets or backups.
- Revoking a passkey or disabling a member takes effect within one snapshot interval while apps keep running.
- Home Base admin no longer needs the passphrase day to day; recovery and reset are rehearsed.
- Every app still runs standalone with its local auth when tailnet mode is off.
- The rollout runbook has been walked end to end on a test VM, including rollback.
