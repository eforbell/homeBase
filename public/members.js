// Feature-10: the Members card on the Admin page. It lists the household directory, who has a passkey, and gives
// the administrator a single-use enrollment code for a member who has none (POST /api/directory/members/<id>/grant).
// It shows only what GET /api/directory gives an unlocked administrator: never a key, and a code only once.
(function homeBaseMembers() {
  const esc = (value) => window.HB.escapeHtml(value);
  const KIND_LABELS = { hardware: 'hardware key', 'device-bound': 'this device only', synced: 'synced passkey' };
  // Revoked passkeys, and those orphaned by a recovery, don't count: a member with only those needs a code.
  const usable = (member) => (member.credentials || []).filter((credential) => !credential.revokedAt && !credential.orphaned);
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function passkeyLine(member) {
    const own = usable(member);
    if (own.length) {
      const kinds = [...new Set(own.map((credential) => KIND_LABELS[credential.kind] || credential.kind))].join(', ');
      return `<span class="hb-ok">${own.length} passkey${own.length === 1 ? '' : 's'}</span> · ${esc(kinds)}`;
    }
    const pending = member.grantExpiresAt && Date.parse(member.grantExpiresAt) > Date.now();
    return pending
      ? `<span class="hb-warn">No passkey yet</span> · a code is waiting until ${esc(time(member.grantExpiresAt))}`
      : '<span class="hb-warn">No passkey yet</span>';
  }

  // A code is for an active member with no passkey, in active Home Base: before then, only the administrator enrolls.
  const mayIssue = (directory, member) => directory.state === 'active' && member.status === 'active' && !usable(member).length;

  function memberRow(directory, member) {
    const tags = [member.role, member.administrator ? 'administrator' : '', member.status !== 'active' ? member.status : ''].filter(Boolean);
    const apps = member.apps && member.apps.length ? member.apps.join(', ') : 'no apps';
    const issue = mayIssue(directory, member)
      ? `<button class="hb-btn" type="button" data-member-grant="${esc(member.memberId)}" data-member-name="${esc(member.name || member.login)}">${member.grantExpiresAt ? 'Issue a new code' : 'Issue enrollment code'}</button>`
      : '';
    return `
      <li class="hb-members-row" data-member="${esc(member.memberId)}">
        <div class="hb-members-who">
          <strong>${esc(member.name || member.login)}</strong>
          <span class="hb-muted">${esc(member.login)}</span>
        </div>
        <div class="hb-members-tags">${tags.map((tag) => `<span class="hb-badge">${esc(tag)}</span>`).join('')}</div>
        <p class="hb-muted hb-members-line">Apps: ${esc(apps)}</p>
        <p class="hb-members-line">${passkeyLine(member)}</p>
        ${issue}
        <div data-member-code></div>
        <div data-member-error></div>
      </li>`;
  }

  function render(directory) {
    const members = directory.members || [];
    const note = directory.state === 'active'
      ? 'A member with no passkey registers one with an enrollment code: it works once, for 15 minutes, on Home Base\'s own address.'
      : `Home Base is in ${directory.state}: only the administrator registers passkeys until it is active.`;
    return `
      <h2 style="margin-top:0;">Members</h2>
      <p class="hb-muted" style="margin:0 0 0.8rem;">${esc(note)}</p>
      <ul class="hb-members">${members.length ? members.map((member) => memberRow(directory, member)).join('') : '<li class="hb-muted">No members yet.</li>'}</ul>`;
  }

  // The code, once: Home Base keeps only its hash, so it can't be shown again; a new one replaces it.
  function codeBlock(name, grant) {
    return `
      <div class="hb-members-code" role="status">
        <p style="margin:0 0 0.4rem;">Enrollment code for ${esc(name)}, until ${esc(time(grant.expiresAt))}:</p>
        <code data-code>${esc(grant.code)}</code>
        <button class="hb-btn" type="button" data-member-copy>Copy</button>
        <p class="hb-muted" style="margin:0.4rem 0 0;">Give it to them yourself. On Home Base's address they open Admin, enter the code under Passkeys and register one. It works once, and this page won't show it again.</p>
      </div>`;
  }

  // What the card shows is the unlocked administrator's: it goes when admin is locked here or the session ends, and a
  // code goes when it expires.
  const LOCKED = '<h2 style="margin-top:0;">Members</h2><p class="hb-muted" style="margin:0;">Unlock admin to see members.</p>';
  const MAX_TIMER = 2 ** 31 - 1;
  // A card once cleared stays cleared: a directory answer still on its way when admin locked doesn't bring it back.
  const cleared = new WeakSet();
  function clearCard(node) {
    cleared.add(node);
    node.innerHTML = LOCKED;
  }
  function clearAt(iso, clear) {
    const wait = Date.parse(iso) - Date.now();
    if (Number.isFinite(wait) && wait < MAX_TIMER) setTimeout(clear, Math.max(0, wait));
  }

  async function mount(node, { sessionExpiresAt } = {}) {
    if (sessionExpiresAt) clearAt(sessionExpiresAt, () => clearCard(node));
    let directory;
    try {
      directory = await window.HB.getJson('/api/directory');
    } catch (error) {
      node.innerHTML = `<h2 style="margin-top:0;">Members</h2><p class="hb-warn" style="margin:0;">${esc(error.message)}</p>`;
      return null;
    }
    if (cleared.has(node)) return null;
    // Anyone but an unlocked administrator learns only the state.
    if (!Array.isArray(directory.members)) {
      node.remove();
      return null;
    }
    node.innerHTML = render(directory);
    return directory;
  }

  function wire(node) {
    // Capturing, so the card is cleared before the lock request even leaves.
    document.addEventListener('submit', (event) => {
      if (event.target.closest && event.target.closest('form[data-action="admin-lock"]')) clearCard(node);
    }, true);
    node.addEventListener('click', async (event) => {
      const copy = event.target.closest('[data-member-copy]');
      if (copy) {
        const code = copy.parentElement.querySelector('[data-code]').textContent;
        try { await navigator.clipboard.writeText(code); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select it to copy'; }
        return;
      }
      const button = event.target.closest('[data-member-grant]');
      if (!button) return;
      const slot = button.parentElement.querySelector('[data-member-code]');
      const problem = button.parentElement.querySelector('[data-member-error]');
      button.disabled = true;
      problem.innerHTML = '<p class="hb-muted" style="margin:0.4rem 0 0;">Issuing…</p>';
      try {
        const grant = await window.HB.postJson(`/api/directory/members/${encodeURIComponent(button.dataset.memberGrant)}/grant`, {});
        problem.innerHTML = '';
        slot.innerHTML = codeBlock(button.dataset.memberName, grant);
        const shown = slot.firstElementChild;
        clearAt(grant.expiresAt, () => { if (slot.firstElementChild === shown) slot.innerHTML = '<p class="hb-muted" style="margin:0.4rem 0 0;">That code has expired.</p>'; });
        button.textContent = 'Issue a new code';
      } catch (error) {
        // A code already shown stays: a refused replacement leaves it valid, and Home Base can't show it again.
        problem.innerHTML = `<p class="hb-warn" style="margin:0.4rem 0 0;">${esc(error.message)}</p>`;
      }
      button.disabled = false;
    });
  }

  window.HBMembers = { mount, wire, render };
})();
