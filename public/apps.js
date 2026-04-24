(function appsPage() {
  const root = document.getElementById('app');
  let refreshTimer = null;
  let eventsWired = false;

  function installationCard(install, backupsByApp, config, healthByAppId, catalogEntry) {
    const appId = window.HB.escapeHtml(install.appId);
    const detailUrl = `/apps/${appId}`;
    const backups = backupsByApp[install.appId] || [];
    const health = healthByAppId[install.appId] || {};
    const runtimeStatus = health.runtimeStatus || 'unknown';
    const runtimePill = window.HB.runtimeStatusPill(runtimeStatus);
    const attentionStatuses = new Set(['service-down', 'http-failing', 'readiness-failing', 'needs-setup']);
    const needsAttention = attentionStatuses.has(runtimeStatus);
    const healthHint = health.recoveryHint
      ? `<p class="${needsAttention ? 'hb-warn' : 'hb-muted'}" style="margin:0.45rem 0 0;font-size:0.83rem;">${window.HB.escapeHtml(health.recoveryHint)}${needsAttention ? ` <a href="${detailUrl}#health">Inspect →</a>` : ''}</p>`
      : '';
    const openLink = install.externalUrl
      ? `<a class="hb-btn hb-btn-primary" href="${window.HB.escapeHtml(install.externalUrl)}" target="_blank" rel="noreferrer">Open ↗</a>`
      : '';
    const setupLink = runtimeStatus === 'needs-setup' && health.onboarding?.setupUrl
      ? `<a class="hb-btn hb-btn-primary" href="${window.HB.escapeHtml(health.onboarding.setupUrl)}" target="_blank" rel="noreferrer">Setup ↗</a>`
      : '';
    const icon = catalogEntry?.icon ? `<span class="hb-app-icon">${window.HB.escapeHtml(catalogEntry.icon)}</span>` : '';
    return `
      <article class="hb-card">
        <div class="hb-row">
          ${icon}
          <a href="${detailUrl}" style="font-weight:700;font-size:1rem;">${window.HB.escapeHtml(install.name || install.appId)}</a>
          ${window.HB.statusBadge(install.status)}
          ${runtimePill}
        </div>
        <p class="hb-muted" style="margin:0.45rem 0 0;font-size:0.83rem;line-height:1.6;">
          Port ${window.HB.escapeHtml(install.port)} · ${window.HB.escapeHtml(install.mountPath)} · Service: ${window.HB.escapeHtml(health.service?.state || 'unknown')} · Readiness: ${window.HB.escapeHtml(health.readiness?.status || 'unknown')}<br>
          Updated ${window.HB.escapeHtml(window.HB.formatTimestamp(install.updatedAt))} · ${window.HB.backupSummary(backups)}
        </p>
        ${!backups.length ? '<p class="hb-warn" style="margin:0.45rem 0 0;font-size:0.83rem;">No backups yet.</p>' : ''}
        ${healthHint}
        <div class="hb-actions" style="margin-top:0.65rem;align-items:center;">
          ${openLink || setupLink}
          <a class="hb-btn-icon" href="${detailUrl}" title="View details">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.5v4M8 5.5v.01"/></svg>
          </a>
          <a class="hb-btn-icon" href="${detailUrl}#backup" title="Backup">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 11v2h10v-2M8 2v7m0 0-2.5-2.5M8 9l2.5-2.5"/></svg>
          </a>
          <a class="hb-btn-icon" href="${detailUrl}#restore" title="Restore">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 8A4.5 4.5 0 1 0 5 4.5M3.5 8V5m0 3H6.5"/></svg>
          </a>
          <a class="hb-btn-icon hb-btn-icon--danger" href="${detailUrl}#uninstall" title="Uninstall">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h12M5 4V2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V4M6 7v5M10 7v5M3 4l.8 9.5a.5.5 0 0 0 .5.5h7.4a.5.5 0 0 0 .5-.5L13 4"/></svg>
          </a>
        </div>
      </article>
    `;
  }

  function catalogCard(app) {
    const appId = window.HB.escapeHtml(app.id);
    const mountDefault = app.network?.preferredMountPath || `/${app.id}/`;
    const portDefault = app.network?.preferredPort || '';
    const refDefault = app.repository?.defaultRef || 'main';
    const icon = app.icon ? `<span class="hb-app-icon" style="font-size:1.6rem;">${window.HB.escapeHtml(app.icon)}</span>` : '';
    return `
      <article class="hb-card">
        <div class="hb-row" style="margin-bottom:0.45rem;">
          ${icon}
          <h3 style="margin:0;">${window.HB.escapeHtml(app.name)}</h3>
        </div>
        <p class="hb-muted" style="margin:0 0 0.75rem;font-size:0.85rem;">${window.HB.escapeHtml(app.purpose || '')}</p>
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
          <label class="hb-label" style="display:flex;gap:0.45rem;align-items:center;flex-direction:row;">
            <input name="dryRun" type="checkbox" checked>
            Dry-run only
          </label>
          <div><button class="hb-btn hb-btn-primary" type="submit" style="min-width:100px;">Install</button></div>
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
    const icon = app.icon ? `<span class="hb-app-icon">${window.HB.escapeHtml(app.icon)}</span>` : '';
    return `
      <article class="hb-card">
        <div class="hb-row">
          ${icon}
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

  function isTerminalJobStatus(status) {
    return ['completed', 'failed', 'cancelled'].includes(String(status || ''));
  }

  async function waitForJobCompletion(jobId, resultNode, { onComplete = null } = {}) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const job = await window.HB.getJson(`/api/jobs/${encodeURIComponent(jobId)}`);
        if (resultNode) {
          resultNode.innerHTML = `Job <a href="/jobs/${window.HB.escapeHtml(jobId)}">#${window.HB.escapeHtml(jobId)}</a> ${window.HB.escapeHtml(job.status)}.`;
        }
        if (isTerminalJobStatus(job.status)) {
          if (typeof onComplete === 'function') onComplete(job);
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

  async function handleInstallSubmit(form) {
    if (form.dataset.submitting === 'true') return;
    form.dataset.submitting = 'true';
    const appId = form.getAttribute('data-app-id');
    const mountPath = form.elements.mountPath.value.trim();
    const portRaw = form.elements.port.value.trim();
    const ref = form.elements.ref.value.trim();
    const dryRun = form.elements.dryRun.checked;
    const resultNode = form.querySelector('[data-result]');
    const submitButton = form.querySelector('button[type="submit"]');
    const payload = {
      mountPath,
      dryRun,
    };
    if (submitButton) submitButton.disabled = true;
    if (portRaw) payload.port = Number(portRaw);
    if (ref) payload.ref = ref;
    if (!dryRun) {
      payload.confirm = 'EXECUTE';
    }
    resultNode.textContent = 'Submitting...';
    try {
      const response = await window.HB.postJson(`/api/apps/${appId}/execute`, payload);
      const mode = dryRun ? 'Install dry-run' : 'Install';
      resultNode.innerHTML = `${mode} job <a href="/jobs/${window.HB.escapeHtml(response.jobId)}">#${window.HB.escapeHtml(response.jobId)}</a> started. This page will refresh when it finishes.`;
      void waitForJobCompletion(response.jobId, resultNode, {
        onComplete: () => {
          form.dataset.submitting = 'false';
          if (submitButton) submitButton.disabled = false;
          load();
        },
      });
      return;
    } catch (error) {
      resultNode.textContent = error.message;
    }
    form.dataset.submitting = 'false';
    if (submitButton) submitButton.disabled = false;
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
      const catalogById = new Map(catalog.map((app) => [app.id, app]));
      const activeJobs = Array.isArray(statePayload.activeJobs) ? statePayload.activeJobs : statePayload.jobs;
      const installingByAppId = activeInstallJobsByTarget(activeJobs);
      const installing = catalog.filter((app) => !installedIds.has(app.id) && installingByAppId.has(app.id));
      const available = catalog.filter((app) => !installedIds.has(app.id) && !installingByAppId.has(app.id));
      const shouldOpenAvailable = available.length ? availableWasOpen === true : true;

      root.innerHTML = `
        <div class="hb-stack">
          <section class="hb-card">
            <h1 style="margin:0;">Apps</h1>
            <p class="hb-muted" style="margin:0.55rem 0 0;">Open, inspect, back up, and restore your sovereign apps from one place.</p>
            <p class="hb-warn" style="margin:0.55rem 0 0;">${window.HB.localOnlyBackupNote(config)}</p>
          </section>
          <section class="hb-grid hb-grid-2">
            ${installations.length ? installations.map((install) => installationCard(install, backupsByApp, config, healthByAppId, catalogById.get(install.appId))).join('') : '<article class="hb-card"><p class="hb-muted" style="margin:0;">No installed apps yet.</p></article>'}
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
