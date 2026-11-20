// The native handoff's sheet (sovereignAuth wire contract, section 13), served at
// /_sovereign/auth/handoff/sheet.js for the page at /_sovereign/auth/handoff/sheet#<id>. The household's app
// opens that page in an ephemeral ASWebAuthenticationSession, which can run the passkey ceremony its own web
// view can't. The page asks Home Base what is being confirmed, shows it, and on the member's tap (the gesture
// iOS needs before a passkey prompt) runs the ceremony and sends it to Home Base, which keeps the result for
// the app's page. To add a passkey (Part 3), the ceremony registers one, and Home Base stores it. Then it
// goes to the app's callback, which closes the sheet; the callback carries nothing.
// A "Return to the app" link stays for when iOS wants a tap to go back.
(function handoffSheet() {
  const AUTH = '/_sovereign/auth/';
  const id = location.hash.slice(1);
  // The id leaves the address bar at once: it is the handoff's name, and nothing here needs to show it.
  history.replaceState(null, '', location.pathname);

  const summary = document.getElementById('summary');
  const go = document.getElementById('go');
  const status = document.getElementById('status');
  const back = document.getElementById('back');
  const say = (text) => { status.textContent = text; };

  const toBytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  const toText = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function post(path, body) {
    const response = await fetch(AUTH + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.reason ? `This confirmation can't continue (${payload.reason}). Go back to the app and try again.` : (payload.error || `Request failed (${response.status})`));
    return payload;
  }

  const withIds = (list) => (list || []).map((entry) => ({ ...entry, id: toBytes(entry.id) }));
  async function prompt(run) {
    try {
      return await run();
    } catch (error) {
      if (error && error.name === 'NotAllowedError') throw new Error('The passkey prompt was cancelled or timed out. Tap to try again.');
      if (error && error.name === 'InvalidStateError') throw new Error('That passkey is already registered with Home Base. Choose another, or go back to the app.');
      throw error;
    }
  }

  // A registration, encoded as Home Base's Passkeys page sends one to enroll/finish.
  async function registration(options) {
    const publicKey = { ...options, challenge: toBytes(options.challenge), user: { ...options.user, id: toBytes(options.user.id) }, excludeCredentials: withIds(options.excludeCredentials) };
    const credential = await prompt(() => navigator.credentials.create({ publicKey }));
    return {
      id: credential.id,
      rawId: toText(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: toText(credential.response.clientDataJSON),
        attestationObject: toText(credential.response.attestationObject),
        transports: typeof credential.response.getTransports === 'function' ? credential.response.getTransports() : [],
      },
      clientExtensionResults: credential.getClientExtensionResults(),
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
    };
  }

  async function assertion(options) {
    const publicKey = { ...options, challenge: toBytes(options.challenge), allowCredentials: withIds(options.allowCredentials) };
    const credential = await prompt(() => navigator.credentials.get({ publicKey }));
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

  // The options come before the tap, so the prompt starts inside it. A failed attempt fetches new ones: the
  // record has one live challenge, and each options call replaces it.
  let options = null;
  let ceremony = 'get';
  async function prepare() {
    go.disabled = true;
    const answer = await post('handoff/options', { id });
    options = answer.options;
    ceremony = answer.ceremony === 'create' ? 'create' : 'get';
    if (ceremony === 'create') {
      document.title = 'Add a passkey';
      document.querySelector('h1').textContent = 'Add a passkey';
      go.textContent = 'Add passkey';
    }
    summary.textContent = answer.summary;
    summary.className = '';
    go.disabled = false;
  }

  function finished(url) {
    go.hidden = true;
    summary.className = 'muted';
    say('Done. Returning to the app…');
    back.href = url;
    back.hidden = false;
    location.href = url;
  }

  go.addEventListener('click', async () => {
    if (!options) return;
    go.disabled = true;
    say('');
    const current = options;
    options = null;
    try {
      const answer = await post('handoff/finish', { id, assertion: ceremony === 'create' ? await registration(current) : await assertion(current) });
      finished(answer.return);
    } catch (error) {
      say(error.message);
      prepare().catch((problem) => say(problem.message));
    }
  });

  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) {
    summary.textContent = 'Nothing to confirm here. Go back to the app and try again.';
    return;
  }
  prepare().catch((error) => { summary.textContent = error.message; });
})();
