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

  function latestBackup(backups) {
    const items = Array.isArray(backups) ? backups : [];
    return items.find((item) => item.status === 'completed') || items[0] || null;
  }

  function localOnlyBackupNote(config) {
    const backupRoot = config?.baseBackupDir || '/var/lib/sovereign-home/backups';
    return `Local-only backup path: ${window.HB.escapeHtml(backupRoot)}. This protects app mistakes, not VM/disk loss.`;
  }

  function renderBackupSummary(backups, config) {
    const latest = latestBackup(backups);
    const backupLine = latest
      ? `Last backup: ${window.HB.escapeHtml(window.HB.formatTimestamp(latest.generatedAt))}${latest.status ? ` · ${window.HB.escapeHtml(latest.status)}` : ''}`
      : '<span class="hb-warn">No backups recorded yet. Take a first backup before relying on this install.</span>';
    return `<p class="hb-muted" style="margin:0.65rem 0 0;">${backupLine}<br>${localOnlyBackupNote(config)}</p>`;
  }

  function scrollToCurrentHash() {
    if (!window.location.hash) return;
    const target = document.getElementById(window.location.hash.slice(1));
    if (target) target.scrollIntoView({ block: 'start' });
  }

  function buildBackupOptions(backups) {
    if (!backups.length) {
      return '<option value="">No backups available</option>';
    }
    return backups.map((item) => `
      <option value="${window.HB.escapeHtml(item.archiveDir)}">${window.HB.escapeHtml(item.name || item.archiveDir)} — ${window.HB.escapeHtml(window.HB.formatTimestamp(item.generatedAt))}</option>
    `).join('');
  }


  function isTerminalJobStatus(status) {
    return ['completed', 'failed', 'cancelled'].includes(String(status || ''));
  }

  async function waitForJobCompletion(jobId, resultNode, { refreshOnComplete = true } = {}) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const job = await window.HB.getJson(`/api/jobs/${encodeURIComponent(jobId)}`);
        if (resultNode) {
          resultNode.innerHTML = `Job <a href="/jobs/${window.HB.escapeHtml(jobId)}">#${window.HB.escapeHtml(jobId)}</a> ${window.HB.escapeHtml(job.status)}.`;
        }
        if (isTerminalJobStatus(job.status)) {
          if (refreshOnComplete) {
            setTimeout(() => load(), 650);
          }
          return job;
        }
      } catch (error) {
        if (resultNode) resultNode.textContent = error.message;
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (resultNode) {
      resultNode.innerHTML = `Job <a href="/jobs/${window.HB.escapeHtml(jobId)}">#${window.HB.escapeHtml(jobId)}</a> is still running. Open the job for details.`;
    }
    return null;
  }

  async function handleBackup(form) {
    const dryRun = form.elements.dryRun.checked;
    const resultNode = form.querySelector('[data-result]');
    const submitButton = form.querySelector('button[type="submit"]');
    const payload = { dryRun };
    if (!dryRun) {
      const confirm = window.prompt('Type EXECUTE to run backup for real.');
      if (confirm !== 'EXECUTE') {
        resultNode.textContent = 'Cancelled (EXECUTE not provided).';
        return;
      }
      payload.confirm = 'EXECUTE';
    }
    if (submitButton) submitButton.disabled = true;
    resultNode.textContent = 'Submitting...';
    try {
      const response = await window.HB.postJson(`/api/apps/${appId}/backup/execute`, payload);
      const mode = dryRun ? 'Backup dry-run' : 'Backup';
      resultNode.innerHTML = `${mode} job <a href="/jobs/${window.HB.escapeHtml(response.jobId)}">#${window.HB.escapeHtml(response.jobId)}</a> started. This page will refresh when it finishes.`;
      waitForJobCompletion(response.jobId, resultNode);
    } catch (error) {
      resultNode.textContent = error.message;
    } finally {
      if (submitButton) submitButton.disabled = false;
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
      resultNode.innerHTML = `Started job <a href="/jobs/${window.HB.escapeHtml(response.jobId)}">#${window.HB.escapeHtml(response.jobId)}</a>. This page will refresh when it finishes.`;
      waitForJobCompletion(response.jobId, resultNode);
    } catch (error) {
      resultNode.textContent = error.message;
    }
  }

  function wireActions() {
    root.addEventListener('submit', (event) => {
      const backupForm = event.target.closest('form[data-action="backup"]');
      if (backupForm) {
        event.preventDefault();
        handleBackup(backupForm);
        return;
      }
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
      const [statePayload, catalogPayload, backupPayload, actionsPayload, config] = await Promise.all([
        window.HB.getJson('/api/state'),
        window.HB.getJson('/api/catalog'),
        window.HB.getJson(`/api/apps/${appId}/backups`),
        window.HB.getJson(`/api/apps/${appId}/actions`),
        window.HB.getJson('/api/homebase/config'),
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
            <div class="hb-actions" style="margin-top:0.75rem;">
              ${install?.externalUrl ? `<a class="hb-btn" href="${window.HB.escapeHtml(install.externalUrl)}" target="_blank" rel="noreferrer">Open app ↗</a>` : ''}
              <a class="hb-btn" href="#backup">Backup</a>
              <a class="hb-btn" href="#restore">Restore</a>
              <a class="hb-btn" href="#deploy">Deploy / Reinstall</a>
            </div>
            ${renderBackupSummary(backups, config)}
          </section>

          <section class="hb-grid hb-grid-2">
            <article id="backup" class="hb-card">
              <h2 style="margin-top:0;">Backup</h2>
              <form class="hb-form-grid" data-action="backup">
                <label class="hb-label" style="display:flex;gap:0.45rem;align-items:center;">
                  <input name="dryRun" type="checkbox" checked> Dry-run only
                </label>
                <button class="hb-btn" type="submit">Run backup</button>
                <p class="hb-muted" data-result style="margin:0;"></p>
              </form>
              <p class="hb-muted" style="margin:0.6rem 0 0;">
                Restart: ${actions.restart ? 'Available' : 'Not exposed yet'} ·
                Update: ${actions.update ? 'Available' : 'Not exposed yet'}
              </p>
            </article>

            <article id="deploy" class="hb-card">
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

          <section id="restore" class="hb-card">
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
      scrollToCurrentHash();
    } catch (error) {
      renderError(error.message);
    }
  }

  load();
}());
