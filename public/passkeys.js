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

  async function enroll({ label, hardware, grant }) {
    const { options } = await window.HB.postJson(`${AUTH}enroll/options`, { label, hardware, grant });
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
      if (!status.credentials.length) return 'You have no passkey yet: enter the enrollment code the administrator gave you, then register one.';
      return status.check ? '' : 'Check with one of your passkeys to open your session on this hostname.';
    }
    if (!admin) return `Home Base is in ${status.state}: only the administrator registers passkeys now.`;
    if (!status.administratorRuleMet) {
      const hardware = status.credentials.some((credential) => credential.kind === 'hardware');
      return `To finish ${status.state}, register at least two passkeys${hardware ? '' : ', including a hardware security key (tick "hardware key")'}. Then finish with the hardware key.`;
    }
    return status.canActivate ? 'Ready: finish with your hardware key to make Home Base active.' : 'Unlock with the passphrase above to finish.';
  }

  function render(status) {
    const rows = status.credentials.length
      ? status.credentials.map((credential) => `
          <li class="hb-row" style="flex-wrap:wrap;gap:0.4rem;">
            <strong>${esc(credential.label)}</strong>
            <span class="hb-muted">${esc(KIND_LABELS[credential.kind] || credential.kind)} · added ${esc(ago(credential.createdAt))} · last used ${esc(ago(credential.lastUsedAt))}</span>
            ${status.member.administrator ? '' : `<button class="hb-btn" type="button" data-passkey-revoke="${esc(credential.credentialId)}" style="margin-left:auto;">Remove</button>`}
          </li>`).join('')
      : '<li class="hb-muted">No passkeys yet.</li>';
    const checkLine = status.check
      ? `<span class="hb-ok">Checked ${esc(ago(status.check.checkedAt))}</span> with ${esc(status.check.label || 'a removed passkey')} (${esc(KIND_LABELS[status.check.kind] || status.check.kind)})`
      : '<span class="hb-warn">Not checked on this hostname</span>';
    const needsGrant = status.state === 'active' && !status.member.administrator && !status.credentials.length;
    const step = nextStep(status);
    return `
      <h2 style="margin-top:0;">Passkeys</h2>
      <p class="hb-muted" style="margin:0 0 0.6rem;">${esc(status.member.name || status.member.login)} · ${esc(status.member.role)}${status.member.administrator ? ' · administrator' : ''} · Home Base is <strong>${esc(status.state)}</strong></p>
      <p style="margin:0 0 0.6rem;">${checkLine}</p>
      ${step ? `<p class="hb-warn" style="margin:0 0 0.8rem;">${esc(step)}</p>` : ''}
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
          ${status.credentials.length ? '<form data-passkey-action="check"><button class="hb-btn" type="submit">Check with a passkey</button></form>' : ''}
          ${status.canActivate ? '<form data-passkey-action="activate"><button class="hb-btn hb-btn-primary" type="submit">Finish ${esc(status.state)} with my hardware key</button></form>' : ''}
          <p class="hb-muted" data-check-result style="margin:0;"></p>
        </div>
      </div>
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
        if (action === 'enroll') {
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
        await window.HB.postJson(`${AUTH}credentials/revoke`, { credentialId: button.dataset.passkeyRevoke });
        reload();
      } catch (error) {
        result.textContent = error.message;
      }
    });
  }

  window.HBPasskeys = { check, enroll, mount, wire };
})();
