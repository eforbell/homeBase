(function dashboardPage() {
  const root = document.getElementById('app');

  function renderInstallCards(installations, healthByAppId, catalogById) {
    if (!installations.length) {
      return '<article class="hb-card"><p class="hb-muted" style="margin:0;">No installed apps yet.</p></article>';
    }
    return installations.map((item) => {
      const health = healthByAppId[item.appId] || {};
      const catalogEntry = catalogById?.get(item.appId);
      const attentionStatuses = new Set(['service-down', 'http-failing', 'readiness-failing', 'helper-failing', 'needs-setup']);
      const needsAttention = attentionStatuses.has(health.runtimeStatus);
      const icon = catalogEntry?.icon ? `<span class="hb-app-icon">${window.HB.escapeHtml(catalogEntry.icon)}</span>` : '';
      const openLink = item.externalUrl
        ? `<a class="hb-btn hb-btn-primary" href="${window.HB.escapeHtml(item.externalUrl)}" target="_blank" rel="noreferrer" style="font-size:0.8rem;padding:0.3rem 0.6rem;">Open ↗</a>`
        : '';
      return `
      <article class="hb-card">
        <div class="hb-row">
          ${icon}
          <a href="/apps/${window.HB.escapeHtml(item.appId)}" style="font-weight:700;">${window.HB.escapeHtml(item.name || item.appId)}</a>
          ${window.HB.statusBadge(item.status)}
          ${window.HB.runtimeStatusPill(health.runtimeStatus || 'unknown')}
        </div>
        <p class="hb-muted" style="margin:0.45rem 0 0;font-size:0.83rem;">
          ${window.HB.escapeHtml(item.mountPath)} · Port ${window.HB.escapeHtml(item.port)} · Service: ${window.HB.escapeHtml(health.service?.state || 'unknown')}
        </p>
        ${health.recoveryHint ? `<p class="${needsAttention ? 'hb-warn' : 'hb-muted'}" style="margin:0.45rem 0 0;font-size:0.83rem;">${window.HB.escapeHtml(health.recoveryHint)}${needsAttention ? ` <a href="/apps/${window.HB.escapeHtml(item.appId)}#health">Inspect →</a>` : ''}</p>` : ''}
        ${openLink ? `<div class="hb-actions" style="margin-top:0.55rem;">${openLink}</div>` : ''}
      </article>
    `;
    }).join('');
  }

  function renderJobs(jobs) {
    if (!jobs.length) return '<p class="hb-muted" style="margin:0;">No jobs yet.</p>';
    return `
      <ul class="hb-stack" style="list-style:none;padding:0;margin:0;">
        ${jobs.slice(0, 5).map((job) => `
          <li class="hb-row">
            <a href="/jobs/${window.HB.escapeHtml(job.id)}">#${window.HB.escapeHtml(job.id)}</a>
            ${window.HB.statusBadge(job.status)}
            <span>${window.HB.escapeHtml(job.kind)}</span>
            <span class="hb-muted">${window.HB.escapeHtml(window.HB.formatTimestamp(job.createdAt))}</span>
          </li>
        `).join('')}
      </ul>
    `;
  }

  function renderAppHealthWarnings(installations, healthByAppId) {
    const attentionStatuses = new Set(['service-down', 'http-failing', 'readiness-failing', 'helper-failing', 'needs-setup']);
    const items = installations
      .map((install) => ({ install, health: healthByAppId[install.appId] || {} }))
      .filter(({ health }) => attentionStatuses.has(health.runtimeStatus));

    if (!items.length) {
      return '<p class="hb-ok" style="margin:0;">No app health warnings detected.</p>';
    }

    return `
      <ul class="hb-stack" style="list-style:none;padding:0;margin:0;">
        ${items.map(({ install, health }) => `
          <li class="hb-row">
            <a href="/apps/${window.HB.escapeHtml(install.appId)}#health"><strong>${window.HB.escapeHtml(install.name || install.appId)}</strong></a>
            ${window.HB.runtimeStatusPill(health.runtimeStatus)}
            <span class="hb-muted">${window.HB.escapeHtml(health.recoveryHint || 'Needs attention')}</span>
          </li>
        `).join('')}
      </ul>
    `;
  }

  function renderHostWarnings(preflight) {
    const checks = Array.isArray(preflight?.checks) ? preflight.checks : [];
    const failing = checks.filter((item) => item.ok === false);
    const notEvaluated = checks.filter((item) => item.ok === null);
    const critical = failing.filter((item) => item.severity === 'critical');
    const warning = failing.filter((item) => item.severity !== 'critical');
    if (!failing.length && !notEvaluated.length) {
      return '<p class="hb-ok" style="margin:0;">Host checks are passing.</p>';
    }

    return `
      <p style="margin:0 0 0.55rem;">
        ${critical.length ? `<span class="hb-err">${critical.length} critical host check(s) failing</span>` : ''}
        ${critical.length && warning.length ? ' · ' : ''}
        ${warning.length ? `<span class="hb-warn">${warning.length} warning host check(s)</span>` : ''}
        ${(critical.length || warning.length) && notEvaluated.length ? ' · ' : ''}
        ${notEvaluated.length ? `<span class="hb-warn">${notEvaluated.length} protected check(s) not evaluated by the web service</span>` : ''}
      </p>
      <ul class="hb-stack" style="list-style:none;padding:0;margin:0;">
        ${[...failing, ...notEvaluated].slice(0, 4).map((item) => `
          <li class="hb-row">
            <span class="${item.ok === null ? 'hb-warn' : (item.severity === 'critical' ? 'hb-err' : 'hb-warn')}">${window.HB.escapeHtml(item.title || item.id)}</span>
            <span class="hb-muted">${window.HB.escapeHtml(item.hint || item.summary || '')}</span>
          </li>
        `).join('')}
      </ul>
    `;
  }

  function preflightSummary(preflight) {
    const checks = Array.isArray(preflight.checks) ? preflight.checks : [];
    const criticalFail = checks.filter((item) => item.severity === 'critical' && item.ok === false).length;
    const warningFail = checks.filter((item) => item.severity !== 'critical' && item.ok === false).length;
    const notEvaluated = checks.filter((item) => item.ok === null).length;
    if (!criticalFail && !warningFail && !notEvaluated) return '<span class="hb-ok">All checks passing</span>';
    if (!criticalFail && !warningFail) return `<span class="hb-warn">${notEvaluated} protected check(s) not evaluated by the web service</span>`;
    if (criticalFail) return `<span class="hb-err">${criticalFail} critical check(s) failing</span> · <span class="hb-warn">${warningFail} warning check(s)</span>`;
    return `<span class="hb-warn">${warningFail} warning check(s) failing</span>`;
  }

  function renderBootstrapStatus(bootstrapStatus) {
    const latest = bootstrapStatus.latestBootstrapJob;
    if (!bootstrapStatus.autoBootstrap?.shouldStart && !latest) {
      return '<p class="hb-muted" style="margin:0;">Bootstrap has not been started yet.</p>';
    }
    if (!latest) {
      return `<p class="hb-muted" style="margin:0;">Auto-bootstrap scheduled (${window.HB.escapeHtml(bootstrapStatus.autoBootstrap.mode || 'execute')}).</p>`;
    }
    return `
      <div class="hb-stack">
        <div class="hb-row">
          <a href="/jobs/${window.HB.escapeHtml(latest.id)}">Bootstrap job #${window.HB.escapeHtml(latest.id)}</a>
          ${window.HB.statusBadge(latest.status)}
          <span class="hb-muted">${window.HB.escapeHtml(window.HB.formatTimestamp(latest.createdAt))}</span>
        </div>
        ${latest.status === 'failed' ? `
          <form class="hb-actions" data-action="rerun-bootstrap">
            <button class="hb-btn" type="submit">Re-run bootstrap</button>
            <span class="hb-muted" data-result></span>
          </form>
        ` : ''}
      </div>
    `;
  }

  async function rerunBootstrap(form) {
    const resultNode = form.querySelector('[data-result]');
    if (resultNode) resultNode.textContent = 'Submitting...';
    try {
      const payload = await window.HB.postJson('/api/bootstrap/execute', {
        dryRun: false,
        confirm: 'EXECUTE',
      });
      window.location.href = `/jobs/${encodeURIComponent(payload.jobId)}`;
    } catch (error) {
      if (resultNode) resultNode.textContent = error.message;
    }
  }

  function wireEvents() {
    root.addEventListener('submit', (event) => {
      const bootstrapForm = event.target.closest('form[data-action="rerun-bootstrap"]');
      if (!bootstrapForm) return;
      event.preventDefault();
      rerunBootstrap(bootstrapForm);
    });
  }

  async function load() {
    try {
      const [state, status, config, bootstrapStatus, healthPayload, catalogPayload] = await Promise.all([
        window.HB.getJson('/api/state'),
        window.HB.getJson('/api/homebase/status'),
        window.HB.getJson('/api/homebase/config'),
        window.HB.getJson('/api/homebase/bootstrap-status'),
        window.HB.getJson('/api/apps/health'),
        window.HB.getJson('/api/catalog'),
      ]);
      const installations = Object.values(state.installations || {});
      const jobs = Array.isArray(state.jobs) ? state.jobs : [];
      const healthByAppId = healthPayload.byAppId || {};
      const catalogById = new Map((catalogPayload.apps || []).map((app) => [app.id, app]));
      const placeholderBanner = config.hostnameIsPlaceholder
        ? '<p class="hb-warn" style="margin:0.4rem 0 0;">Hostname is still default (`homebase`). Update in Config before wider deployment.</p>'
        : '';

      root.innerHTML = `
        <div class="hb-stack">
          <section class="hb-card">
            <h1 style="margin:0;">Dashboard</h1>
            <p class="hb-muted" style="margin:0.55rem 0 0;">
              Host: ${window.HB.escapeHtml(config.hostname)}.${window.HB.escapeHtml(config.domain)} · Service: ${window.HB.escapeHtml(status.systemd?.active || 'unknown')}
            </p>
            ${placeholderBanner}
          </section>
          <section class="hb-card">
            <h2 style="margin-top:0;">System readiness</h2>
            <p data-preflight-summary style="margin:0;"><span class="hb-muted">Checking host readiness…</span></p>
            <div style="margin-top:0.75rem;">${renderBootstrapStatus(bootstrapStatus)}</div>
          </section>
          <section class="hb-card">
            <h2 style="margin-top:0;">Backup posture</h2>
            <p class="hb-warn" style="margin:0;">Backups are currently local-only at ${window.HB.escapeHtml(config.baseBackupDir || '/var/lib/sovereign-home/backups')}. This helps recover app mistakes, but not VM or disk loss.</p>
          </section>
          <section class="hb-card">
            <h2 style="margin-top:0;">Health warnings</h2>
            <div style="margin-top:0.65rem;">
              <p class="hb-muted" style="margin:0 0 0.45rem;"><strong>Apps</strong></p>
              ${renderAppHealthWarnings(installations, healthByAppId)}
            </div>
            <div data-host-warnings style="margin-top:0.8rem;">
              <p class="hb-muted" style="margin:0 0 0.45rem;"><strong>Host checks</strong></p>
              <p class="hb-muted" style="margin:0;">Loading host checks…</p>
            </div>
          </section>
          <section>
            <div class="hb-row" style="justify-content:space-between;">
              <h2 style="margin:0;">Apps</h2>
              <a href="/apps">Manage →</a>
            </div>
            <div class="hb-grid hb-grid-2" style="margin-top:0.75rem;">
              ${renderInstallCards(installations, healthByAppId, catalogById)}
            </div>
          </section>
          <section class="hb-card">
            <div class="hb-row" style="justify-content:space-between;">
              <h2 style="margin:0;">Recent jobs</h2>
              <a href="/jobs">View all jobs →</a>
            </div>
            <div style="margin-top:0.65rem;">${renderJobs(jobs)}</div>
          </section>
        </div>
      `;
      wireEvents();
      window.HB.getJson('/api/preflight').then((preflight) => {
        const node = root.querySelector('[data-preflight-summary]');
        if (node) node.innerHTML = preflightSummary(preflight);
        const hostWarnings = root.querySelector('[data-host-warnings]');
        if (hostWarnings) {
          hostWarnings.innerHTML = `
            <p class="hb-muted" style="margin:0 0 0.45rem;"><strong>Host checks</strong></p>
            ${renderHostWarnings(preflight)}
          `;
        }
      }).catch((error) => {
        const node = root.querySelector('[data-preflight-summary]');
        if (node) node.innerHTML = `<span class="hb-warn">${window.HB.escapeHtml(error.message)}</span>`;
        const hostWarnings = root.querySelector('[data-host-warnings]');
        if (hostWarnings) {
          hostWarnings.innerHTML = `
            <p class="hb-muted" style="margin:0 0 0.45rem;"><strong>Host checks</strong></p>
            <p class="hb-warn" style="margin:0;">${window.HB.escapeHtml(error.message)}</p>
          `;
        }
      });
    } catch (error) {
      root.innerHTML = `
        <section class="hb-card">
          <h1 style="margin:0;">Dashboard</h1>
          <p class="hb-muted" style="margin-top:0.5rem;">${window.HB.escapeHtml(error.message)}</p>
        </section>
      `;
    }
  }

  load();
}());
