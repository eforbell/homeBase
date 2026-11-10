// Feature-10: the Members card on the Admin page. It lists the household directory, who has a passkey, and gives
// the administrator a single-use enrollment code for a member who has none (POST /api/directory/members/<id>/grant).
// It also adds a member from the tailnet accounts that opened Home Base in the last day (POST /api/directory/members),
// and changes which apps a member may open (POST /api/directory/members/<id> with apps).
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

  // The codes this page has shown, by member. Home Base keeps only their hash, so when the card is drawn again (after
  // adding someone, or Check again) a code still valid is drawn with it; it goes when it expires or the card clears.
  // Still valid means the directory still holds it: the waiting code has its expiry. One used, or replaced from
  // another tab, isn't drawn.
  const shownCodes = new Map();
  const liveCode = (directory, member) => {
    const entry = shownCodes.get(member.memberId);
    return entry && mayIssue(directory, member) && entry.grant.expiresAt === member.grantExpiresAt
      && Date.parse(entry.grant.expiresAt) > Date.now() ? entry : null;
  };

  // Members are added and edited while Home Base is being set up or is active, as the directory allows.
  const mayEdit = (directory) => ['setup', 'active'].includes(directory.state);

  // The apps this host runs that the member may open, by name. A member on the default is marked so: an app installed
  // later reaches them, where a chosen list stays as chosen.
  function appsLine(directory, member) {
    const own = member.apps || [];
    if (!Array.isArray(directory.catalogApps)) return own.length ? own.join(', ') : 'no apps';
    const names = directory.catalogApps.filter((app) => app.installed && own.includes(app.id)).map((app) => app.name);
    return `${names.length ? names.join(', ') : 'no apps'}${member.appsDefault ? ' (the default)' : ''}`;
  }

  // Choosing a member's apps: the default, or a list. The list offers the apps installed here, and any app not installed
  // that the member's list already names, or that an open editor's unsaved list (draft) has chosen, so saving doesn't
  // drop it unseen.
  function appsEditor(directory, member, draft) {
    if (!mayEdit(directory) || !Array.isArray(directory.catalogApps)) return '';
    const id = esc(member.memberId);
    const own = new Set(member.apps || []);
    const onDefault = Boolean(member.appsDefault);
    const byDefault = (app) => member.administrator || !app.administratorDefault;
    const drafted = draft && draft.mode === 'only' ? draft.chosen : new Set();
    const offered = directory.catalogApps.filter((app) => app.installed || (!onDefault && own.has(app.id)) || drafted.has(app.id));
    // Every app the default leaves out, installed or not: one installed later stays out too.
    const held = directory.catalogApps.filter((app) => !byDefault(app)).map((app) => app.name);
    const defaultLabel = held.length ? `The default: every app but ${held.join(', ')}` : 'The default: every app';
    const box = (app) => {
      const notes = [app.installed ? '' : 'not installed', byDefault(app) ? '' : 'administrator\'s by default'].filter(Boolean);
      return `<label class="hb-members-app"><input type="checkbox" value="${esc(app.id)}" data-member-app data-by-default="${byDefault(app) ? 'yes' : 'no'}" data-installed="${app.installed ? 'yes' : 'no'}"${own.has(app.id) ? ' checked' : ''}${onDefault ? ' disabled' : ''}> <span>${esc(app.name)}${notes.length ? ` <span class="hb-muted">(${esc(notes.join(', '))})</span>` : ''}</span></label>`;
    };
    return `
        <details class="hb-members-apps" data-member-apps="${id}">
          <summary>Change apps</summary>
          <fieldset aria-label="${esc(`Apps for ${member.name || member.login}`)}">
            <label class="hb-members-app"><input type="radio" name="apps-${id}" value="default" data-member-apps-mode${onDefault ? ' checked' : ''}> <span>${esc(defaultLabel)}</span></label>
            <label class="hb-members-app"><input type="radio" name="apps-${id}" value="only" data-member-apps-mode${onDefault ? '' : ' checked'}> <span>Only these:</span></label>
            <div class="hb-members-app-list">${offered.length ? offered.map(box).join('') : '<span class="hb-muted">No apps are installed yet.</span>'}</div>
          </fieldset>
          <p class="hb-muted hb-members-line">An app opens for them only if it is chosen here. A change ends the passkey confirmations they gave apps; an app asks again when it needs one.</p>
          <button class="hb-btn" type="button" data-member-apps-save="${id}">Save apps</button>
        </details>`;
  }

  function memberRow(directory, member, drafts) {
    const tags = [member.role, member.administrator ? 'administrator' : '', member.status !== 'active' ? member.status : ''].filter(Boolean);
    const apps = appsLine(directory, member);
    const shown = liveCode(directory, member);
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
        ${appsEditor(directory, member, drafts && drafts.get(member.memberId))}
        ${issue}
        <div data-member-code>${shown ? codeBlock(shown.name, shown.grant) : ''}</div>
        <div data-member-error></div>
      </li>`;
  }

  const seen = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  // Someone who opened Home Base from their own tailnet account and isn't a member. The role has no default: parent
  // reaches the money apps, so the administrator picks it every time.
  function candidateRow(candidate) {
    const shown = candidate.name || candidate.login;
    return `
      <li class="hb-members-row" data-candidate="${esc(candidate.userId)}">
        <div class="hb-members-who">
          <strong>${esc(shown)}</strong>
          <span class="hb-muted">${esc(candidate.login)}</span>
        </div>
        <p class="hb-muted hb-members-line">Opened Home Base ${esc(seen(candidate.seenAt))}</p>
        <div class="hb-members-add">
          <label class="hb-label">Name <input class="hb-input" data-candidate-name maxlength="80" autocomplete="off" value="${esc(shown)}"></label>
          <label class="hb-label">Role
            <select class="hb-select" data-candidate-role>
              <option value="" selected disabled>Choose…</option>
              <option value="parent">parent</option>
              <option value="kid">kid</option>
            </select>
          </label>
          <button class="hb-btn" type="button" data-member-add="${esc(candidate.userId)}">Add member</button>
        </div>
        <div data-member-error></div>
      </li>`;
  }

  function addSection(directory) {
    if (!mayEdit(directory)) return '';
    const candidates = directory.candidates || [];
    const how = 'To add someone, have them open Home Base on their own device, signed in to the tailnet as themselves; they appear here for a day.';
    return `
      <h3 style="margin:1.2rem 0 0.3rem;">Add a member</h3>
      <p class="hb-muted" style="margin:0 0 0.6rem;">${esc(how)}</p>
      ${candidates.length ? `<ul class="hb-members">${candidates.map(candidateRow).join('')}</ul>` : '<p class="hb-muted" style="margin:0 0 0.6rem;">No one new has opened Home Base yet.</p>'}
      <div><button class="hb-btn" type="button" data-members-refresh>Check again</button><div data-members-refresh-error></div></div>`;
  }

  function render(directory, drafts) {
    const members = directory.members || [];
    const note = directory.state === 'active'
      ? 'A member with no passkey registers one with an enrollment code: it works once, for 15 minutes, on Home Base\'s own address.'
      : `Home Base is in ${directory.state}: only the administrator registers passkeys until it is active.`;
    return `
      <h2 style="margin-top:0;">Members</h2>
      <p class="hb-muted" style="margin:0 0 0.8rem;">${esc(note)}</p>
      <ul class="hb-members">${members.length ? members.map((member) => memberRow(directory, member, drafts)).join('') : '<li class="hb-muted">No members yet.</li>'}</ul>
      ${addSection(directory)}`;
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
    shownCodes.clear();
    node.innerHTML = LOCKED;
  }
  function clearAt(iso, clear) {
    const wait = Date.parse(iso) - Date.now();
    if (Number.isFinite(wait) && wait < MAX_TIMER) setTimeout(clear, Math.max(0, wait));
  }

  // Only the latest read of the directory is drawn: an earlier one answering late would undo what came after it.
  const reads = new WeakMap();

  // An app editor open when the card is drawn again stays open with what was chosen in it and not yet saved, except
  // the one just saved (settled), which shows what was saved.
  const cssEscape = (value) => (window.CSS && window.CSS.escape ? window.CSS.escape(value) : value);
  function draftsOf(node) {
    const drafts = new Map();
    if (!node.querySelectorAll) return drafts;
    for (const editor of node.querySelectorAll('[data-member-apps]')) {
      if (!editor.open) continue;
      const mode = editor.querySelector('[data-member-apps-mode]:checked');
      drafts.set(editor.dataset.memberApps, { mode: mode ? mode.value : null, chosen: new Set([...editor.querySelectorAll('[data-member-app]:checked')].map((box) => box.value)) });
    }
    return drafts;
  }
  // The default chosen: its boxes show what the default gives now, which an app installed meanwhile may change.
  function restoreDrafts(node, drafts) {
    for (const [memberId, draft] of drafts) {
      const editor = node.querySelector(`[data-member-apps="${cssEscape(memberId)}"]`);
      if (!editor) continue;
      editor.open = true;
      if (!draft.mode) continue;
      for (const radio of editor.querySelectorAll('[data-member-apps-mode]')) radio.checked = radio.value === draft.mode;
      for (const box of editor.querySelectorAll('[data-member-app]')) {
        box.checked = draft.mode === 'default' ? box.dataset.byDefault === 'yes' : draft.chosen.has(box.value);
        box.disabled = draft.mode === 'default';
      }
    }
  }
  const warn = (message) => `<p class="hb-warn" style="margin:0.4rem 0 0;">${esc(message)}</p>`;

  // failed(message): how a failed re-read is reported, keeping the card as it is; without it, the card says it.
  async function mount(node, { sessionExpiresAt, failed, settled } = {}) {
    if (sessionExpiresAt) clearAt(sessionExpiresAt, () => clearCard(node));
    const read = (reads.get(node) || 0) + 1;
    reads.set(node, read);
    let directory;
    try {
      directory = await window.HB.getJson('/api/directory');
    } catch (error) {
      if (cleared.has(node) || reads.get(node) !== read) return null;
      if (failed) failed(error.message);
      else node.innerHTML = `<h2 style="margin-top:0;">Members</h2><p class="hb-warn" style="margin:0;">${esc(error.message)}</p>`;
      return null;
    }
    if (cleared.has(node) || reads.get(node) !== read) return null;
    // Anyone but an unlocked administrator learns only the state.
    if (!Array.isArray(directory.members)) {
      node.remove();
      return null;
    }
    const drafts = draftsOf(node);
    drafts.delete(settled);
    node.innerHTML = render(directory, drafts);
    restoreDrafts(node, drafts);
    return directory;
  }

  async function checkAgain(node, refresh) {
    refresh.disabled = true;
    const problem = refresh.parentElement.querySelector('[data-members-refresh-error]');
    problem.innerHTML = '';
    const failed = (message) => { problem.innerHTML = warn(`${message} Reload the page to see the list.`); };
    if (!await mount(node, { failed })) refresh.disabled = false;
  }

  async function addMember(node, add) {
    const row = add.closest('[data-candidate]');
    const problem = row.querySelector('[data-member-error]');
    const role = row.querySelector('[data-candidate-role]').value;
    const name = row.querySelector('[data-candidate-name]').value.trim();
    if (!role) {
      problem.innerHTML = warn('Choose parent or kid first.');
      return;
    }
    add.disabled = true;
    problem.innerHTML = '<p class="hb-muted" style="margin:0.4rem 0 0;">Adding…</p>';
    try {
      await window.HB.postJson('/api/directory/members', { userId: add.dataset.memberAdd, role, ...(name ? { name } : {}) });
    } catch (error) {
      problem.innerHTML = warn(error.message);
      add.disabled = false;
      return;
    }
    // The new member is listed with the others, and in active Home Base offered an enrollment code. If the list
    // can't be read again, the row says the add went through; its button stays off, as the account is a member.
    await mount(node, { failed: (message) => { problem.innerHTML = warn(`Added, but the list couldn't be read again: ${message} Reload the page to see it.`); } });
  }

  // Saves the member's apps: null for the default, or the chosen list. The card is then drawn again from the directory.
  async function saveApps(node, save) {
    const editor = save.closest('[data-member-apps]');
    const problem = save.closest('[data-member]').querySelector('[data-member-error]');
    const mode = editor.querySelector('[data-member-apps-mode]:checked');
    const chosen = mode && mode.value === 'only' ? [...editor.querySelectorAll('[data-member-app]:checked')] : null;
    const apps = chosen && chosen.map((box) => box.value);
    // A list with no app installed here is a member who can open nothing: that's what disabling them is for.
    if (chosen && !chosen.some((box) => box.dataset.installed === 'yes')) {
      problem.innerHTML = warn('Choose at least one installed app, or the default.');
      return;
    }
    save.disabled = true;
    problem.innerHTML = '<p class="hb-muted" style="margin:0.4rem 0 0;">Saving…</p>';
    try {
      await window.HB.postJson(`/api/directory/members/${encodeURIComponent(save.dataset.memberAppsSave)}`, { apps });
    } catch (error) {
      problem.innerHTML = warn(error.message);
      save.disabled = false;
      return;
    }
    await mount(node, { settled: save.dataset.memberAppsSave, failed: (message) => {
      problem.innerHTML = warn(`Saved, but the list couldn't be read again: ${message} Reload the page to see it.`);
      save.disabled = false;
    } });
  }

  // The default chosen: the boxes show what the default gives and can't be changed. A list chosen: they can.
  function chooseMode(radio) {
    const editor = radio.closest('[data-member-apps]');
    const onDefault = radio.value === 'default';
    for (const box of editor.querySelectorAll('[data-member-app]')) {
      box.disabled = onDefault;
      if (onDefault) box.checked = box.dataset.byDefault === 'yes';
    }
  }

  async function issueCode(node, button) {
    const slot = button.parentElement.querySelector('[data-member-code]');
    const problem = button.parentElement.querySelector('[data-member-error]');
    const memberId = button.dataset.memberGrant;
    button.disabled = true;
    problem.innerHTML = '<p class="hb-muted" style="margin:0.4rem 0 0;">Issuing…</p>';
    try {
      const grant = await window.HB.postJson(`/api/directory/members/${encodeURIComponent(memberId)}/grant`, {});
      // Locked meanwhile: this code is shown nowhere and remembered nowhere.
      if (cleared.has(node)) return;
      problem.innerHTML = '';
      const entry = { name: button.dataset.memberName, grant };
      shownCodes.set(memberId, entry);
      slot.innerHTML = codeBlock(entry.name, grant);
      // The card may be drawn again before the code expires: expire it wherever it is drawn then.
      clearAt(grant.expiresAt, () => {
        if (shownCodes.get(memberId) !== entry) return;
        shownCodes.delete(memberId);
        const live = (node.querySelector && node.querySelector(`[data-member="${cssEscape(memberId)}"] [data-member-code]`)) || slot;
        // Drawn again after the code was used, the row shows no code: leave it so.
        if (live === slot || live.querySelector('[data-code]')) live.innerHTML = '<p class="hb-muted" style="margin:0.4rem 0 0;">That code has expired.</p>';
      });
      button.textContent = 'Issue a new code';
    } catch (error) {
      if (cleared.has(node)) return;
      // A code already shown stays: a refused replacement leaves it valid, and Home Base can't show it again.
      problem.innerHTML = warn(error.message);
    } finally {
      button.disabled = false;
    }
  }

  // One action at a time on a card: while a code is issued, a member added or the list read, the card isn't drawn
  // again under it, so an answer always lands in the row it was asked from. Copy is always open.
  const busy = new WeakSet();
  const setBusy = (node, on) => {
    if (on) busy.add(node); else busy.delete(node);
    if (node.setAttribute) node.setAttribute('aria-busy', on ? 'true' : 'false');
  };

  function wire(node) {
    // Capturing, so the card is cleared before the lock request even leaves.
    document.addEventListener('submit', (event) => {
      if (event.target.closest && event.target.closest('form[data-action="admin-lock"]')) clearCard(node);
    }, true);
    node.addEventListener('change', (event) => {
      const radio = event.target.closest && event.target.closest('[data-member-apps-mode]');
      if (radio && radio.checked) chooseMode(radio);
    });
    node.addEventListener('click', async (event) => {
      const copy = event.target.closest('[data-member-copy]');
      if (copy) {
        const code = copy.parentElement.querySelector('[data-code]').textContent;
        try { await navigator.clipboard.writeText(code); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select it to copy'; }
        return;
      }
      const refresh = event.target.closest('[data-members-refresh]');
      const add = event.target.closest('[data-member-add]');
      const button = event.target.closest('[data-member-grant]');
      const save = event.target.closest('[data-member-apps-save]');
      if ((!refresh && !add && !button && !save) || busy.has(node)) return;
      setBusy(node, true);
      try {
        if (refresh) await checkAgain(node, refresh);
        else if (add) await addMember(node, add);
        else if (save) await saveApps(node, save);
        else await issueCode(node, button);
      } finally {
        setBusy(node, false);
      }
    });
  }

  window.HBMembers = { mount, wire, render };
})();
