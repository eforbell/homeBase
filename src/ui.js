function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderHomePage({ catalog, state, config }) {
  const installationCards = Object.values(state.installations || {}).map((item) => `
    <li>
      <strong>${escapeHtml(item.name)}</strong>
      <div>${escapeHtml(item.mountPath)} → ${escapeHtml(item.externalUrl)}</div>
      <div>port ${escapeHtml(item.port)} · ${escapeHtml(item.status)}</div>
    </li>
  `).join('');

  const jobCards = (state.jobs || []).map((job) => `
    <li>
      <strong><a href="/jobs/${escapeHtml(job.id)}" style="color:#9cc2ff">#${escapeHtml(job.id)}</a></strong>
      <div>${escapeHtml(job.kind)} · ${escapeHtml(job.status)}${job.dryRun ? ' · dry-run' : ''}</div>
      <div>${escapeHtml(job.currentStep || 'waiting')}</div>
    </li>
  `).join('');

  const preflightSummary = state.preflight
    ? `${state.preflight.checks.filter((check) => check.ok).length}/${state.preflight.checks.length} checks passing`
    : 'Not run yet';

  const catalogCards = catalog.map((app) => `
    <article class="card">
      <h3>${escapeHtml(app.name)}</h3>
      <p>${escapeHtml(app.purpose)}</p>
      <ul>
        <li><strong>Runtime:</strong> ${escapeHtml(app.runtime.kind)}</li>
        <li><strong>Default route:</strong> ${escapeHtml(app.network.preferredMountPath)}</li>
        <li><strong>Default port:</strong> ${escapeHtml(app.network.preferredPort)}</li>
        <li><strong>Health:</strong> ${escapeHtml(app.network.health.livenessPath)}</li>
      </ul>
      <form class="install-form" data-app-id="${escapeHtml(app.id)}">
        <label>Mount path <input name="mountPath" value="${escapeHtml(app.network.preferredMountPath)}"></label>
        <label>Port <input name="port" type="number" value="${escapeHtml(app.network.preferredPort)}"></label>
        <label>Confirm execute <input name="confirm" placeholder="EXECUTE for real run"></label>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">
          <button type="submit" data-action="plan">Generate install plan</button>
          <button type="submit" data-action="dry-run">Run install dry-run</button>
          <button type="submit" data-action="execute">Run install for real</button>
        </div>
      </form>
    </article>
  `).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Home Base</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: system-ui, sans-serif; margin: 0; background: #0b1220; color: #e5eef9; }
    header { padding: 1.5rem; background: #111b2e; border-bottom: 1px solid #24324b; }
    main { display: grid; gap: 1rem; padding: 1rem; }
    .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    .card { background: #111b2e; border: 1px solid #24324b; border-radius: 14px; padding: 1rem; }
    .card h2, .card h3 { margin-top: 0; }
    label { display: grid; gap: .35rem; margin-bottom: .75rem; }
    input, button, textarea { font: inherit; border-radius: 10px; border: 1px solid #38507a; background: #08101c; color: inherit; padding: .7rem; }
    button { background: #3559e0; border-color: #3559e0; cursor: pointer; }
    button:hover { filter: brightness(1.07); }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #08101c; padding: 1rem; border-radius: 12px; border: 1px solid #24324b; max-height: 30rem; overflow: auto; }
    ul { padding-left: 1.1rem; }
    .muted { color: #9fb0cf; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(config.appName)}</h1>
    <p class="muted">Debian-first control plane for Sovereign Home apps. This slice generates safe bootstrap and install plans instead of applying privileged changes automatically.</p>
  </header>
  <main>
    <section class="grid">
      <article class="card">
        <h2>Bootstrap host</h2>
        <form id="bootstrap-form">
          <label>Service user <input name="serviceUser" value="${escapeHtml(config.serviceUser)}"></label>
          <label>Install root <input name="baseInstallDir" value="${escapeHtml(config.baseInstallDir)}"></label>
          <label>Backup root <input name="baseBackupDir" value="${escapeHtml(config.baseBackupDir)}"></label>
          <label>Confirm execute <input name="confirm" placeholder="EXECUTE for real run"></label>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap">
            <button type="submit" data-action="plan">Generate bootstrap plan</button>
            <button type="submit" data-action="dry-run">Run bootstrap dry-run</button>
            <button type="submit" data-action="execute">Run bootstrap for real</button>
          </div>
        </form>
      </article>
      <article class="card">
        <h2>Planned installs</h2>
        <ul>${installationCards || '<li>No planned installs yet.</li>'}</ul>
      </article>
      <article class="card">
        <h2>Recent jobs</h2>
        <ul>${jobCards || '<li>No jobs yet.</li>'}</ul>
      </article>
      <article class="card">
        <h2>Preflight</h2>
        <p>${escapeHtml(preflightSummary)}</p>
        <button id="preflight-button" type="button">Run preflight checks</button>
      </article>
    </section>

    <section class="card">
      <h2>App catalog</h2>
      <div class="grid">${catalogCards}</div>
    </section>

    <section class="card">
      <h2>Latest result</h2>
      <pre id="result">Choose an action to generate a bootstrap or install plan.</pre>
    </section>
  </main>
  <script>
    const result = document.getElementById('result');

    async function postJson(url, payload) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed');
      return data;
    }

    document.getElementById('bootstrap-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.target);
      const payload = Object.fromEntries(form.entries());
      const action = event.submitter?.dataset?.action || 'plan';
      try {
        const url = action === 'plan' ? '/api/bootstrap/plan' : '/api/bootstrap/execute';
        const body = {
          serviceUser: payload.serviceUser,
          baseInstallDir: payload.baseInstallDir,
          baseBackupDir: payload.baseBackupDir,
          dryRun: action !== 'execute',
          confirm: payload.confirm,
        };
        const data = await postJson(url, body);
        result.textContent = JSON.stringify(data, null, 2);
        if (action !== 'plan') window.location.reload();
      } catch (error) {
        result.textContent = error.message;
      }
    });

    document.getElementById('preflight-button').addEventListener('click', async () => {
      try {
        const response = await fetch('/api/preflight');
        const data = await response.json();
        result.textContent = JSON.stringify(data, null, 2);
        window.location.reload();
      } catch (error) {
        result.textContent = error.message;
      }
    });

    document.querySelectorAll('.install-form').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(event.target);
        const appId = event.target.dataset.appId;
        const payload = Object.fromEntries(formData.entries());
        const action = event.submitter?.dataset?.action || 'plan';
        if (payload.port) payload.port = Number(payload.port);
        try {
          const url = action === 'plan'
            ? '/api/apps/' + appId + '/install'
            : '/api/apps/' + appId + '/execute';
          const body = {
            mountPath: payload.mountPath,
            port: payload.port,
            dryRun: action !== 'execute',
            confirm: payload.confirm,
          };
          const data = await postJson(url, body);
          result.textContent = JSON.stringify(data, null, 2);
          if (action !== 'plan') window.location.reload();
        } catch (error) {
          result.textContent = error.message;
        }
      });
    });
  </script>
</body>
</html>`;
}

function renderJobPage({ job, appName = 'Home Base' }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Job #${escapeHtml(job.id)} · ${escapeHtml(appName)}</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: system-ui, sans-serif; margin: 0; background: #0b1220; color: #e5eef9; }
    main { max-width: 1100px; margin: 0 auto; padding: 1rem; display: grid; gap: 1rem; }
    .card { background: #111b2e; border: 1px solid #24324b; border-radius: 14px; padding: 1rem; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #08101c; padding: 1rem; border-radius: 12px; border: 1px solid #24324b; min-height: 16rem; max-height: 60vh; overflow: auto; }
    a { color: #9cc2ff; }
    .muted { color: #9fb0cf; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <p><a href="/">← Back to Home Base</a></p>
      <h1>Job #${escapeHtml(job.id)}</h1>
      <p class="muted">${escapeHtml(job.kind)} · ${escapeHtml(job.status)}${job.dryRun ? ' · dry-run' : ''}</p>
      <div id="summary">
        <p><strong>Target:</strong> ${escapeHtml(job.target)}</p>
        <p><strong>Current step:</strong> <span id="current-step">${escapeHtml(job.currentStep || 'waiting')}</span></p>
        <p><strong>Created:</strong> ${escapeHtml(job.createdAt || '')}</p>
        <p><strong>Started:</strong> <span id="started-at">${escapeHtml(job.startedAt || '')}</span></p>
        <p><strong>Finished:</strong> <span id="finished-at">${escapeHtml(job.finishedAt || '')}</span></p>
      </div>
    </section>

    <section class="card">
      <h2>Log</h2>
      <pre id="job-log">${escapeHtml(job.log || '')}</pre>
    </section>
  </main>
  <script>
    const jobId = ${JSON.stringify(job.id)};
    async function refreshJob() {
      const response = await fetch('/api/jobs/' + jobId);
      const data = await response.json();
      document.title = 'Job #' + data.id + ' · ${escapeHtml(appName)}';
      document.getElementById('current-step').textContent = data.currentStep || 'waiting';
      document.getElementById('started-at').textContent = data.startedAt || '';
      document.getElementById('finished-at').textContent = data.finishedAt || '';
      document.getElementById('job-log').textContent = data.log || '';
      if (data.status === 'running' || data.status === 'queued') {
        window.setTimeout(refreshJob, 1500);
      }
    }
    refreshJob().catch(() => {});
  </script>
</body>
</html>`;
}

module.exports = {
  renderHomePage,
  renderJobPage,
};
