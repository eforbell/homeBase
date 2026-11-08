# Research: the iPhone as a hardware key, and onboarding members

Issue #44. Started 2026-11-08 and revised after a Codex review the same day. Status: findings and a recommendation. Nothing here is decided, and there's no code.

## Summary

- **The iPhone can approve administrator actions, but not as a passkey.** Apple doesn't let a third-party passkey provider return device-bound keys or attestation, and synced Apple passkeys carry no attestation.
- **What works is an approval in the household's own app,** signed with its **App Attest** key.
  - App Attest proves that the key was generated in the Secure Enclave of a genuine Apple device, for the household's own app.
  - Every approval carries a fresh App Attest assertion, so each one shows that same app instance took part.
  - The app shows the request and asks for Face ID before it signs. The server can't verify the Face ID step: it rests on the app's code.
  - Home Base mints the same 60-second, single-use action token the WebAuthn path mints, so nothing downstream changes.
- **Its trust model differs from a YubiKey's.** A YubiKey's attestation vouches for the authenticator itself. App Attest vouches for a genuine copy of the operator's app on a genuine device, and the app's code enforces the rest. Whether that counts as `hardware` or as a new kind the policy also accepts is decision 2.
- **What it adds:** Home Base, not the browser, describes the operation to the phone. That beats a YubiKey tap, but only if Home Base builds the description from the request it will actually run (see "Approval").
- **Members, unlike administrators, never need a hardware key.** Session and Recent checks accept synced passkeys (Apple Passwords). For non-operator members, the hard part is onboarding, not the key, and the same native app can take out most of the friction. That's the bigger win for most households.
- **Recommendation:** one companion app per household, built by the operator. It does the following:
  - receives push notifications;
  - approves every-time actions (for administrators);
  - onboards members;
  - opens the household's apps.
- **YubiKeys stay supported.** Households on the hosted route, with no Apple developer account of their own, can't build the app.

## Where Home Base is today

- **Credential kinds (D15, sovereignAuth `webauthn.js`):** `synced` (backup-eligible or backed up), `device-bound` (single-device, no verifiable attestation) and `hardware` (single-device, with a `packed` attestation chaining to a pinned vendor root). Only `none` and `packed` are accepted.
- **Every-time + hardware (D8, wire contract section 9):** a fresh ceremony whose challenge binds the app, the policy key, the target and the request digest. Home Base mints a 60-second, single-use action token from it, and refuses if the member's standing moved between challenge and finish (`passkey-routes.js`).
- **Administrator credentials (D11):** at least two, at least one of them hardware. Adding one while active needs an every-time hardware check for that enrollment. Leaving setup or recovery (D16) needs a fresh hardware ceremony, and only setup and recovery accept passphrase authority.
- **Member enrollment grants:** issued for a member already admitted from an observed tailnet identity, and consumed when the passkey registration verifies, just before the credential is stored.

## What Apple allows

| Question | Finding | Source |
|---|---|---|
| Does a synced Apple passkey count as hardware? | No. It syncs through iCloud Keychain, so BE/BS are set and sovereignAuth classifies it `synced`, with no attestation. That's fine for Session and Recent, and correct as it is. | spike 2, D15 |
| Can our own app be a passkey provider with device-only keys? | **No.** Apple, June 2026: "A device-bound credential is not a passkey and cannot be returned as part of a credential provider extension." | Apple forums 829541 |
| Can a provider return attestation that Home Base could pin? | **No.** Same reply: "WebAuthn attestation is not supported for passkeys outside of a few MDM-managed contexts, though using AppAttest out of band is fine." Developers report that only `none` is accepted; `packed` fails with "Found unsupported attestation type". | 829541, 742434, 761139 |
| Can a native app run WebAuthn against Home Base's RP ID itself? | **Not on household phones.** Native passkey APIs need an associated domain (`webcredentials:`), and the system fetches its `apple-app-site-association` file through Apple's CDN. Tailnet hostnames aren't reachable from the internet. Apple's alternate mode, which bypasses the CDN, is for development builds and MDM-managed devices. | Apple: Supporting associated domains; the associated-domains entitlement |
| What does App Attest prove? | That **its own key**, made by `DCAppAttestService.generateKey`, was generated in the Secure Enclave of a genuine Apple device, for one App ID (`<TEAMID>.<bundle id>`), in the development or production environment. The server verifies the chain to Apple's App Attest root CA itself; there's no Apple endpoint at verification time. Each later assertion signs a client-data hash with that key and a counter. It does **not** certify any other key the app creates, even if that key's public part is in the client data. | Apple: Validating apps that connect to your server; `attestKey`; Attestation Object Validation Guide |
| Where does App Attest run? | In the main app on iPhone. The `isSupported` page says app extensions don't support it (except watchOS). WWDC26 guidance adds macOS 27 and Action and SSO extensions; the sources disagree by OS version, and neither covers credential provider extensions. The approval flow uses the main app either way. App Attest keys can't carry a Face ID access control. | Apple: `isSupported`; WWDC26 session 201 |
| Face ID per use | `SecAccessControl` with `.biometryCurrentSet` restricts a Secure Enclave key to the enrolled faces, and an enrollment change invalidates it. It **doesn't guarantee a fresh prompt per signature**: an already authenticated `LAContext` can allow later operations without asking again. Every approval needs a new context, invalidated afterwards. | Apple: `biometryCurrentSet`; `kSecUseAuthenticationContext` |
| Secure Enclave keys | P-256, never exportable, device-only. They don't survive a restore or a new phone; App Attest keys don't either. | CryptoKit / Security framework |

That rules out two options from the issue. Option 1 (accept a synced passkey as hardware) would cut what "hardware" means today, D15. Option 2 (our app as a passkey provider) is blocked by Apple and would give `synced` at best, no better than Apple Passwords. **Option 3 remains: approvals signed in the household's app, enrolled and checked with App Attest.**

## Option 3 in detail

### What's attested and what's trusted

- **Attested by Apple:** the App Attest key lives in a genuine device's Secure Enclave and belongs to a genuine, signed copy of the household's App ID. Each approval's assertion proves that same instance signed it.
- **Trusted, not attested:** that the app showed the request and required Face ID with a fresh context before signing. A second Secure Enclave key with `.biometryCurrentSet` can enforce the Face ID part in hardware, but nothing proves to Home Base that the key was created that way: its provenance rests on the app, just like the prompt. Recommendation: still sign with both keys. The cost is small, and it keeps a lost, unlocked phone from approving without a face, as long as the app is the genuine one.

### Enrollment

1. **Authority first, as for any administrator credential:**
   - **While active,** an every-time hardware check for this exact enrollment, with the existing YubiKey or approval key.
   - **In setup or recovery (D16),** the passphrase authority. This is how an operator without a YubiKey gets their first hardware credential.
   - An admin session alone is never enough.
2. Home Base issues an enrollment challenge bound to the member, the household, the hostname, the purpose (`enroll-approval`) and the standing (state, epochs), and stores that standing.
3. In the app (main app, not an extension): generate the App Attest key and attest it with `clientDataHash = SHA-256(challenge ‖ household ‖ member ‖ Face ID key public key)`. Also create the Secure Enclave key with `.biometryCurrentSet` and `.privateKeyUsage`.
4. Home Base verifies:
   - the chain to the pinned Apple App Attest root;
   - the App ID hash against the household's configured App ID (install config, never code);
   - the environment (production only, unless decision 5 allows development);
   - the nonce;
   - that the standing hasn't moved.
5. It consumes the challenge atomically and stores a `device-approval` credential: the App Attest key and counter, the Face ID key and the root fingerprint.

The app's requests come over the tailnet, so the member identity comes from the tailnet, as on every other request. Identity says who is asking; step 1 is what authorizes them.

### Approval (every time)

1. **Home Base describes the request, not the browser.** For an every-time action, Home Base validates the actual operation and freezes it (the privileged plan, the setting change, the grant), then computes both `dig` and the human summary from that frozen record. The browser can't supply the description. The current action-check API takes an opaque target and digest, so this needs per-action server-side derivation, which is slice 2's biggest piece.
2. **Home Base records a pending approval:**
   - `{ challenge, household, member, browser session, hostname, aud, act, tgt, dig, summary, standing, expires: 60s }`;
   - at most one pending per administrator;
   - a rate limit, with a lockout and an audit alert after repeated rejections or expiries.
3. **Home Base notifies the phone** through the household's push service. The app also lists pending approvals whenever it's opened, so push is a convenience, not a dependency.
4. **The app fetches the approval from Home Base** over the tailnet and shows the summary, a short code that the browser also shows, and the expiry.
5. **The app signs.**
   - It asks for Face ID with a **new `LAContext`** and invalidates the context afterwards.
   - It signs the canonical bytes with the Face ID key.
   - It makes an App Attest assertion over the same bytes.
6. **Home Base claims the pending approval atomically.**
   - It checks that it's unexpired, unclaimed, and that the stored standing still holds (refusing on any state or epoch change, as the WebAuthn path does).
   - It verifies both signatures and that the App Attest counter rose.
   - Only then does it mint exactly one action token, for the browser session that started the request. A replayed approval finds the record already claimed.

### Activation (leaving setup or recovery)

That is a different purpose (`activate`), not an every-time action. It runs under the passphrase authority D16 gives those states, checks D11, moves Home Base to active, and **never mints a privileged-action token**. With an approval key, it's the same claim and verify as above, with `purpose: activate` bound into the challenge.

### What this gets us, and what it costs

- **Better than a YubiKey:**
  - **Home Base describes the request.** The phone shows Home Base's description of the frozen request, so a compromised browser can't change what's approved. It can still start a request; the administrator has to read it.
  - **Nothing to buy or carry.**
- **Worse than a YubiKey, or different:**
  - **Trust in the app build.** App Attest proves a genuine, unmodified copy of the operator's app on a genuine device, not that its code is right. Face ID and the Face ID key's provenance rest on that code.
  - **Compromise of the phone or the app.** A same-device approval still keeps a separate app boundary against a browser-only compromise, but it's no defense if the phone's OS or the app is compromised. A YubiKey on a compromised laptop shares the browser-compromise risk but not this one.
  - **Approval fatigue.** Anyone holding the administrator's session or browser can create prompts. One pending request, the 60-second expiry, rate limits and the lockout bound how many, but they can't prevent them. Code matching confirms the phone and browser are looking at the same request; it doesn't prove the browser is honest, since a malicious browser shows the right code too.
  - **The key dies with the phone.** See below.
- **Reach:** only households whose operator has an Apple developer account and builds the app. YubiKeys stay the hardware key for everyone else.

### Effects on the rules

- **D15:** the pinned roots gain Apple's App Attest root, accepted only for the `device-approval` type. A WebAuthn `packed` attestation chaining to it must not count. The App ID is per install.
- **D11:** whether an approval key satisfies "at least one hardware" is decision 2.
- **Loss and recovery:**
  - If the lost phone was the only hardware credential, the remaining synced passkey can still open admin but **can't** authorize a replacement hardware credential, so D16 recovery is needed.
  - A second hardware credential (a YubiKey or a second phone) avoids that.
- **sovereignAuth:**
  - `verifyAppAttestEnrollment`, `verifyAppAttestAssertion` and `verifyDeviceApproval`, plus a credential type beside the WebAuthn ones;
  - vectors seeded from Apple's Attestation Object Validation Guide (example inputs, a full attestation object and intermediate results), plus fixtures from a real device;
  - Python port later.

## Onboarding members

### Today (what a non-operator member does)

1. **Join the tailnet.** The operator invites them. They install the Tailscale app, sign in with an identity provider, and wait for the operator to approve the device and grant the household's service addresses.
2. **Open Home Base's address once,** so the operator can add them; the window is one day.
3. **Wait** while the operator admits them, picking that observed identity, a role and apps.
4. **Enroll a passkey.** The operator issues a 15-minute code and passes it on by hand. The member opens Admin on Home Base's address, enters the code under Passkeys and registers a passkey.
5. **Bookmarks or the iOS wrapper,** for up to three kinds of hostnames (shared, per sensitive app, Home Base).
6. **In each app,** a parent links the member's local profile to their directory identity.
7. **Push:** install the push app and paste its secret into each app that notifies.

That's three apps to install, two codes passed by hand, two time windows, and several back-and-forths with the operator. It works for the operator, but it's a lot to ask of a partner, a grandparent or a twelve-year-old.

### With the companion app

The guiding rule: the app removes the typing and the timing, **not** the operator's decision about which tailnet identity becomes which member.

1. **The member** installs Tailscale and signs in (unavoidable, see below), then installs the companion app and scans the household's **join code**. The code carries Home Base's address only; it grants nothing. Showing it on the Admin page, or printing it, is fine.
2. **The app opens Home Base** over the tailnet. That request is today's "opened Home Base once" step: the member's tailnet identity becomes a candidate, and the app shows "Waiting for <operator> to add you".
3. **The operator, on the Members card,** sees the candidate with their tailnet login, admits them as today (role, apps), and the app is told. Admission stays bound to the observed identity, never to whoever holds a code.
4. **Passkey enrollment stays a member-bound grant.** The operator issues it as today, and the app gets it for its own member over the tailnet, so nobody types or forwards a code. The app opens Safari on Home Base's address with the grant attached, the 15-minute deadline still applies, and **the grant is consumed when the registration verifies**, as now, never when the app fetches it. The associated-domains limit keeps the ceremony itself in Safari. Spike 3 checks whether `ASWebAuthenticationSession` can run it without leaving the app.
5. **The app registers for push** once for the whole household, instead of a secret pasted into each app, and becomes the launcher: it opens each app at the right hostname, replacing bookmarks and the wrapper's start URL.
6. **Administrators** also enroll the approval key, with the authority described above.

### What stays manual

- **Tailscale.** An app can't bundle its own VPN beside Tailscale (only one VPN runs at a time), so installing and signing in to Tailscale stays a step. With a user-owned Tailscale API key, Home Base might create the tailnet invite link itself (`POST /api/v2/tailnet/{tailnet}/user-invites`, link-only when no email is given). To confirm in spike 4. Home Base's current API credential is read-only by design (D23), so this would be an optional second credential, and that is the operator's choice.
- **The operator's decisions:** admitting the member and issuing their grant stay two taps on the Members card. The flow above only removes the hand-offs.
- **Getting the app** depends on the operator's distribution route:
  - **Every TestFlight build expires after 90 days, internal and external alike.** An expired build stops launching until a newer one is installed. The keys survive an update of the same app, but if no newer build is out in time, approvals stop and the administrator falls back to another credential or to recovery. A TestFlight-distributed approval app needs a standing renewal habit, or a second hardware credential, or both.
  - Internal TestFlight needs each member to have an App Store Connect role (open question: minors).
  - External TestFlight needs a beta review but no role.
  - An unlisted App Store build doesn't expire but needs a full review.
- **Profile linking in each app** (step 6 today) is separate work: apps could read the directory identity and skip it.

## Decisions for the founder

1. **Same device.** May an administrator approve from the phone that's also running the admin browser? Recommendation: yes. The approval app is a separate boundary from the browser, and Home Base, not the browser, describes the request. The cost: a compromised phone OS defeats both at once.
2. **What it counts as.** Is a `device-approval` credential `hardware` under D11 and D15, or a new kind (say `attested-device`) that the every-time policy also accepts? Recommendation: a new kind that the policy accepts, so the Members card and audit say honestly what it is. D11 then reads "at least one hardware or attested-device credential", with a second such credential encouraged.
3. **One companion app** (push, approvals, onboarding, launcher, and later document capture) or separate apps? Recommendation: one. Every app multiplies Apple onboarding and distribution for each operator.
4. **Distribution:** external TestFlight, App Store Connect roles, or unlisted. Every TestFlight route expires builds after 90 days, which matters most for the administrator's approval app. Recommendation: TestFlight to start, with a renewal reminder and a second hardware credential required while the approval app is on TestFlight; unlisted once the app settles.
5. **App Attest development environment.** Accept Xcode builds behind a flag, or production (TestFlight and App Store) only?

## Spikes before any build

1. **App Attest on a TestFlight build:**
   - attest, then assert several times;
   - verify in Node against the pinned root and Apple's validation-guide example;
   - capture fixtures.
2. **Face ID key with `.biometryCurrentSet`:**
   - several approvals in a row, each with a new `LAContext`: confirm each one prompts;
   - cancellation and backgrounding mid-prompt;
   - a Face ID enrollment change invalidates the key, and the app says so.
3. `ASWebAuthenticationSession` running Home Base's passkey ceremony on a tailnet hostname, inside the app, with a grant handed over.
4. A link-only tailnet invite through the Tailscale API: the scope needed, and what the invitee sees.
5. Associated domains on a tailnet hostname, unmanaged device, TestFlight build: confirm it fails.

## Slices, if adopted

Each slice is one PR touching few files.

1. sovereignAuth: App Attest enrollment and assertion verification, the approval format, the pinned root, vectors.
2. Home Base: server-side request freezing and summaries for each every-time action. Worth doing even without the iPhone, since it hardens the WebAuthn path too.
3. Home Base: the `device-approval` credential, enrollment authority, and the pending-approval claim and mint (plus activation).
4. Home Base: the admin UI (enroll the iPhone, the approval wait screen with its code).
5. The app: enrollment and the approval screen.
6. Push wake-up for pending approvals.
7. Onboarding: the join code, candidate admission from the app, the grant handoff to Safari, the launcher.

## Sources

- Apple Developer Forums: [credential provider and hybrid, attestation (Apple, June 2026)](https://developer.apple.com/forums/thread/829541); [packed attestation from providers](https://developer.apple.com/forums/thread/742434); ["Found unsupported attestation type"](https://developer.apple.com/forums/thread/761139)
- Apple:
  - [Validating apps that connect to your server](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server)
  - [Attestation Object Validation Guide](https://developer.apple.com/documentation/devicecheck/attestation-object-validation-guide)
  - [`attestKey`](https://developer.apple.com/documentation/devicecheck/dcappattestservice/attestkey%28_%3Aclientdatahash%3Acompletionhandler%3A%29)
  - [`DCAppAttestService.isSupported`](https://developer.apple.com/documentation/devicecheck/dcappattestservice/issupported)
  - [WWDC26 session 201](https://developer.apple.com/videos/play/wwdc2026/201/)
  - [`biometryCurrentSet`](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset)
  - [`kSecUseAuthenticationContext`](https://developer.apple.com/documentation/security/ksecuseauthenticationcontext)
  - [Supporting associated domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains)
  - [Associated domains entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.associated-domains)
- [passkeys.dev: iOS reference](https://passkeys.dev/docs/reference/ios); [Tailscale API](https://tailscale.com/api)
