(function appsPage() {
  const root = document.getElementById('app');

  function latestBackup(backups) {
    const items = Array.isArray(backups) ? backups : [];
    return items.find((item) => item.status === 'completed') || items[0] || null;
  }

  function backupSummary(backups) {
    const latest = latestBackup(backups);
    if (!latest) {
      return '<span class="hb-warn">No backups yet</span>';
    }
    const status = latest.status ? ` · ${window.HB.escapeHtml(latest.status)}` : '';
    return `Last backup: ${window.HB.escapeHtml(window.HB.formatTimestamp(latest.generatedAt))}${status}`;
  }

  function localOnlyBackupNote(config) {
    const backupRoot = config?.baseBackupDir || '/var/lib/sovereign-home/backups';
    return `Local-only backup path: ${window.HB.escapeHtml(backupRoot)}. This protects app mistakes, not VM/disk loss.`;
  }

  function installationCard(install, backupsByApp, config) {
    const appId = window.HB.escapeHtml(install.appId);
    const detailUrl = `/apps/${appId}`;
    const backups = backupsByApp[install.appId] || [];
    const openLink = install.externalUrl
      ? `<a class="hb-btn" href="${window.HB.escapeHtml(install.externalUrl)}" target="_blank" rel="noreferrer">Open ↗</a>`
      : '';
    return `
      <article class="hb-card">
        <div class="hb-row">
          <a href="${detailUrl}"><strong>${window.HB.escapeHtml(install.name || install.appId)}</strong></a>
          ${window.HB.statusBadge(install.status)}
        </div>
        <p class="hb-muted" style="margin:0.55rem 0 0;">
          Port ${window.HB.escapeHtml(install.port)} · ${window.HB.escapeHtml(install.mountPath)}<br>
          Updated ${window.HB.escapeHtml(window.HB.formatTimestamp(install.updatedAt))}<br>
          ${backupSummary(backups)}
        </p>
        ${!backups.length ? '<p class="hb-warn" style="margin:0.55rem 0 0;">Recommended next step: take a first backup.</p>' : ''}
        <p class="hb-muted" style="margin:0.55rem 0 0;">${localOnlyBackupNote(config)}</p>
        <div class="hb-actions" style="margin-top:0.75rem;">
          ${openLink}
          <a class="hb-btn" href="${detailUrl}">Details</a>
          <a class="hb-btn" href="${detailUrl}#backup">Backup…</a>
          <a class="hb-btn" href="${detailUrl}#restore">Restore…</a>
        </div>
      </article>
    `;
  }

  function catalogCard(app) {
    const appId = window.HB.escapeHtml(app.id);
    const mountDefault = app.network?.preferredMountPath || `/${app.id}/`;
    const portDefault = app.network?.preferredPort || '';
    return `
      <article class="hb-card">
        <h3 style="margin:0;">${window.HB.escapeHtml(app.name)}</h3>
        <p class="hb-muted" style="margin:0.45rem 0 0.6rem;">${window.HB.escapeHtml(app.purpose || '')}</p>
        <form class="hb-form-grid" data-action="install" data-app-id="${appId}">
          <label class="hb-label">
            Mount path
            <input class="hb-input" name="mountPath" value="${window.HB.escapeHtml(mountDefault)}" required>
          </label>
          <label class="hb-label">
            Port
            <input class="hb-input" name="port" type="number" min="1" max="65535" value="${window.HB.escapeHtml(portDefault)}">
          </label>
          <label class="hb-label" style="display:flex;gap:0.45rem;align-items:center;">
            <input name="dryRun" type="checkbox" checked>
            Dry-run only
          </label>
          <button class="hb-btn hb-btn-primary" type="submit">Install</button>
          <p class="hb-muted" data-result style="margin:0;"></p>
        </form>
      </article>
    `;
  }

  async function handleInstallSubmit(form) {
    const appId = form.getAttribute('data-app-id');
    const mountPath = form.elements.mountPath.value.trim();
    const portRaw = form.elements.port.value.trim();
    const dryRun = form.elements.dryRun.checked;
    const resultNode = form.querySelector('[data-result]');
    const payload = {
      mountPath,
      dryRun,
    };
    if (portRaw) payload.port = Number(portRaw);
    if (!dryRun) {
      const confirm = window.prompt('Type EXECUTE to run install for real.');
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

  function wireEvents() {
    root.addEventListener('submit', (event) => {
      const form = event.target.closest('form[data-action="install"]');
      if (!form) return;
      event.preventDefault();
      handleInstallSubmit(form);
    });
  }

  async function loadBackupsForInstallations(installations) {
    const entries = await Promise.all(installations.map(async (install) => {
      try {
        const payload = await window.HB.getJson(`/api/apps/${encodeURIComponent(install.appId)}/backups`);
        return [install.appId, Array.isArray(payload.backups) ? payload.backups : []];
      } catch (_error) {
        return [install.appId, []];
      }
    }));
    return Object.fromEntries(entries);
  }

  async function load() {
    try {
      const [statePayload, catalogPayload, config] = await Promise.all([
        window.HB.getJson('/api/state'),
        window.HB.getJson('/api/catalog'),
        window.HB.getJson('/api/homebase/config'),
      ]);
      const installationsMap = statePayload.installations || {};
      const installations = Object.values(installationsMap);
      const backupsByApp = await loadBackupsForInstallations(installations);
      const installedIds = new Set(installations.map((item) => item.appId));
      const catalog = Array.isArray(catalogPayload.apps) ? catalogPayload.apps : [];
      const available = catalog.filter((app) => !installedIds.has(app.id));

      root.innerHTML = `
        <div class="hb-stack">
          <section class="hb-card">
            <h1 style="margin:0;">Installed apps</h1>
            <p class="hb-muted" style="margin:0.55rem 0 0;">Open apps, inspect details, run backups, and start restores from one place.</p>
          </section>
          <section class="hb-grid hb-grid-2">
            ${installations.length ? installations.map((install) => installationCard(install, backupsByApp, config)).join('') : '<article class="hb-card"><p class="hb-muted" style="margin:0;">No installed apps yet.</p></article>'}
          </section>
          <details ${available.length ? '' : 'open'}>
            <summary>Available to install (${available.length})</summary>
            <section class="hb-grid hb-grid-2" style="margin-top:0.75rem;">
              ${available.length ? available.map((app) => catalogCard(app)).join('') : '<article class="hb-card"><p class="hb-muted" style="margin:0;">All catalog apps are already installed.</p></article>'}
            </section>
          </details>
        </div>
      `;
      wireEvents();
    } catch (error) {
      root.innerHTML = `
        <section class="hb-card">
          <h1 style="margin:0;">Apps</h1>
          <p class="hb-muted" style="margin-top:0.5rem;">${window.HB.escapeHtml(error.message)}</p>
        </section>
      `;
    }
  }

  load();
}());
