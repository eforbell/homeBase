# Research: the iPhone as a hardware key, and onboarding members

Issue #44. Started 2026-11-08. Status: findings and a recommendation. Nothing here is decided, and there's no code.

## Summary

- **The iPhone can be an administrator's hardware key, but not as a passkey.**
  - Apple doesn't let a third-party passkey provider return device-bound keys or attestation, and synced Apple passkeys carry no attestation.
  - The way that works: a native app holds a Secure Enclave key that needs Face ID for each use, proves itself to Home Base with **App Attest** at enrollment, and **approves each every-time action** by signing it.
  - Home Base then mints the same 60-second, single-use action token the WebAuthn path mints, so nothing downstream changes.
- **It beats a YubiKey on one point.** The phone shows the request it's approving, fetched from Home Base itself rather than from the browser. A YubiKey tap approves whatever the browser asked for.
- **It loses to a YubiKey on others.** It depends on the operator's own app build. Face ID is enforced by the Secure Enclave, but the server can't check it per use. And the key dies with the phone.
- **Members, unlike administrators, never need a hardware key.** Session and Recent checks accept synced passkeys (Apple Passwords). For non-operator members, the hard part is onboarding, not the key. The same native app could take most of the friction out of onboarding, which is the bigger win for most households.
- **Recommendation:** one companion app per household, built by the operator. It does the following:
  - receives push notifications;
  - approves every-time actions (for administrators);
  - onboards members;
  - opens the household's apps.
- **YubiKeys stay supported.** Households on the hosted route, with no Apple developer account of their own, can't build the app.

## Where Home Base is today

- **Credential kinds (D15, sovereignAuth `webauthn.js`):** `synced` (backup-eligible or backed up), `device-bound` (single-device, no verifiable attestation) and `hardware` (single-device, with a `packed` attestation chaining to a pinned vendor root). Only `none` and `packed` are accepted.
- **Every-time + hardware (D8, wire contract section 9):** a fresh ceremony whose challenge binds the app, the policy key, the target and the request digest. Home Base mints a 60-second, single-use action token from it.
- **Administrator credentials (D11):** at least two, at least one of them hardware. Leaving setup and recovery (D16) needs a fresh hardware ceremony.

## What Apple allows

| Question | Finding | Source |
|---|---|---|
| Does a synced Apple passkey count as hardware? | No. It syncs through iCloud Keychain, so BE/BS are set and sovereignAuth classifies it `synced`, with no attestation. That's fine for Session and Recent, and correct as it is. | spike 2, D15 |
| Can our own app be a passkey provider with device-only keys? | **No.** Apple, June 2026: "A device-bound credential is not a passkey and cannot be returned as part of a credential provider extension." | Apple forums 829541 |
| Can a provider return attestation that Home Base could pin? | **No.** Same reply: "WebAuthn attestation is not supported for passkeys outside of a few MDM-managed contexts, though using AppAttest out of band is fine." Developers report that only `none` is accepted; `packed` fails with "Found unsupported attestation type". | 829541, 742434, 761139 |
| Can a native app run WebAuthn against Home Base's RP ID itself? | **Not on household phones.** Native passkey APIs need an associated domain (`webcredentials:`), and the system fetches its `apple-app-site-association` file through Apple's CDN. Tailnet hostnames aren't reachable from the internet. Apple's "alternate mode", which bypasses the CDN, is for development builds and MDM-managed devices. To confirm in spike 5. | Apple: Supporting associated domains |
| What can App Attest prove? | A key generated in the Secure Enclave of a genuine Apple device, for one App ID (`<TEAMID>.<bundle id>`), development or production environment. The server verifies the chain to Apple's App Attest root CA itself; there's no Apple endpoint at verification time. | Apple: Validating apps that connect to your server |
| Limits of App Attest | Not available in app extensions (except watchOS), so main app only. Its keys can't carry a Face ID access control. Mac and simulator report it unsupported. | Apple: `DCAppAttestService.isSupported` |
| Secure Enclave keys | P-256, never exportable. `SecAccessControl` with `.biometryCurrentSet` makes the Secure Enclave itself refuse to sign without Face ID; changing the Face ID enrollment invalidates the key. Keys are device-only and don't survive a restore or a new phone. | CryptoKit / Security framework |

That rules out two options from the issue. Option 1 (accept a synced passkey as hardware) would cut what "hardware" means today, D15. Option 2 (our app as a passkey provider) is blocked by Apple and would give `synced` at best, no better than Apple Passwords. **Option 3 remains: an approval key, enrolled with App Attest.**

## Option 3 in detail: the approval key

### Enrollment (in the app, on the tailnet)

1. The administrator, already signed in to Home Base admin, chooses "add this iPhone as a hardware key". The challenge carries the same `standing` binding as a passkey enrollment (state, epochs).
2. The app creates a Secure Enclave P-256 signing key with `.biometryCurrentSet` and `.privateKeyUsage`.
3. The app runs App Attest: `attestKey(keyId, clientDataHash)` with `clientDataHash = SHA-256(challenge ‖ approval public key ‖ member ID ‖ household instance)`.
4. Home Base verifies:
   - the chain to the pinned Apple App Attest root;
   - the App ID hash against the household's configured App ID (install config, never code);
   - the environment (production only, unless a development flag is set);
   - the nonce, which binds the approval key and challenge.
5. Home Base stores a new credential type, `device-approval`, with kind `hardware` and the root fingerprint, the same way a YubiKey records its root. It also keeps the App Attest public key and counter, for optional assertions later.

The app's requests arrive over the tailnet, so the member identity comes from the tailnet as it does for every other request. The app needs no password and no cookie of its own.

### Approval (every time)

1. In the browser, the administrator starts an every-time action. Home Base records a **pending approval**: `{ act, tgt, dig, aud, summary, code, expires: 60s }`. The browser shows a short code.
2. Home Base notifies the phone through the household's push service. The app also lists pending approvals whenever it's opened, so **push is a convenience, not a dependency**.
3. The app fetches the approval **from Home Base directly** over the tailnet and shows the summary, the code to match against the browser, and the expiry.
4. Face ID, then the Secure Enclave signs the canonical bytes `{ challenge, act, tgt, dig, aud, member, standing }`.
5. Home Base verifies the signature against the enrolled approval key and mints the **same action token** the WebAuthn path mints. The browser, polling or on a server-sent event, receives it and completes the request. The app never sees the token.

### What this gets us, and what it costs

- **Better than a YubiKey:**
  - What-you-see-is-what-you-sign. A compromised browser can start a malicious request, but the phone shows what that request really is, from Home Base.
  - Nothing to buy or carry.
- **Worse than a YubiKey:**
  - **Trust in the app build.** App Attest proves a genuine, unmodified copy of the operator's app, not that its code is right. Face ID per use rests on the app having set the access control, and the server can't check it per signature.
  - **One attestation.** App Attest runs at enrollment only. The app could also send an App Attest assertion with each approval, which adds a counter and an "is this still the genuine app" check, but no Face ID proof.
  - **Approval fatigue.** Pending approvals exist only for actions the administrator's own admin session started (Session assurance already required), with code matching, a 60-second expiry and one pending at a time. No unsolicited prompts.
  - **The key dies with the phone.** See below.
- **Reach:** only households whose operator has an Apple developer account and builds the app. YubiKeys stay the hardware key for everyone else.

### Effects on the rules

- **D15:** the pinned roots gain Apple's App Attest root, for the `device-approval` type only. A `packed` WebAuthn attestation chaining to it must not count. The App ID is per install.
- **D11:** an approval key counts as hardware. Whether it alone may satisfy "at least one hardware" or the administrator also needs a second device is decision 2.
- **Loss and recovery:** nothing new. A lost phone means the remaining credential, or the passphrase into recovery (D16), which re-enrolls.
- **sovereignAuth:**
  - `verifyAppAttestEnrollment` and `verifyDeviceApproval`, plus a credential type beside the WebAuthn ones;
  - conformance vectors, from attestations captured on a real device, since Apple publishes no test vectors;
  - Python port later.

## Onboarding members

### Today (what a non-operator member does)

1. **Join the tailnet.** The operator invites them. They install the Tailscale app, sign in with an identity provider, and wait for the operator to approve the device and grant the household's service addresses.
2. **Open Home Base's address once,** so the operator can add them; the window is one day.
3. **Wait** while the operator adds them and picks their apps.
4. **Enroll a passkey.** The operator issues a 15-minute code and passes it on by hand. The member opens Admin on Home Base's address, enters the code under Passkeys and registers a passkey.
5. **Bookmarks or the iOS wrapper,** for up to three kinds of hostnames (shared, per sensitive app, Home Base).
6. **In each app,** a parent links the member's local profile to their directory identity.
7. **Push:** install the push app and paste its secret into each app that notifies.

That's three apps to install, two codes passed by hand, two time windows, and several back-and-forths with the operator. It works for the operator, but it's a lot to ask of a partner, a grandparent or a twelve-year-old.

### With the companion app

1. **The operator, on the Members card:** "Invite". That shows one QR code (or link) that carries Home Base's address and a single-use enrollment grant.
2. **The member:** installs Tailscale and signs in (unavoidable, see below), then installs the companion app and scans the code.
3. **The app** reaches Home Base over the tailnet. That request is the "opened Home Base" step, and it carries the member's tailnet identity. Home Base redeems the grant for that identity and returns the member's apps and addresses.
4. **The app registers for push** once, for the whole household, instead of a secret pasted into each app.
5. **The app is the launcher.** It opens each app at the right hostname, replacing bookmarks and the wrapper's start URL.
6. **Passkeys stay synced Apple passkeys,** registered in Safari on Home Base's address, which the app opens for that step. The associated-domains limit above keeps the ceremony out of the app itself. To confirm: whether `ASWebAuthenticationSession` can run it without leaving the app (spike 3).
7. **Administrators also enroll the approval key** in the same app.

### What stays manual

- **Tailscale.** An app can't bundle its own VPN beside Tailscale (only one VPN runs at a time), so installing and signing in to Tailscale stays a step. With a user-owned Tailscale API key, Home Base might create the tailnet invite link itself (`POST /api/v2/tailnet/{tailnet}/user-invites`, link-only when no email is given). To confirm in spike 4. Home Base's current API credential is read-only by design (D23), so this would be an optional second credential, and that is the operator's choice.
- **Getting the app** depends on the operator's distribution route:
  - Internal TestFlight needs each member to have an App Store Connect role (open question: minors), and builds expire every 90 days.
  - External TestFlight needs a beta review but no role.
  - An unlisted App Store build has neither limit but needs a full review.
- **Profile linking in each app** (step 6 today) is separate work: apps could read the directory identity and skip it.

## Decisions for the founder

1. **Same device.** May an administrator approve from the phone that's also running the admin browser? Recommendation: yes. The Secure Enclave and Face ID still gate it, and a YubiKey plugged into a compromised laptop is no different.
2. **D11.** Can the approval key alone be the administrator's hardware credential? Recommendation: yes, keeping the second-credential rule. Encourage a second hardware factor (a YubiKey or a second phone) so a lost phone doesn't force recovery.
3. **One companion app** (push, approvals, onboarding, launcher, and later document capture) or separate apps? Recommendation: one. Every app multiplies Apple onboarding and distribution for each operator.
4. **Distribution for members:** external TestFlight, App Store Connect roles, or unlisted.
5. **App Attest development environment.** Accept Xcode builds behind a flag, or production (TestFlight and App Store) only?

## Spikes before any build

1. App Attest on a TestFlight build: attest and assert, verify in Node against the pinned root, capture fixtures for vectors.
2. A Secure Enclave key with `.biometryCurrentSet`: sign from the app opened from a notification; confirm a Face ID enrollment change invalidates it and the app says so.
3. `ASWebAuthenticationSession` running Home Base's passkey ceremony on a tailnet hostname, inside the app.
4. A link-only tailnet invite through the Tailscale API: the scope needed, and what the invitee sees.
5. Associated domains on a tailnet hostname, unmanaged device, TestFlight build: confirm it fails.

## Slices, if adopted

Each slice is one PR touching few files.

1. sovereignAuth: App Attest enrollment and approval verification, pinned root, vectors.
2. Home Base: the `device-approval` credential, the pending-approval API, minting the action token.
3. Home Base: the admin UI (enroll the iPhone, the approval wait screen with its code).
4. The app: enrollment and the approval screen.
5. Push wake-up for pending approvals.
6. Onboarding: the invite QR on the Members card, grant redemption from the app, the launcher.

## Sources

- Apple Developer Forums: [credential provider and hybrid, attestation (Apple, June 2026)](https://developer.apple.com/forums/thread/829541); [packed attestation from providers](https://developer.apple.com/forums/thread/742434); ["Found unsupported attestation type"](https://developer.apple.com/forums/thread/761139)
- Apple: [Validating apps that connect to your server](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server); [DCAppAttestService.isSupported](https://developer.apple.com/documentation/devicecheck/dcappattestservice/issupported); [Supporting associated domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains)
- [passkeys.dev: iOS reference](https://passkeys.dev/docs/reference/ios); [Tailscale API](https://tailscale.com/api)
