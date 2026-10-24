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

- **Who:** only members the administrator has admitted, matched on the tailnet's stable user ID. Tagged devices, unknown logins and externally shared users get no identity.
- **Hostnames:** low-friction apps share the suite hostname. Each sensitive app and Home Base admin gets its own hostname (a Tailscale Service), so a compromised sibling app can't drive them from a member's browser.
- **Ingress:** each hostname's Serve config → its own root-only nginx socket → the app's own socket. nginx overwrites identity headers in every location.
- **Processes:** each sensitive app runs as its own user and owns its whole footprint: code, `.env`, data, backups, dependencies. Only root, nginx and the app itself can reach it.
- **Requests:** the tailnet identity is ambient, like a cookie. Every mutation needs an exact Origin match and a JSON content type, and authorization runs before any mutation or prompt.

## Scope

1. **Identity-safe ingress (SID-001):** per-hostname sockets, header normalization in every location, on both the planner and executor paths. Rollback refuses to reopen TCP while any app trusts headers.
2. **Listen contract and ownership (SID-002):** apps on owner-restricted sockets; sensitive apps' whole ownership graph moves to their own user; each app's URI behavior is preserved.
3. **sovereignAuth core library (SID-003):** the wire contract, snapshot reader, mutation guard, assurance checks, and conformance vectors. Node first; Python when the first Python app migrates.
4. **Directory, bootstrap and recovery (SID-004):** stable user IDs, setup → active → recovery states, enrollment grants, a root reset CLI, and a snapshot with generations and member epochs so revocation lands within a minute.
5. **Passkey service (SID-005):** multiple credentials per member; hardware keys proven by attestation; host-scoped assurance cookies; every-time tokens bound to the exact request and consumed once by Home Base.
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

**Spike 3 (required before SID-001):**
- Identity headers and socket targets work on Tailscale Services traffic.
- Two services on one host route to their own sockets.
- Stable user IDs resolve from the client IP.
- A local process on the host gets no member identity.
- YubiKey attestation verifies against the pinned vendor root.
- A cross-hostname read and post are refused.

## Review

An external plan review (2026-10-24) requested changes: 9 high, 5 medium. This revision addresses each one; the PRD's `reviewResolution` maps findings to changes.

## Definition of Done

- The pilot app and the finance canary run in tailnet mode. A member lands as themselves with no picker or PIN; the canary asks for a passkey tap instead of a passphrase.
- Administrator actions ask for an attested hardware key every time, and every Home Base route is in the authorization matrix.
- Forged headers, cross-site posts, sibling-hostname requests, tagged hosts and unknown logins are all refused in tests and in the rehearsal.
- Only root, nginx and the app itself can reach a sensitive app's socket, code, secrets or backups.
- Revoking a passkey or disabling a member takes effect within one snapshot interval while apps keep running.
- Home Base admin no longer needs the passphrase day to day; recovery and reset are rehearsed.
- Every app still runs standalone with its local auth when tailnet mode is off.
- The rollout runbook has been walked end to end on a test VM, including rollback.
