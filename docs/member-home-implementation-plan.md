# Member Home and Onboarding Landing Page

Status: implemented and locally verified on `feat/member-home`. 2026-11-12. Not deployed.

## Requirements and decision

Make Home Base `/` useful before administrator unlock: a permission-filtered **Your apps** launcher for admitted members and a clear onboarding welcome for recognized tailnet users awaiting admission. Passkeys are optional for discovery; kids can complete onboarding without one. Keep the existing operational dashboard for the unlocked administrator.

This deliberately expands SID-006's earlier “members use Home Base for their own passkeys only” scope, without relaxing administrator APIs. See `planning/features/feature-10-summary.md:198–201`. Existing dashboard loading and failure behavior are in `public/dashboard.js:162–171,248–254`; the admin-only API classifications are in `src/route-matrix.js:66–88`.

## Landing-page states

| State | Visible experience |
| --- | --- |
| Recognized tailnet identity, not admitted | “Welcome—you’re connected as [name/login]. Ask your household administrator to add you.” Explain that the visit makes the account available for admission, only once candidate observation succeeds. No app inventory. |
| Active member | **Your apps**: granted, installed apps with name, icon and Open link. No passkey prerequisite. |
| Active member, no available apps | “You’re a member, but no apps are available to you yet.” Do not describe this as awaiting admission. |
| Administrator, locked | Same launcher, plus **Unlock administration**. |
| Administrator, unlocked | Existing operational dashboard and admin navigation. |
| Disabled member | Access-unavailable message; no inventory or enrollment call to action. Do not treat as a new candidate. |
| Missing identity or identity/directory failure | Distinct connection/retry guidance; never report “waiting for admission” when identity cannot be verified. No inventory. |
| Household setup/recovery | Preserve those lifecycle explanations and restrictions; do not expose an active-member launcher. |

For active members, provide **Have a passkey enrollment code?** linking to existing self-service on `/admin`. Enrollment remains optional and separate from admission. Never put codes in URLs or browser storage.

## Implementation slices

1. **Add a narrow landing-view API and authorization tests.** Add a member-self-service entry such as `GET /api/home` to `src/route-matrix.js`, with `use-app` policy and route-owned authorization. Implement its explicit identity/lifecycle/member checks in `src/app.js` or a small dedicated module: matrix classification alone does not authorize self-service handlers. Reuse the verified caller and snapshot access resolution (`src/app.js:524–533,974–993`; `src/identity/directory.js:96–118`). Return only the caller's landing state, own display identity, admin-unlock capability and allowlisted app fields (`id`, `name`, `icon`, `url`). Filter server-side by active membership, effective app grants and installed status. Return `Cache-Control: no-store`; never return raw state, catalog, snapshot or operational details. Preserve directory-off behavior.

2. **Preserve candidate observation and clarify onboarding.** Reuse the existing ingress identity/directory candidate path (`src/identity/identity-endpoint.js:91–100`; `src/identity/directory.js:555–573`), rather than adding admission/enrollment writes to a GET. Verify end-to-end that a first visit appears in Admin → Members before claiming it was received. Poll the landing view every 10 seconds only while awaiting admission and the tab is visible, with manual refresh and recoverable error messaging. Stop polling on admission, disablement or navigation. Admission reveals apps on the next successful refresh; it never issues or consumes a code automatically.

3. **Render the member experience without admin API calls.** Update `public/dashboard.js` to select the landing state first, loading existing operational data only for an unlocked administrator. Adjust `public/nav.js:128–158` so the launcher/welcome no longer receives the “these pages are the administrator's” banner or admin health polling. Show Home plus contextual onboarding/passkey access to members; hide Jobs, Config, Network and management links. Keep direct admin routes protected. Reuse existing card styles and HTML escaping. Reuse current ingress-aware URL construction (`src/app.js:341–355`) so Open targets the actual app hostname, not Home Base's management detail page. Destination apps retain their own linking, role and assurance checks; a launcher grant is not a promise of passkey-free access to every destination.

4. **Update the documented contract and verify.** Amend the SID-006 scope note with this narrow member-home exception, retaining the historical decision. Update `docs/suite-identity-rollout-runbook.md:152–154,306–312`: launcher users need network access to the Home Base service, admission and app grants are distinct from enrollment, and kids need no passkey for discovery. Do not change tailnet policy automatically.

## Acceptance and verification

- A newly visiting, identifiable non-member appears as a candidate and sees useful waiting guidance, without seeing app inventory or requiring a passkey.
- Administrator admission transitions that same browser into its granted installed apps within one successful polling cycle. An empty grant list produces the member-empty state.
- A member with zero credentials can discover/open permitted low-friction apps; checking a member passkey never unlocks admin APIs.
- Unknown, disabled, forged/tagged identity and unavailable/stale snapshot cases expose no inventory. Recovery/setup do not fall through to the launcher.
- Unauthorized and uninstalled apps are omitted server-side; explicit empty grants and operator-app defaults remain correct. Revocation removes entries on refresh; destination apps continue enforcing access independently.
- Launcher responses contain no jobs, ports, filesystem paths, backup details, other members or full catalog/state. Member rendering makes no administrator-only data requests.
- Locked/unlocked administrator behavior, directory-off legacy behavior and existing enrollment-code validation remain unchanged.
- Run targeted landing/API/UI tests plus `node --test test/route-matrix.test.js test/directory-api.test.js test/identity-endpoint.test.js`, then `npm test`. See local implementation evidence below; the original review baseline was 26 targeted tests.
- Browser/VM smoke test desktop and mobile: first visit → candidate → admission → apps, optional enrollment, disabled user, and administrator unlock. Verify kid service reachability and correct destination URLs. Apply the repository's visual-verdict gate to UI iterations.

## Risks, limits and stop condition

- **Accidental admin disclosure:** use a new allowlisted projection, never broaden `/api/state`, catalog, config or health access.
- **Misleading welcome:** distinguish verified non-member from identity failure; verify candidate observation rather than promising an admission request was recorded.
- **Enrollment confusion:** only administrator admission grants membership/access; an enrollment code only enables its existing credential ceremony. No auto-admission, auto-grants or mandatory kid passkeys.
- **Unreachable app/service:** directory grants do not replace tailnet service grants or app-local authorization. Preserve destination checks and document network prerequisites.

No new dependencies, schema migrations, native launcher, new approval system or credential-service redesign. This was originally a plan-only task; the user subsequently requested implementation. Production changes remain out of scope.

## Local implementation evidence

- `src/app.js`, `src/route-matrix.js`, `src/identity/directory.js`: minimal, uncached landing view; server-side grant filtering; read-only candidate acknowledgement; fail-closed snapshot and publication checks. Existing administrator APIs remain unchanged.
- `public/dashboard.js`, `public/nav.js`, `public/api.js`, `public/index.html`, `public/style.css`: shared initial request, contextual navigation, member/onboarding views, visible-tab admission polling and optional enrollment entry. No new framework or dependency.
- `test/member-home.test.js` and `test/member-home-ui.test.js`: 13 new API/UI tests. The household fixture now sets its test-only trusted snapshot root so filesystem trust checks work under macOS temporary directories without changing production validation.
- Final `npm test`: **742 passed, 0 failed**. Modified JavaScript syntax checks, PRD JSON parsing and `git diff --check` passed.
- Local Chromium smoke test with the real backend and synthetic ingress identities: first visit → candidate acknowledgement → administrator admission → launcher (without credentials); empty/revoked access; disabled account; optional enrollment entry; locked and unlocked administrator; mobile menu; snapshot failure and retry recovery. At 390px, no horizontal overflow and enrollment input font remained 16px. Member requests were limited to `/api/home`; browser console had no errors or warnings. Desktop/mobile visual verdict passed (94/100); artifacts are under `.omx/artifacts/member-home/`.
- Limits: no live VM/tailnet service-grant verification, destination-app smoke test or real-device passkey ceremony in this implementation run. The browser fixture used synthetic accounts and test authenticators; no production policy, service, membership or credential was changed. An independent native code-review agent could not start because its configured model was unavailable; local diff review and automated/browser checks were completed.
