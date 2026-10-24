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

## Scope

1. **Identity-safe ingress (SID-001):**
   - Tailscale Serve → a root-only nginx Unix socket.
   - nginx overwrites `X-Sovereign-*` identity headers from Serve's `Tailscale-User-*`.
   - Relative redirects; no TCP path to nginx.
2. **App listen contract (SID-002):**
   - Apps listen on group-restricted Unix sockets.
   - Sensitive apps run as their own service users.
3. **Household directory (SID-003):**
   - Members, roles (parent/kid), an administrator flag, and per-app access.
   - A signed snapshot that apps read.
4. **Suite passkey service at `/_sovereign/auth/` (SID-004):**
   - Several credentials per member (1Password, Apple Passwords, YubiKey).
   - Classification from what the authenticator reports.
   - A signed assurance cookie, and single-use action tokens.
5. **Home Base admin (SID-005):** tailnet identity + passkey. Every-time hardware key for privileged plans. Passphrase kept as break-glass.
6. **Shared adapter + pilot (SID-006):** `local | tailnet | oidc` modes for Node and Python apps, in a new public `sovereignAuth` repo that apps take as a pinned git dependency. One previously passwordless app piloted end to end.
7. **Runbook + rehearsal (SID-007):** VM rehearsal before any production host changes.

## Freshness levels

| Level | Meaning | Used for |
|---|---|---|
| Tailnet | Identity header present | Every app, every request |
| Session | A passkey check within the app's window | Opening sensitive apps (24h for trading and Bitcoin accounting, 30d for finance and estate documents) |
| Recent | A check within 5 minutes | `credentials` actions: linking accounts, adding or removing passkeys, changing roles |
| Every time + hardware key | A single-use token for one named action | Administrator actions: rotating secrets, granting administrator, privileged Home Base plans |

## Evidence

Two spikes on a test VM (2026-10-23):
- **Serve identity:**
  - The correct login arrives from macOS, the iOS web wrapper and a kid's Windows PC.
  - Forged headers are replaced.
  - A tagged host gets no identity.
- **Passkey step-up:**
  - Works with 1Password on desktop and iPhone, as long as PRF isn't requested.
  - Works with Apple Passwords and a USB-C YubiKey.
  - Hardware keys are classified correctly from their reported flags.
  - The tailnet-level RP ID is accepted by Chrome and Safari.
  - Every cookie and token rejection rule held.
  - A non-administrator member (a kid's PC) could enroll a passkey and pass session and recent checks, but was refused the administrator action before any prompt.
  - Parent/kid roles weren't exercised; the spike had only the administrator flag. The pilot (SID-006) and rehearsal (SID-007) cover them.
- **Gaps the spikes found, all addressed by SID-001/002:**
  - nginx on `0.0.0.0` blocked Serve's `:443` bind.
  - Apps bind `0.0.0.0` despite the catalog.
  - Loopback app ports accept forged headers.
  - All apps share one service user.
  - Redirects leaked `http://localhost` behind the socket.

## Definition of Done

- A member opens any wave-1 app from their own tailnet device and lands as themselves: no picker, no PIN.
- Sensitive apps ask for a passkey tap instead of a passphrase. Administrator actions ask for the hardware key every time.
- No local process other than root can forge identity to nginx, Home Base or a sensitive app.
- Home Base admin no longer needs the passphrase day to day; break-glass recovery is rehearsed.
- Every app still runs standalone with its local auth when tailnet mode is off.
- The rollout runbook has been walked end to end on a test VM.
