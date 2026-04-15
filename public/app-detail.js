(function appDetailPage() {
  const root = document.getElementById('app');
  const appId = (window.location.pathname.split('/')[2] || '').trim();

  function renderError(message) {
    root.innerHTML = `
      <section class="hb-card">
        <h1 style="margin:0;">App not available</h1>
        <p class="hb-muted" style="margin-top:0.5rem;">${window.HB.escapeHtml(message || 'Unable to load app')}</p>
        <a href="/apps">← Back to Apps</a>
      </section>
    `;
  }

  function buildBackupOptions(backups) {
    if (!backups.length) {
      return '<option value="">No backups available</option>';
    }
    return backups.map((item) => `
      <option value="${window.HB.escapeHtml(item.archiveDir)}">${window.HB.escapeHtml(item.name || item.archiveDir)} — ${window.HB.escapeHtml(window.HB.formatTimestamp(item.generatedAt))}</option>
    `).join('');
  }

  async function runBackup(appId, button) {
    button.disabled = true;
    const prev = button.textContent;
    button.textContent = 'Running...';
    try {
      const payload = await window.HB.postJson(`/api/apps/${appId}/backup/execute`, { dryRun: true });
      button.innerHTML = `Backup dry-run job <a href="/jobs/${window.HB.escapeHtml(payload.jobId)}">#${window.HB.escapeHtml(payload.jobId)}</a>`;
    } catch (error) {
      button.textContent = `Error: ${error.message}`;
    } finally {
      setTimeout(() => {
        button.textContent = prev;
        button.disabled = false;
      }, 2500);
    }
  }

  async function handleDeploy(form) {
    const mountPath = form.elements.mountPath.value.trim();
    const portRaw = form.elements.port.value.trim();
    const dryRun = form.elements.dryRun.checked;
    const resultNode = form.querySelector('[data-result]');
    const payload = { mountPath, dryRun };
    if (portRaw) payload.port = Number(portRaw);
    if (!dryRun) {
      const confirm = window.prompt('Type EXECUTE to run deployment for real.');
      if (confirm !== 'EXECUTE') {
        resultNode.textContent = 'Cancelled (EXECUTE not provided).';
        return;
      }
      payload.confirm = 'EXECUTE';
    }
    resultNode.textContent = 'Submitting...';
    try {
      const response = await window.HB.postJson(`/api/apps/${appId}/execute`, payload);
      resultNode.innerHTML = `Started job <a href="/jobs/${window.HB.escapeHtml(response.jobId)}">#${window.HB.escapeHtml(response.jobId)}</a>.`;
    } catch (error) {
      resultNode.textContent = error.message;
    }
  }

  async function handleRestore(form) {
    const backupDir = form.elements.backupDir.value;
    const dryRun = form.elements.dryRun.checked;
    const resultNode = form.querySelector('[data-result]');
    if (!backupDir) {
      resultNode.textContent = 'Select a backup first.';
      return;
    }
    const payload = { backupDir, dryRun };
    if (!dryRun) {
      const confirm = window.prompt('Type EXECUTE to run restore for real.');
      if (confirm !== 'EXECUTE') {
        resultNode.textContent = 'Cancelled (EXECUTE not provided).';
        return;
      }
      payload.confirm = 'EXECUTE';
    }
    resultNode.textContent = 'Submitting...';
    try {
      const response = await window.HB.postJson(`/api/apps/${appId}/restore/execute`, payload);
      resultNode.innerHTML = `Started job <a href="/jobs/${window.HB.escapeHtml(response.jobId)}">#${window.HB.escapeHtml(response.jobId)}</a>.`;
    } catch (error) {
      resultNode.textContent = error.message;
    }
  }

  function wireActions() {
    root.addEventListener('click', (event) => {
      const backupButton = event.target.closest('button[data-action="backup"]');
      if (!backupButton) return;
      runBackup(appId, backupButton);
    });
    root.addEventListener('submit', (event) => {
      const deployForm = event.target.closest('form[data-action="deploy"]');
      if (deployForm) {
        event.preventDefault();
        handleDeploy(deployForm);
        return;
      }
      const restoreForm = event.target.closest('form[data-action="restore"]');
      if (restoreForm) {
        event.preventDefault();
        handleRestore(restoreForm);
      }
    });
  }

  async function load() {
    if (!appId) {
      renderError('Missing app id in URL.');
      return;
    }
    try {
      const [statePayload, catalogPayload, backupPayload, actionsPayload] = await Promise.all([
        window.HB.getJson('/api/state'),
        window.HB.getJson('/api/catalog'),
        window.HB.getJson(`/api/apps/${appId}/backups`),
        window.HB.getJson(`/api/apps/${appId}/actions`),
      ]);
      const catalogApps = Array.isArray(catalogPayload.apps) ? catalogPayload.apps : [];
      const app = catalogApps.find((item) => item.id === appId);
      if (!app) {
        renderError(`Unknown app id: ${appId}`);
        return;
      }
      const install = (statePayload.installations || {})[appId] || null;
      const backups = Array.isArray(backupPayload.backups) ? backupPayload.backups : [];
      const actions = actionsPayload.actions || {};
      const mountPath = install?.mountPath || app.network?.preferredMountPath || `/${appId}/`;
      const port = install?.port || app.network?.preferredPort || '';

      root.innerHTML = `
        <div class="hb-stack">
          <section class="hb-card">
            <div class="hb-row">
              <h1 style="margin:0;">${window.HB.escapeHtml(app.name)}</h1>
              ${window.HB.statusBadge(install?.status || 'not-installed')}
            </div>
            <p class="hb-muted" style="margin:0.55rem 0 0;">${window.HB.escapeHtml(app.purpose || '')}</p>
            <p class="hb-muted" style="margin:0.55rem 0 0;">
              App ID: ${window.HB.escapeHtml(app.id)} · Port: ${window.HB.escapeHtml(port)} · Route: ${window.HB.escapeHtml(mountPath)}
            </p>
            ${install?.externalUrl ? `<p style="margin:0.65rem 0 0;"><a href="${window.HB.escapeHtml(install.externalUrl)}" target="_blank" rel="noreferrer">Open app ↗</a></p>` : ''}
          </section>

          <section class="hb-grid hb-grid-2">
            <article class="hb-card">
              <h2 style="margin-top:0;">Actions</h2>
              <div class="hb-actions">
                <button class="hb-btn" type="button" data-action="backup">Backup dry-run</button>
              </div>
              <p class="hb-muted" style="margin:0.6rem 0 0;">
                Restart: ${actions.restart ? 'Available' : 'Not exposed yet'} ·
                Update: ${actions.update ? 'Available' : 'Not exposed yet'}
              </p>
            </article>

            <article class="hb-card">
              <h2 style="margin-top:0;">Deploy / Reinstall</h2>
              <form class="hb-form-grid" data-action="deploy">
                <label class="hb-label">Mount path <input class="hb-input" name="mountPath" value="${window.HB.escapeHtml(mountPath)}"></label>
                <label class="hb-label">Port <input class="hb-input" name="port" type="number" min="1" max="65535" value="${window.HB.escapeHtml(port)}"></label>
                <label class="hb-label" style="display:flex;gap:0.45rem;align-items:center;">
                  <input name="dryRun" type="checkbox" checked> Dry-run only
                </label>
                <button class="hb-btn hb-btn-primary" type="submit">Run deploy</button>
                <p class="hb-muted" data-result style="margin:0;"></p>
              </form>
            </article>
          </section>

          <section class="hb-card">
            <h2 style="margin-top:0;">Restore from backup</h2>
            <form class="hb-form-grid" data-action="restore">
              <label class="hb-label">
                Backup snapshot
                <select class="hb-select" name="backupDir">${buildBackupOptions(backups)}</select>
              </label>
              <label class="hb-label" style="display:flex;gap:0.45rem;align-items:center;">
                <input name="dryRun" type="checkbox" checked> Dry-run only
              </label>
              <button class="hb-btn" type="submit">Run restore</button>
              <p class="hb-muted" data-result style="margin:0;"></p>
            </form>
          </section>

          <section class="hb-card">
            <h2 style="margin-top:0;">Backup history</h2>
            ${backups.length
    ? `<ul class="hb-stack" style="list-style:none;padding:0;margin:0;">${backups.map((item) => `
                  <li class="hb-row">
                    <span>${window.HB.escapeHtml(item.name || item.archiveDir)}</span>
                    ${window.HB.statusBadge(item.status)}
                    <span class="hb-muted">${window.HB.escapeHtml(window.HB.formatTimestamp(item.generatedAt))}</span>
                  </li>
                `).join('')}</ul>`
    : '<p class="hb-muted" style="margin:0;">No backups recorded yet.</p>'}
          </section>

          <details class="hb-card">
            <summary>Advanced details</summary>
            <pre class="hb-pre" style="margin-top:0.75rem;">${window.HB.escapeHtml(JSON.stringify({
    app,
    installation: install,
    actions,
    backupsCount: backups.length,
  }, null, 2))}</pre>
          </details>
        </div>
      `;
      wireActions();
    } catch (error) {
      renderError(error.message);
    }
  }

  load();
}());
