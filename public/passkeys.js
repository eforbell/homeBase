// Feature-10 SID-005: passkeys in Home Base's pages. The ceremonies themselves run in the server
// (/_sovereign/auth/); this file passes their options to the browser's WebAuthn API and the answer back, and
// draws the Passkeys card on the Admin page.
(function homeBasePasskeys() {
  const AUTH = '/_sovereign/auth/';
  const esc = (value) => window.HB.escapeHtml(value);

  const toBytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  const toText = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const withIds = (list) => (list || []).map((entry) => ({ ...entry, id: toBytes(entry.id) }));

  // The server's options are JSON (base64url for every byte string); the browser wants bytes.
  async function create(options) {
    const publicKey = { ...options, challenge: toBytes(options.challenge), user: { ...options.user, id: toBytes(options.user.id) }, excludeCredentials: withIds(options.excludeCredentials) };
    const credential = await navigator.credentials.create({ publicKey });
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

  async function get(options) {
    const publicKey = { ...options, challenge: toBytes(options.challenge), allowCredentials: withIds(options.allowCredentials) };
    const credential = await navigator.credentials.get({ publicKey });
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

  // A browser cancel or timeout reads better than the DOMException.
  function ceremonyError(error) {
    if (error && error.name === 'NotAllowedError') return new Error('The passkey prompt was cancelled or timed out.');
    if (error && error.name === 'InvalidStateError') return new Error('That passkey is already registered here.');
    return error;
  }

  // A POST that may need a step-up first (a recent check, or a hardware key every time): through the
  // shared helper when this hostname serves it.
  async function guardedPost(url, body) {
    if (!window.SovereignStepUp) return window.HB.postJson(url, body);
    const response = await window.SovereignStepUp.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || `Request failed (${response.status})`);
    return payload;
  }

  async function enroll({ label, hardware, grant }) {
    const { options } = await guardedPost(`${AUTH}enroll/options`, { label, hardware, grant });
    let response;
    try { response = await create(options); } catch (error) { throw ceremonyError(error); }
    return window.HB.postJson(`${AUTH}enroll/finish`, { label, hardware, grant, response });
  }

  async function check({ purpose = 'step-up', kind } = {}) {
    const { options } = await window.HB.postJson(`${AUTH}check/options`, { purpose, kind });
    let response;
    try { response = await get(options); } catch (error) { throw ceremonyError(error); }
    return window.HB.postJson(`${AUTH}check/finish`, { purpose, kind, response });
  }

  const KIND_LABELS = { hardware: 'hardware key (attested)', 'device-bound': 'this device only', synced: 'synced passkey' };

  function ago(iso) {
    if (!iso) return 'never';
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 90) return `${seconds} s ago`;
    if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 129600) return `${Math.round(seconds / 3600)} h ago`;
    return `${Math.round(seconds / 86400)} days ago`;
  }

  function nextStep(status) {
    const admin = status.member.administrator;
    if (status.state === 'active') {
      if (admin && !status.administratorRuleMet) return 'Your passkeys no longer include two with an attested hardware key (an update can stop trusting a maker\'s keys). Enter recovery with the passphrase and register a new hardware key.';
      if (!status.credentials.length) return 'You have no passkey yet: enter the enrollment code the administrator gave you, then register one.';
      // The check button beside the status says the rest.
      return '';
    }
    if (!admin) return `Home Base is in ${status.state}: only the administrator registers passkeys now.`;
    if (!status.administratorRuleMet) {
      const hardware = status.credentials.some((credential) => credential.kind === 'hardware');
      return `To finish ${status.state}, register at least two passkeys${hardware ? '' : ', including a hardware security key (tick "hardware key")'}. Then finish with the hardware key.`;
    }
    return status.canActivate ? 'Ready: finish with your hardware key to make Home Base active.' : 'Unlock with the passphrase above to finish.';
  }

  // The administrator's signing key line: which key signs, and the earlier ones still accepted.
  function signingKeyBlock(status) {
    const key = status.signingKey;
    if (!key || status.state !== 'active') return '';
    const previous = key.previous.length ? ` · ${key.previous.length} earlier key${key.previous.length === 1 ? '' : 's'} still accepted for 30 days after rotation` : '';
    return `
      <form class="hb-form-grid" data-passkey-action="rotate" style="margin-top:1rem;">
        <h3 style="margin:0;">Signing key</h3>
        <p class="hb-muted" style="margin:0;">${esc(key.kid)} · made ${esc(ago(key.createdAt))}${esc(previous)}. It signs every passkey check and confirmation; apps verify them with it.</p>
        <label class="hb-label hb-check-row"><input type="checkbox" name="exposed"> It may have been exposed: stop accepting every earlier key now (everyone checks in again)</label>
        <button class="hb-btn" type="submit">Rotate the signing key</button>
        <p class="hb-muted" data-result style="margin:0;"></p>
      </form>`;
  }

  function render(status) {
    const rows = status.credentials.length
      ? status.credentials.map((credential) => `
          <li class="hb-row" style="flex-wrap:wrap;gap:0.4rem;">
            <strong>${esc(credential.label)}</strong>
            <span class="hb-muted">${esc(KIND_LABELS[credential.kind] || credential.kind)} · added ${esc(ago(credential.createdAt))} · last used ${esc(ago(credential.lastUsedAt))}</span>
            ${status.member.administrator && status.state !== 'active' ? '' : `<button class="hb-btn" type="button" data-passkey-revoke="${esc(credential.credentialId)}" style="margin-left:auto;">Remove</button>`}
          </li>`).join('')
      : '<li class="hb-muted">No passkeys yet.</li>';
    const checkLine = status.check
      ? `<span class="hb-ok">Checked ${esc(ago(status.check.checkedAt))}</span> with ${esc(status.check.label || 'a removed passkey')} (${esc(KIND_LABELS[status.check.kind] || status.check.kind)})`
      : '<span class="hb-warn">Not checked on this hostname</span>';
    const needsGrant = status.state === 'active' && !status.member.administrator && !status.credentials.length;
    // The check beside the line it changes. For the administrator in active Home Base it is what unlocks
    // admin; for a member it only proves who they are (to the household's apps), never admin.
    const unlocks = status.member.administrator && status.state === 'active';
    const checkLabel = status.check ? 'Check again' : unlocks ? 'Unlock admin with a passkey' : 'Confirm it\'s me with a passkey';
    const checkButton = status.credentials.length && (status.state === 'active' || status.member.administrator)
      ? `<form data-passkey-action="check" style="margin:0;"><button class="hb-btn${status.check ? '' : ' hb-btn-primary'}" type="submit">${checkLabel}</button></form>`
      : '';
    const memberHint = !status.member.administrator && status.credentials.length
      ? '<p class="hb-muted" style="margin:0 0 0.8rem;">A check proves it\'s you to the household\'s apps. It doesn\'t open admin: that is the administrator\'s.</p>'
      : '';
    const step = nextStep(status);
    return `
      <h2 style="margin-top:0;">Passkeys</h2>
      <p class="hb-muted" style="margin:0 0 0.6rem;">${esc(status.member.name || status.member.login)} · ${esc(status.member.role)}${status.member.administrator ? ' · administrator' : ''} · Home Base is <strong>${esc(status.state)}</strong></p>
      <div class="hb-row" style="flex-wrap:wrap;gap:0.6rem;align-items:center;margin:0 0 0.6rem;">
        <span>${checkLine}</span>
        ${checkButton}
      </div>
      <p class="hb-muted" data-check-result style="margin:0 0 0.6rem;"></p>
      ${step ? `<p class="hb-warn" style="margin:0 0 0.8rem;">${esc(step)}</p>` : ''}
      ${memberHint}
      ${status.member.administrator && status.state === 'active' ? '<p class="hb-muted" style="margin:0 0 0.8rem;">Adding or removing your passkeys asks for your hardware key every time. Removing one ends your checks everywhere, so check again afterwards.</p>' : ''}
      <ul class="hb-stack" style="list-style:none;padding:0;margin:0 0 0.9rem;">${rows}</ul>
      <div class="hb-grid hb-grid-2">
        <form class="hb-form-grid" data-passkey-action="enroll">
          <label class="hb-label">Name for this passkey <input class="hb-input" name="label" maxlength="60" placeholder="e.g. iPhone, YubiKey 5C"></label>
          <label class="hb-label hb-check-row"><input type="checkbox" name="hardware"> It's a hardware security key (asks it to prove its maker)</label>
          ${needsGrant ? '<label class="hb-label">Enrollment code <input class="hb-input" name="grant" autocomplete="one-time-code"></label>' : ''}
          <button class="hb-btn" type="submit">Register a passkey</button>
          <p class="hb-muted" data-result style="margin:0;"></p>
        </form>
        <div class="hb-form-grid">
          ${status.canActivate ? `<form data-passkey-action="activate"><button class="hb-btn hb-btn-primary" type="submit">Finish ${esc(status.state)} with my hardware key</button></form>` : ''}
        </div>
      </div>
      ${signingKeyBlock(status)}
    `;
  }

  async function mount(node) {
    let status;
    try {
      status = await window.HB.getJson(`${AUTH}status`);
    } catch (error) {
      node.innerHTML = `<h2 style="margin-top:0;">Passkeys</h2><p class="hb-muted" style="margin:0;">${esc(/not found/i.test(error.message) ? 'Passkeys run on Home Base\'s own hostname, once this host uses per-service sockets.' : error.message)}</p>`;
      return;
    }
    node.innerHTML = render(status);
    return status;
  }

  function wire(node) {
    const reload = () => window.location.reload();
    node.addEventListener('submit', async (event) => {
      const form = event.target.closest('form[data-passkey-action]');
      if (!form) return;
      event.preventDefault();
      const action = form.dataset.passkeyAction;
      const result = form.querySelector('[data-result]') || node.querySelector('[data-check-result]');
      result.textContent = 'Waiting for your passkey…';
      try {
        if (action === 'rotate') {
          const done = await guardedPost(`${AUTH}signing-key/rotate`, { exposed: form.elements.exposed.checked });
          result.textContent = done.dropped ? `Rotated to ${done.kid}; earlier keys dropped. Check in again.` : `Rotated to ${done.kid}.`;
          setTimeout(reload, 1500);
        } else if (action === 'enroll') {
          const done = await enroll({ label: form.elements.label.value, hardware: form.elements.hardware.checked, grant: form.elements.grant ? form.elements.grant.value : undefined });
          result.textContent = done.askedForHardware && done.kind !== 'hardware' ? `Registered, but as a ${KIND_LABELS[done.kind]}: it did not prove it is a hardware key.` : 'Registered.';
          setTimeout(reload, 1200);
        } else {
          await check({ purpose: action === 'activate' ? 'activate' : 'step-up' });
          reload();
        }
      } catch (error) {
        result.textContent = error.message;
      }
    });
    node.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-passkey-revoke]');
      if (!button) return;
      const result = node.querySelector('[data-check-result]');
      try {
        await guardedPost(`${AUTH}credentials/revoke`, { credentialId: button.dataset.passkeyRevoke });
        reload();
      } catch (error) {
        result.textContent = error.message;
      }
    });
  }

  window.HBPasskeys = { check, enroll, mount, wire };
})();
