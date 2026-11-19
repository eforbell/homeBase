// Feature-10 SID-005: the shared step-up helper, served at /_sovereign/auth/stepup.js (wire contract, section
// 8). A page sends a request through SovereignStepUp.fetch; when the answer is 401 step_up_required, the
// helper asks the member to confirm (the tap is the user gesture iOS needs before a passkey prompt), runs
// the ceremony with Home Base's passkey service on this hostname, and retries the identical request once:
// with the action token for an every-time policy, or with the assurance cookie the check just set. It never
// retries a request that changed, and a second refusal is the answer.
//
// Inside the household's iPhone app (window.sovereign, version 1), the page's web view can't run a passkey
// ceremony, so the helper hands it to the app (the native handoff, sovereignAuth wire contract section 13):
// after the same tap it begins a handoff here, the app attests it and opens a Safari sheet that runs the
// ceremony, and once the sheet closes the helper redeems the result here, the cookie or the token, and
// retries as before. One handoff at a time per page: other step-ups wait for it, and a check's cookie then
// serves them all. If the app can't do it on this phone, the helper says so instead of trying in the page.
(function sovereignStepUp() {
  const AUTH = '/_sovereign/auth/';
  const HEADER = 'X-Sovereign-Action-Token';

  const toBytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  const toText = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function post(path, body) {
    const response = await fetch(AUTH + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  async function assertion(options) {
    const publicKey = { ...options, challenge: toBytes(options.challenge), allowCredentials: (options.allowCredentials || []).map((entry) => ({ ...entry, id: toBytes(entry.id) })) };
    let credential;
    try {
      credential = await navigator.credentials.get({ publicKey });
    } catch (error) {
      if (error && error.name === 'NotAllowedError') throw new Error('The passkey prompt was cancelled or timed out.');
      throw error;
    }
    const { response } = credential;
    return {
      id: credential.id,
      rawId: toText(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: toText(response.clientDataJSON),
        authenticatorData: toText(response.authenticatorData),
        signature: toText(response.signature),
        userHandle: response.userHandle ? toText(response.userHandle) : undefined,
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }

  // A modal with one button: resolves true when the member taps it, false on cancel.
  function confirmTap(message, buttonText) {
    return new Promise((resolve) => {
      const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      const backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.55);';
      const panel = document.createElement('div');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.style.cssText = `max-width:420px;width:100%;box-sizing:border-box;padding:20px;border-radius:12px;font:16px/1.4 system-ui,-apple-system,sans-serif;background:${dark ? '#1c2230' : '#ffffff'};color:${dark ? '#e8ecf4' : '#14171f'};box-shadow:0 12px 40px rgba(0,0,0,0.35);`;
      const text = document.createElement('p');
      text.style.cssText = 'margin:0 0 16px;';
      text.textContent = message;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;';
      const button = (label, primary) => {
        const node = document.createElement('button');
        node.type = 'button';
        node.textContent = label;
        node.style.cssText = `min-height:44px;padding:0 16px;border-radius:8px;font:inherit;cursor:pointer;border:1px solid ${primary ? '#3b6fe0' : (dark ? '#4a5368' : '#c5cad6')};background:${primary ? '#3b6fe0' : 'transparent'};color:${primary ? '#ffffff' : 'inherit'};`;
        return node;
      };
      const cancel = button('Cancel', false);
      const confirm = button(buttonText, true);
      const close = (answer) => {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        resolve(answer);
      };
      const onKey = (event) => { if (event.key === 'Escape') close(false); };
      cancel.addEventListener('click', () => close(false));
      confirm.addEventListener('click', () => close(true));
      document.addEventListener('keydown', onKey, true);
      row.append(cancel, confirm);
      panel.append(text, row);
      backdrop.append(panel);
      document.body.append(backdrop);
      confirm.focus();
    });
  }

  // A message with one button, for what can't be done here.
  async function notice(message) {
    await confirmTap(message, 'OK');
  }

  // The household's app, when this page is in it: version 1 of window.sovereign, with handoff(id).
  function bridge() {
    const app = window.sovereign;
    return app && app.version === 1 && typeof app.handoff === 'function' ? app : null;
  }

  // The handoff in flight on this page: { check, hardware, done } where done settles to true once its result
  // was redeemed, false otherwise.
  let current = null;

  // A step-up through the app. Returns as satisfy does.
  async function satisfyInApp(app, stepUp, { confirmed = false } = {}) {
    const everyTime = stepUp.level === 'every-time';
    const hardware = stepUp.kind === 'hardware';
    // Wait for the handoff already running. A check that went through set this hostname's cookie, which
    // serves this check too unless this one needs hardware and that one didn't.
    while (current) {
      const before = current;
      const done = await before.done;
      if (done && !everyTime && before.check && (before.hardware || !hardware)) return null;
      if (current === before) current = null;
    }
    let settle;
    current = { check: !everyTime, hardware, done: new Promise((resolve) => { settle = resolve; }) };
    const mine = current;
    let redeemed = false;
    try {
      const message = stepUp.message || (everyTime ? 'Confirm this action with your passkey.' : 'Check with your passkey to continue.');
      if (!confirmed && !(await confirmTap(message, hardware ? 'Use hardware key' : 'Use passkey'))) return false;
      const request = everyTime
        ? { purpose: 'action', action: { policy: stepUp.policy, target: stepUp.target, digest: stepUp.digest } }
        : { purpose: 'check', kind: stepUp.kind };
      const { id } = await post('handoff/begin', request);
      try {
        await app.handoff(id);
      } catch (error) {
        // Cancelled, or not possible: the record is redeemed anyway, so its cookie goes now, and before the
        // next handoff starts, so a late answer can't land on top of it. If the sheet had in fact finished
        // (the app only lost the callback), that redemption is the result.
        const late = await post('handoff/redeem', { id }).catch(() => null);
        if (late) {
          redeemed = true;
          return everyTime ? late.token : null;
        }
        const reason = error && (error.message || error.code || error);
        if (reason === 'unavailable') {
          await notice('This check can\'t be done in the app on this phone. Open this page in Safari to continue.');
          return false;
        }
        if (reason === 'cancelled') return false;
        throw error instanceof Error ? error : new Error(String(reason || 'The app could not confirm this.'));
      }
      const answer = await post('handoff/redeem', { id });
      redeemed = true;
      return everyTime ? answer.token : null;
    } finally {
      settle(redeemed);
      if (current === mine) current = null;
    }
  }

  // The ceremony a step-up answer asks for. Returns the action token for an every-time policy, or null once
  // the check has set the cookie; false if the member cancelled. confirmed (in the app only): the page already
  // asked for the tap (a form's own button, say), so the helper doesn't ask again; in a browser the tap is
  // what starts the passkey prompt, so it is always asked for.
  async function satisfy(stepUp, { confirmed = false } = {}) {
    const app = bridge();
    if (app) return satisfyInApp(app, stepUp, { confirmed });
    const everyTime = stepUp.level === 'every-time';
    const request = everyTime
      ? { purpose: 'action', action: { policy: stepUp.policy, target: stepUp.target, digest: stepUp.digest } }
      : { purpose: 'step-up', kind: stepUp.kind };
    // The options first, so the passkey prompt starts inside the tap itself.
    const { options } = await post('check/options', request);
    const hardware = stepUp.kind === 'hardware';
    const message = stepUp.message || (everyTime ? 'Confirm this action with your passkey.' : 'Check with your passkey to continue.');
    if (!(await confirmTap(message, hardware ? 'Use hardware key' : 'Use passkey'))) return false;
    const response = await assertion(options);
    const answer = await post('check/finish', { ...request, response });
    return everyTime ? answer.token : null;
  }

  // fetch, plus one step-up and one identical retry. init.body must be a string (or absent), so the retry
  // sends the same bytes the action was bound to.
  async function stepUpFetch(url, init = {}) {
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new Error('SovereignStepUp.fetch needs a string body, so the retry is identical.');
    const send = (token) => {
      const headers = new Headers(init.headers || {});
      if (token) headers.set(HEADER, token);
      return fetch(url, { credentials: 'same-origin', ...init, headers });
    };
    const first = await send(null);
    if (first.status !== 401) return first;
    const stepUp = await first.clone().json().catch(() => null);
    if (!stepUp || stepUp.error !== 'step_up_required') return first;
    const token = await satisfy(stepUp);
    if (token === false) return first;
    return send(token);
  }

  window.SovereignStepUp = { fetch: stepUpFetch, satisfy, inApp: () => Boolean(bridge()) };
})();
