(function dashboardPage() {
  const root = document.getElementById('app');

  function renderInstallCards(installations) {
    if (!installations.length) {
      return '<article class="hb-card"><p class="hb-muted" style="margin:0;">No installed apps yet.</p></article>';
    }
    return installations.map((item) => `
      <article class="hb-card">
        <div class="hb-row">
          <a href="/apps/${window.HB.escapeHtml(item.appId)}"><strong>${window.HB.escapeHtml(item.name || item.appId)}</strong></a>
          ${window.HB.statusBadge(item.status)}
        </div>
        <p class="hb-muted" style="margin:0.55rem 0 0;">
          ${window.HB.escapeHtml(item.mountPath)} · Port ${window.HB.escapeHtml(item.port)}
        </p>
      </article>
    `).join('');
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

  function preflightSummary(preflight) {
    const checks = Array.isArray(preflight.checks) ? preflight.checks : [];
    const criticalFail = checks.filter((item) => item.severity === 'critical' && !item.ok).length;
    const warningFail = checks.filter((item) => item.severity !== 'critical' && !item.ok).length;
    if (!criticalFail && !warningFail) return '<span class="hb-ok">All checks passing</span>';
    if (criticalFail) return `<span class="hb-err">${criticalFail} critical check(s) failing</span> · <span class="hb-warn">${warningFail} warning check(s)</span>`;
    return `<span class="hb-warn">${warningFail} warning check(s) failing</span>`;
  }

  async function load() {
    try {
      const [state, preflight, status, config] = await Promise.all([
        window.HB.getJson('/api/state'),
        window.HB.getJson('/api/preflight'),
        window.HB.getJson('/api/homebase/status'),
        window.HB.getJson('/api/homebase/config'),
      ]);
      const installations = Object.values(state.installations || {});
      const jobs = Array.isArray(state.jobs) ? state.jobs : [];
      const placeholderBanner = config.hostnameIsPlaceholder
        ? '<p class="hb-warn" style="margin:0.4rem 0 0;">Hostname is still default (`homebase`). Update in Settings before wider deployment.</p>'
        : '';

      root.innerHTML = `
        <div class="hb-stack">
          <section class="hb-card">
            <h1 style="margin:0;">Home Base Dashboard</h1>
            <p class="hb-muted" style="margin:0.55rem 0 0;">
              Host: ${window.HB.escapeHtml(config.hostname)}.${window.HB.escapeHtml(config.domain)} · Service: ${window.HB.escapeHtml(status.systemd?.active || 'unknown')}
            </p>
            ${placeholderBanner}
          </section>
          <section class="hb-card">
            <h2 style="margin-top:0;">System readiness</h2>
            <p style="margin:0;">${preflightSummary(preflight)}</p>
          </section>
          <section>
            <div class="hb-row" style="justify-content:space-between;">
              <h2 style="margin:0;">Installed apps</h2>
              <a href="/apps">Manage apps →</a>
            </div>
            <div class="hb-grid hb-grid-2" style="margin-top:0.75rem;">
              ${renderInstallCards(installations)}
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
