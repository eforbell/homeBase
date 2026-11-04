// Feature-10 SID-005: the shared step-up helper, served at /_sovereign/auth/stepup.js (wire contract, section
// 8). A page sends a request through SovereignStepUp.fetch; when the answer is 401 step_up_required, the
// helper asks the member to confirm (the tap is the user gesture iOS needs before a passkey prompt), runs
// the ceremony with Home Base's passkey service on this hostname, and retries the identical request once:
// with the action token for an every-time policy, or with the assurance cookie the check just set. It never
// retries a request that changed, and a second refusal is the answer.
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

  // The ceremony a step-up answer asks for. Returns the action token for an every-time policy, or null once
  // the check has set the cookie; false if the member cancelled.
  async function satisfy(stepUp) {
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

  window.SovereignStepUp = { fetch: stepUpFetch, satisfy };
})();
