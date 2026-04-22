(function appsPage() {
  const root = document.getElementById('app');
  let refreshTimer = null;
  let eventsWired = false;

  function installationCard(install, backupsByApp, config, healthByAppId) {
    const appId = window.HB.escapeHtml(install.appId);
    const detailUrl = `/apps/${appId}`;
    const backups = backupsByApp[install.appId] || [];
    const health = healthByAppId[install.appId] || {};
    const runtimeStatus = health.runtimeStatus || 'unknown';
    const runtimePill = window.HB.runtimeStatusPill(runtimeStatus);
    const attentionStatuses = new Set(['service-down', 'http-failing', 'readiness-failing', 'needs-setup']);
    const needsAttention = attentionStatuses.has(runtimeStatus);
    const healthHint = health.recoveryHint
      ? `<p class="${needsAttention ? 'hb-warn' : 'hb-muted'}" style="margin:0.55rem 0 0;">${window.HB.escapeHtml(health.recoveryHint)}${needsAttention ? ` <a href="${detailUrl}#health">View health details →</a>` : ''}</p>`
      : '';
    const openLink = install.externalUrl
      ? `<a class="hb-btn" href="${window.HB.escapeHtml(install.externalUrl)}" target="_blank" rel="noreferrer">Open ↗</a>`
      : '';
    const setupLink = runtimeStatus === 'needs-setup' && health.onboarding?.setupUrl
      ? `<a class="hb-btn" href="${window.HB.escapeHtml(health.onboarding.setupUrl)}" target="_blank" rel="noreferrer">Setup ↗</a>`
      : '';
    return `
      <article class="hb-card">
        <div class="hb-row">
          <a href="${detailUrl}"><strong>${window.HB.escapeHtml(install.name || install.appId)}</strong></a>
          ${window.HB.statusBadge(install.status)}
          ${runtimePill}
        </div>
        <p class="hb-muted" style="margin:0.55rem 0 0;">
          Port ${window.HB.escapeHtml(install.port)} · ${window.HB.escapeHtml(install.mountPath)}<br>
          Service: ${window.HB.escapeHtml(health.service?.state || 'unknown')} · Readiness: ${window.HB.escapeHtml(health.readiness?.status || 'unknown')}<br>
          Updated ${window.HB.escapeHtml(window.HB.formatTimestamp(install.updatedAt))}<br>
          ${window.HB.backupSummary(backups)}
        </p>
        ${healthHint}
        ${!backups.length ? '<p class="hb-warn" style="margin:0.55rem 0 0;">Recommended next step: take a first backup.</p>' : ''}
        <div class="hb-actions" style="margin-top:0.75rem;">
          ${openLink}
          ${setupLink}
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
    const refDefault = app.repository?.defaultRef || 'main';
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
          <label class="hb-label">
            Git ref
            <input class="hb-input" name="ref" value="${window.HB.escapeHtml(refDefault)}" placeholder="main">
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


  function activeInstallJobsByTarget(jobs) {
    const activeStatuses = new Set(['queued', 'running']);
    const byTarget = new Map();
    (Array.isArray(jobs) ? jobs : []).forEach((job) => {
      if (job.kind !== 'install' || !activeStatuses.has(job.status) || byTarget.has(job.target)) return;
      byTarget.set(job.target, job);
    });
    return byTarget;
  }

  function installingCard(app, job) {
    return `
      <article class="hb-card">
        <div class="hb-row">
          <strong>${window.HB.escapeHtml(app.name)}</strong>
          ${window.HB.statusBadge(job.status)}
          <span class="hb-badge">Installing now</span>
        </div>
        <p class="hb-muted" style="margin:0.55rem 0 0;">
          Home Base is already installing this app. It is hidden from Available until job #${window.HB.escapeHtml(job.id)} finishes.
        </p>
        <div class="hb-actions" style="margin-top:0.75rem;">
          <a class="hb-btn" href="/jobs/${window.HB.escapeHtml(job.id)}">View install job</a>
        </div>
      </article>
    `;
  }

  async function handleInstallSubmit(form) {
    const appId = form.getAttribute('data-app-id');
    const mountPath = form.elements.mountPath.value.trim();
    const portRaw = form.elements.port.value.trim();
    const ref = form.elements.ref.value.trim();
    const dryRun = form.elements.dryRun.checked;
    const resultNode = form.querySelector('[data-result]');
    const payload = {
      mountPath,
      dryRun,
    };
    if (portRaw) payload.port = Number(portRaw);
    if (ref) payload.ref = ref;
    if (!dryRun) {
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
    if (eventsWired) return;
    eventsWired = true;
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

  function isInstallFormInteractionActive() {
    const activeElement = document.activeElement;
    return Boolean(activeElement?.closest?.('form[data-action="install"]'));
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (document.visibilityState === 'visible') {
        if (isInstallFormInteractionActive()) {
          scheduleRefresh();
          return;
        }
        load();
        return;
      }
      scheduleRefresh();
    }, 15000);
  }

  async function load() {
    const availableWasOpen = root.querySelector('[data-available-install]')?.open;
    try {
      const [statePayload, catalogPayload, config, healthPayload] = await Promise.all([
        window.HB.getJson('/api/state'),
        window.HB.getJson('/api/catalog'),
        window.HB.getJson('/api/homebase/config'),
        window.HB.getJson('/api/apps/health'),
      ]);
      const installationsMap = statePayload.installations || {};
      const installations = Object.values(installationsMap);
      const backupsByApp = await loadBackupsForInstallations(installations);
      const healthByAppId = healthPayload.byAppId || {};
      const installedIds = new Set(installations.map((item) => item.appId));
      const catalog = Array.isArray(catalogPayload.apps) ? catalogPayload.apps : [];
      const activeJobs = Array.isArray(statePayload.activeJobs) ? statePayload.activeJobs : statePayload.jobs;
      const installingByAppId = activeInstallJobsByTarget(activeJobs);
      const installing = catalog.filter((app) => !installedIds.has(app.id) && installingByAppId.has(app.id));
      const available = catalog.filter((app) => !installedIds.has(app.id) && !installingByAppId.has(app.id));
      const shouldOpenAvailable = available.length ? availableWasOpen === true : true;

      root.innerHTML = `
        <div class="hb-stack">
          <section class="hb-card">
            <h1 style="margin:0;">Installed apps</h1>
            <p class="hb-muted" style="margin:0.55rem 0 0;">Open apps, inspect details, run backups, and start restores from one place.</p>
            <p class="hb-warn" style="margin:0.55rem 0 0;">${window.HB.localOnlyBackupNote(config)}</p>
          </section>
          <section class="hb-grid hb-grid-2">
            ${installations.length ? installations.map((install) => installationCard(install, backupsByApp, config, healthByAppId)).join('') : '<article class="hb-card"><p class="hb-muted" style="margin:0;">No installed apps yet.</p></article>'}
          </section>
          ${installing.length ? `
            <section>
              <h2 style="margin:0 0 0.75rem;">Installing now (${installing.length})</h2>
              <div class="hb-grid hb-grid-2">
                ${installing.map((app) => installingCard(app, installingByAppId.get(app.id))).join('')}
              </div>
            </section>
          ` : ''}
          <details data-available-install ${shouldOpenAvailable ? 'open' : ''}>
            <summary>Available to install (${available.length})</summary>
            <section class="hb-grid hb-grid-2" style="margin-top:0.75rem;">
              ${available.length ? available.map((app) => catalogCard(app)).join('') : '<article class="hb-card"><p class="hb-muted" style="margin:0;">All catalog apps are already installed.</p></article>'}
            </section>
          </details>
        </div>
      `;
      wireEvents();
      scheduleRefresh();
    } catch (error) {
      root.innerHTML = `
        <section class="hb-card">
          <h1 style="margin:0;">Apps</h1>
          <p class="hb-muted" style="margin-top:0.5rem;">${window.HB.escapeHtml(error.message)}</p>
        </section>
      `;
      scheduleRefresh();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load();
  });

  load();
}());
