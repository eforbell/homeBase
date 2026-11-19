// The native handoff (sovereignAuth wire contract, section 13; docs/native-handoff.md): a passkey check or an
// every-time action asked for by a page inside the household's iPhone app, whose web view can't run the
// ceremony itself. The page begins a record, the app attests it with App Attest, a Safari sheet on the same
// phone runs the ceremony against it, and the page redeems the result:
//
//   handoff/begin    the page, after a 401 step_up_required: the same checks check/options makes, then a
//                    pending record and its own __Host-sv_handoff_<tag> cookie
//   handoff/attest   the app, natively: an App Attest assertion by a key registered to this member
//   handoff/sheet    the sheet's page (GET, changes nothing), and its script
//   handoff/options  the sheet, before its tap: the ceremony's options (the challenge binds the handoff id)
//                    and a summary of what is being confirmed, written from the record
//   handoff/finish   the sheet, after its tap: the ceremony verified, the cookie or action token minted and
//                    kept on the record (no cookie is set in the sheet), and the app's callback to close it
//   handoff/redeem   the page, once the sheet closed: the record taken, the cookie set here or the token
//                    returned, exactly as check/finish would have
//
// sovereignAuth's createHandoff keeps the records and makes every check on them; this module runs the
// ceremony and mints the result the way passkey-routes.js does for check/finish. Only in active Home Base,
// and only with the native app configured. The routes are listed in passkey-routes.js (NATIVE_ROUTES).
const fs = require('fs');
const path = require('path');
const { createHandoff } = require('sovereign-auth');

const SHEET_SCRIPT = fs.readFileSync(path.join(__dirname, 'browser', 'handoff-sheet.js'));
const SHEET_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Confirm with your passkey</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --fg: #14171f; --muted: #5b6475; --accent: #3b6fe0; --border: #c5cad6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #11151d; --fg: #e8ecf4; --muted: #9aa3b5; --border: #4a5368; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.45 system-ui, -apple-system, sans-serif; }
  main { max-width: 480px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 1.3rem; margin: 0 0 12px; }
  p { margin: 0 0 16px; overflow-wrap: anywhere; }
  .muted { color: var(--muted); }
  button, a.button { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; width: 100%; box-sizing: border-box; padding: 0 16px; border-radius: 10px; font: inherit; text-decoration: none; cursor: pointer; }
  button { border: 0; background: var(--accent); color: #ffffff; }
  button[disabled] { opacity: 0.55; cursor: default; }
  a.button { margin-top: 12px; border: 1px solid var(--border); color: inherit; }
  [hidden] { display: none !important; }
</style></head>
<body><main>
  <h1>Confirm with your passkey</h1>
  <p id="summary" class="muted">Getting ready…</p>
  <button id="go" type="button" disabled>Use passkey</button>
  <p id="status" class="muted" role="status" style="margin-top:16px;"></p>
  <a id="back" class="button" hidden>Return to the app</a>
</main>
<script src="/_sovereign/auth/handoff/sheet.js"></script></body></html>
`;
// The sheet's page reads only its own script and talks only to this hostname. It arrives with the handoff
// id in its fragment, so it sends no Referer anywhere and is never cached.
const SHEET_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

// shared: what passkey-routes.js decides the same way for check/options and check/finish (actionRequest,
// ceremonyError, usedPasskey, expectOf, moved, windowSeconds(here), homeBaseApp).
function createHandoffRoutes({ directory, passkeys, nativeApp, sendJson, audit, shared, now = () => Date.now() }) {
  const handoff = createHandoff({
    appId: nativeApp.appId,
    scheme: nativeApp.scheme,
    instances: { get: (keyId) => directory.appInstance(keyId), advance: (keyId, from, to) => directory.advanceAppInstance(keyId, from, to) },
    now,
  });

  // What the ceremony for a record is bound to: its purpose and kind, and the handoff id beside the action,
  // so a challenge issued for this handoff finishes nothing else (and check/finish can't finish it).
  const bound = (record) => (record.purpose === 'action'
    ? { purpose: 'action', kind: record.kind, audience: shared.homeBaseApp, action: { act: record.policy, tgt: record.action.target, dig: record.action.digest, handoff: record.id } }
    : { purpose: 'step-up', kind: record.kind, action: { handoff: record.id } });

  // What the sheet shows, from the record (never from the URL).
  function summary(record, here, standing) {
    const key = record.kind === 'hardware' ? ' with your hardware key' : '';
    if (record.purpose === 'action') return `Confirm ${record.policy} for ${record.action.target || 'Home Base'} in Home Base${key}.`;
    if (!here.homeBase) return `Confirm it's you to open ${here.label || here.hostname}${key}.`;
    return standing.member.administrator ? `Unlock administration on Home Base${key}.` : `Confirm it's you on Home Base${key}.`;
  }

  // What check/options would decide for this request as the member stands now: null, or the refusal. Begin
  // asks it, and options and finish ask it again, since the member's standing (an administrator demoted, a
  // passkey revoked) can change during the five minutes a record lasts.
  function authorize({ purpose, policy, kind, action }, here, standing) {
    const no = (status, code, error) => ({ status, body: { error, code } });
    if (!here.homeBase && purpose !== 'check') return no(400, 'INVALID', 'Only checks run on this hostname; Home Base does the rest on its own.');
    if (purpose === 'action') {
      const allowed = shared.actionRequest({ policy, target: action?.target, digest: action?.digest }, standing);
      if (allowed.forbidden) return no(403, 'NOT_AUTHORIZED', 'Only the administrator confirms that.');
      if (allowed.error) return no(400, 'INVALID', allowed.error);
    }
    const usable = standing.credentials.filter((credential) => credential.usable && (kind === 'any' || credential.kind === 'hardware'));
    if (!usable.length) return no(409, 'NO_CREDENTIAL', `${kind === 'hardware' ? 'You have no attested hardware key enrolled.' : 'You have no passkey enrolled yet.'}${here.homeBase ? '' : ' Register one on Home Base\'s Admin page.'}`);
    return null;
  }
  // Thrown from options' issue callback, so a refused record never gets a challenge.
  class Refused extends Error {
    constructor(refusal) { super(refusal.body.error); this.refusal = refusal; }
  }

  const send = (res, answer) => {
    if (answer.clearCookie) res.setHeader('Set-Cookie', answer.clearCookie);
    sendJson(res, answer.status, answer.body);
    return true;
  };

  // The POST steps, for a member of active Home Base (passkey-routes.js resolved standing).
  async function handle({ req, res, route, body, here, standing }) {
    const target = standing.member.memberId;
    const member = { userId: standing.member.userId };
    const hostname = here.hostname;
    if (standing.state !== 'active') {
      sendJson(res, 409, { error: `Home Base is in ${standing.state}: the app confirms with passkeys once it is active.`, code: 'BOOTSTRAP_STATE' });
      return true;
    }

    if (route === 'POST handoff/begin') {
      const purpose = body.purpose === 'action' || body.purpose === 'check' ? body.purpose : null;
      if (!purpose) return shared.refusal(res, 400, 'INVALID', 'A handoff is for a check or an action.');
      const action = purpose === 'action' ? shared.actionRequest(body.action, standing) : null;
      const kind = body.kind === 'hardware' || action?.policy?.kind === 'hardware' ? 'hardware' : 'any';
      const request = { purpose, policy: action ? String(body.action?.policy) : 'step-up', kind, action: action && { target: body.action?.target, digest: body.action?.digest } };
      const refused = authorize(request, here, standing);
      if (refused) return shared.refusal(res, refused.status, refused.body.code, refused.body.error, refused.body.code === 'NOT_AUTHORIZED' ? 'passkey-action' : undefined, target);
      const started = await handoff.begin({ member, hostname, ...request });
      res.setHeader('Set-Cookie', started.setCookie);
      sendJson(res, 200, started.body);
      return true;
    }

    if (route === 'POST handoff/attest') {
      const answer = await handoff.attest({ member, hostname, body });
      if (!answer.ok) {
        audit('handoff-attest', target, 'refused', `${answer.body.error}: ${answer.reason}`);
        return send(res, answer);
      }
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (route === 'POST handoff/options') {
      let answer;
      try {
        answer = await handoff.options({
          member,
          hostname,
          body,
          issue: (record) => {
            const refused = authorize(record, here, standing);
            if (refused) throw new Refused(refused);
            return passkeys.checkOptions({ site: here, standing, ...bound(record) });
          },
        });
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        sendJson(res, error.refusal.status, error.refusal.body);
        return true;
      }
      if (!answer.ok) return send(res, answer);
      sendJson(res, 200, { options: answer.options, summary: summary(answer.record, here, standing) });
      return true;
    }

    if (route === 'POST handoff/finish') {
      const answer = await handoff.finish({
        member,
        hostname,
        body,
        verify: async (record, assertion) => {
          const what = record.purpose === 'action' ? 'passkey-action' : 'passkey-step-up';
          const refused = authorize(record, here, standing);
          if (refused) {
            audit(what, target, 'refused', refused.body.code);
            return { ok: false, ...refused };
          }
          const result = await passkeys.checkFinish({ site: here, standing, ...bound(record), response: assertion });
          if (!result.ok) {
            audit(what, target, 'refused', result.reason);
            return { ok: false, status: 400, body: { error: shared.ceremonyError('The check', result.reason), code: 'CEREMONY_REFUSED' } };
          }
          // Read again, as check/finish does: a recovery, reset or revocation since begin means no result.
          const current = directory.standing(standing.member.userId);
          if (shared.moved(shared.expectOf(standing), current)) {
            audit(what, target, 'refused', 'STALE');
            return { ok: false, status: 409, body: { error: 'Home Base changed while this was in progress; start again.', code: 'STALE' } };
          }
          if (record.purpose === 'action') {
            const issued = passkeys.issueActionToken({ site: here, standing: current, app: shared.homeBaseApp, act: record.policy, tgt: record.action.target, dig: record.action.digest, credentialId: result.credentialId, kind: result.kind });
            audit(what, target, `confirmed ${record.policy} ${record.action.target} with ${shared.usedPasskey(current, result.credentialId)} in the app (key ${record.keyId.slice(0, 12)}…) · jti ${issued.jti} · key ${issued.kid}`);
            return { ok: true, result: { token: issued.token } };
          }
          const issued = passkeys.issueCookie({ site: here, standing: current, credentialId: result.credentialId, kind: result.kind, windowSeconds: shared.windowSeconds(here) });
          audit(what, target, `checked ${result.kind} with ${shared.usedPasskey(current, result.credentialId)} on ${hostname} in the app (key ${record.keyId.slice(0, 12)}…) · sid ${issued.sid} · key ${issued.kid}`);
          return { ok: true, result: { cookie: issued.header } };
        },
      });
      if (!answer.ok) return send(res, answer);
      sendJson(res, 200, answer.body);
      return true;
    }

    if (route === 'POST handoff/redeem') {
      const answer = await handoff.redeem({ member, hostname, headers: req.headers, body });
      if (!answer.ok) {
        audit('handoff-redeem', target, 'refused', answer.reason);
        return send(res, answer);
      }
      // The check's cookie lands in the page's cookie jar here, beside the handoff cookie being cleared.
      res.setHeader('Set-Cookie', answer.result.cookie ? [answer.result.cookie, answer.clearCookie] : [answer.clearCookie]);
      sendJson(res, 200, answer.result.token ? { ok: true, token: answer.result.token } : { ok: true });
      return true;
    }
    return false;
  }

  return { handle };
}

// GET handoff/sheet and handoff/sheet.js: the same for everyone, nothing read or changed.
function serveSheet(res, route) {
  if (route === 'GET handoff/sheet.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(SHEET_SCRIPT);
    return true;
  }
  res.writeHead(200, SHEET_HEADERS);
  res.end(SHEET_PAGE);
  return true;
}

module.exports = { createHandoffRoutes, serveSheet };
