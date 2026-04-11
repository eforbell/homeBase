function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeJsonParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function joinExternalPath(baseUrl, path) {
  if (!path) return baseUrl;
  return `${String(baseUrl || '').replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
}

function renderInstallationList(installations, catalog = []) {
  return Object.values(installations || {}).map((item) => `
    <li>
      <strong>${escapeHtml(item.name)}</strong>
      <div>${escapeHtml(item.mountPath)} → ${escapeHtml(item.externalUrl)}</div>
      <div>port ${escapeHtml(item.port)} · ${escapeHtml(item.status)}</div>
      <div class="button-row" style="margin-top:.5rem">
        <a href="${escapeHtml(item.externalUrl)}" target="_blank" rel="noreferrer" style="color:#9cc2ff">Open</a>
        ${catalog.find((app) => app.id === item.appId)?.onboarding
          ? `<a href="${escapeHtml(joinExternalPath(item.externalUrl, catalog.find((app) => app.id === item.appId).onboarding.setupPath))}" target="_blank" rel="noreferrer" style="color:#9cc2ff">Set up household</a>`
          : ''}
      </div>
    </li>
  `).join('') || '<li>No planned installs yet.</li>';
}

function renderJobList(jobs) {
  return (jobs || []).map((job) => `
    <li>
      <strong><a href="/jobs/${escapeHtml(job.id)}" style="color:#9cc2ff">#${escapeHtml(job.id)}</a></strong>
      <div>${escapeHtml(job.kind)} · ${escapeHtml(job.status)}${job.dryRun ? ' · dry-run' : ''}</div>
      <div>${escapeHtml(job.currentStep || 'waiting')}</div>
    </li>
  `).join('') || '<li>No jobs yet.</li>';
}

function renderHomePage({ catalog, state, config }) {
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
        ${app.onboarding ? `<li><strong>First run:</strong> browser setup at ${escapeHtml(app.onboarding.setupPath)}</li>` : ''}
      </ul>

      <form class="install-form" data-app-id="${escapeHtml(app.id)}">
        <label>Mount path <input name="mountPath" value="${escapeHtml(app.network.preferredMountPath)}"></label>
        <label>Port <input name="port" type="number" value="${escapeHtml(app.network.preferredPort)}"></label>
        <label>Confirm execute <input name="confirm" placeholder="EXECUTE for real run"></label>
        <div class="button-row">
          <button type="submit" data-action="plan">Generate install plan</button>
          <button type="submit" data-action="dry-run">Run install dry-run</button>
          <button type="submit" data-action="execute">Run install for real</button>
        </div>
      </form>

      <hr class="separator">

      <form class="backup-form" data-app-id="${escapeHtml(app.id)}">
        <label>Confirm execute <input name="confirm" placeholder="EXECUTE for real run"></label>
        <div class="button-row">
          <button type="submit" data-action="plan">Generate backup plan</button>
          <button type="submit" data-action="dry-run">Run backup dry-run</button>
          <button type="submit" data-action="execute">Run backup for real</button>
        </div>
      </form>

      <hr class="separator">

      <form class="restore-form" data-app-id="${escapeHtml(app.id)}">
        <label>Backup archive
          <select name="backupDir" data-backup-select="${escapeHtml(app.id)}">
            <option value="">Loading backups…</option>
          </select>
        </label>
        <label>Confirm execute <input name="confirm" placeholder="EXECUTE for real run"></label>
        <div class="button-row">
          <button type="submit" data-action="plan">Generate restore plan</button>
          <button type="submit" data-action="dry-run">Run restore dry-run</button>
          <button type="submit" data-action="execute">Run restore for real</button>
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
    input, button, textarea, select { font: inherit; border-radius: 10px; border: 1px solid #38507a; background: #08101c; color: inherit; padding: .7rem; }
    button { background: #3559e0; border-color: #3559e0; cursor: pointer; }
    button:hover { filter: brightness(1.07); }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #08101c; padding: 1rem; border-radius: 12px; border: 1px solid #24324b; max-height: 30rem; overflow: auto; }
    ul { padding-left: 1.1rem; }
    .muted { color: #9fb0cf; }
    .button-row { display:flex; gap:.5rem; flex-wrap:wrap; }
    .separator { border-color:#24324b; margin:1rem 0; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(config.appName)}</h1>
    <p class="muted">Debian-first control plane for Sovereign Home apps. This slice now supports preflight, bootstrap/install jobs, and backup/restore planning to prepare for VM rehearsal.</p>
  </header>
  <main>
    <section class="grid">
      <article class="card">
        <h2>Install Home Base as a service</h2>
        <p class="muted">Render the plan for moving Home Base from a shell-launched dev server into a stable systemd-managed service.</p>
        <label>Runtime port <input id="runtime-port" type="number" value="${escapeHtml(config.port)}"></label>
        <label><input id="runtime-start-now" type="checkbox"> Start service immediately after install</label>
        <label>Confirm execute <input id="runtime-confirm" placeholder="EXECUTE for real run"></label>
        <div class="button-row">
          <button id="runtime-plan-button" type="button">Generate runtime plan</button>
          <button id="runtime-dry-run-button" type="button">Run runtime dry-run</button>
          <button id="runtime-execute-button" type="button">Run runtime install for real</button>
        </div>
      </article>
      <article class="card">
        <h2>Bootstrap host</h2>
        <form id="bootstrap-form">
          <label>Service user <input name="serviceUser" value="${escapeHtml(config.serviceUser)}"></label>
          <label>Install root <input name="baseInstallDir" value="${escapeHtml(config.baseInstallDir)}"></label>
          <label>Backup root <input name="baseBackupDir" value="${escapeHtml(config.baseBackupDir)}"></label>
          <label>Confirm execute <input name="confirm" placeholder="EXECUTE for real run"></label>
          <div class="button-row">
            <button type="submit" data-action="plan">Generate bootstrap plan</button>
            <button type="submit" data-action="dry-run">Run bootstrap dry-run</button>
            <button type="submit" data-action="execute">Run bootstrap for real</button>
          </div>
        </form>
      </article>
      <article class="card">
        <h2>Planned installs</h2>
        <ul id="installations-list">${renderInstallationList(state.installations, catalog)}</ul>
      </article>
      <article class="card">
        <h2>Recent jobs</h2>
        <ul id="jobs-list">${renderJobList(state.jobs)}</ul>
      </article>
      <article class="card">
        <h2>Preflight</h2>
        <p id="preflight-summary">${escapeHtml(preflightSummary)}</p>
        <button id="preflight-button" type="button">Run preflight checks</button>
      </article>
    </section>

    <section class="card">
      <h2>App catalog</h2>
      <div class="grid">${catalogCards}</div>
    </section>

    <section class="card">
      <h2>Latest result</h2>
      <pre id="result">Choose an action to generate a bootstrap, install, backup, or restore plan.</pre>
    </section>
  </main>
  <script>
    const result = document.getElementById('result');
    const jobsList = document.getElementById('jobs-list');
    const installationsList = document.getElementById('installations-list');
    const preflightSummary = document.getElementById('preflight-summary');

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

    async function getJson(url) {
      const response = await fetch(url);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed');
      return data;
    }

    async function submitPlanAction({ action, planUrl, executeUrl, payload }) {
      const url = action === 'plan' ? planUrl : executeUrl;
      const data = await postJson(url, {
        ...payload,
        dryRun: action !== 'execute',
      });
      result.textContent = JSON.stringify(data, null, 2);
      if (action !== 'plan') {
        startStatePolling();
      }
    }

    const appCatalog = ${JSON.stringify(catalog.map((app) => ({
      id: app.id,
      onboarding: app.onboarding || null,
    })))};

    function joinExternalPathClient(baseUrl, path) {
      if (!path) return baseUrl;
      return String(baseUrl || '').replace(/\\/$/, '') + '/' + String(path).replace(/^\\//, '');
    }

    function renderInstallations(items) {
      if (!items.length) return '<li>No planned installs yet.</li>';
      return items.map((item) => {
        const app = appCatalog.find((candidate) => candidate.id === item.appId);
        const setupLink = app && app.onboarding
          ? '<a href="' + joinExternalPathClient(item.externalUrl, app.onboarding.setupPath) + '" target="_blank" rel="noreferrer" style="color:#9cc2ff">Set up household</a>'
          : '';
        return '<li>' +
          '<strong>' + item.name + '</strong>' +
          '<div>' + item.mountPath + ' → ' + item.externalUrl + '</div>' +
          '<div>port ' + item.port + ' · ' + item.status + '</div>' +
          '<div class="button-row" style="margin-top:.5rem">' +
            '<a href="' + item.externalUrl + '" target="_blank" rel="noreferrer" style="color:#9cc2ff">Open</a>' +
            setupLink +
          '</div>' +
        '</li>';
      }).join('');
    }

    function renderJobs(items) {
      if (!items.length) return '<li>No jobs yet.</li>';
      return items.map((job) =>
        '<li>' +
          '<strong><a href="/jobs/' + job.id + '" style="color:#9cc2ff">#' + job.id + '</a></strong>' +
          '<div>' + job.kind + ' · ' + job.status + (job.dryRun ? ' · dry-run' : '') + '</div>' +
          '<div>' + (job.currentStep || 'waiting') + '</div>' +
        '</li>'
      ).join('');
    }

    let polling = false;
    async function refreshState() {
      const data = await getJson('/api/state');
      installationsList.innerHTML = renderInstallations(Object.values(data.installations || {}));
      jobsList.innerHTML = renderJobs(data.jobs || []);
      if (data.preflight) {
        const passing = data.preflight.checks.filter((check) => check.ok).length;
        preflightSummary.textContent = passing + '/' + data.preflight.checks.length + ' checks passing';
      }
      const hasActiveJob = (data.jobs || []).some((job) => job.status === 'queued' || job.status === 'running');
      polling = hasActiveJob;
      if (hasActiveJob) {
        window.setTimeout(() => refreshState().catch(() => {}), 2000);
      }
    }

    function startStatePolling() {
      if (polling) return;
      polling = true;
      refreshState().catch(() => {
        polling = false;
      });
    }

    async function populateBackups(appId) {
      const select = document.querySelector('[data-backup-select="' + appId + '"]');
      if (!select) return;
      try {
        const data = await getJson('/api/apps/' + appId + '/backups');
        if (!data.backups.length) {
          select.innerHTML = '<option value="">No backups found yet</option>';
          return;
        }
        select.innerHTML = data.backups.map((backup) => {
          const label = backup.generatedAt ? (backup.generatedAt + ' · ' + backup.name) : backup.name;
          return '<option value="' + backup.archiveDir + '">' + label + '</option>';
        }).join('');
      } catch (error) {
        select.innerHTML = '<option value="">' + error.message + '</option>';
      }
    }

    document.getElementById('bootstrap-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.target);
      const payload = Object.fromEntries(form.entries());
      const action = event.submitter?.dataset?.action || 'plan';
      try {
        await submitPlanAction({
          action,
          planUrl: '/api/bootstrap/plan',
          executeUrl: '/api/bootstrap/execute',
          payload: {
            serviceUser: payload.serviceUser,
            baseInstallDir: payload.baseInstallDir,
            baseBackupDir: payload.baseBackupDir,
            confirm: payload.confirm,
          },
        });
      } catch (error) {
        result.textContent = error.message;
      }
    });

    document.getElementById('runtime-plan-button').addEventListener('click', async () => {
      try {
        const data = await postJson('/api/homebase/runtime-plan', {
          port: Number(document.getElementById('runtime-port').value || ${config.port}),
          startImmediately: document.getElementById('runtime-start-now').checked,
        });
        result.textContent = JSON.stringify(data, null, 2);
      } catch (error) {
        result.textContent = error.message;
      }
    });

    document.getElementById('runtime-dry-run-button').addEventListener('click', async () => {
      try {
        const data = await postJson('/api/homebase/install-self', {
          port: Number(document.getElementById('runtime-port').value || ${config.port}),
          startImmediately: document.getElementById('runtime-start-now').checked,
          dryRun: true,
        });
        result.textContent = JSON.stringify(data, null, 2);
        startStatePolling();
      } catch (error) {
        result.textContent = error.message;
      }
    });

    document.getElementById('runtime-execute-button').addEventListener('click', async () => {
      try {
        const data = await postJson('/api/homebase/install-self', {
          port: Number(document.getElementById('runtime-port').value || ${config.port}),
          startImmediately: document.getElementById('runtime-start-now').checked,
          confirm: document.getElementById('runtime-confirm').value,
          dryRun: false,
        });
        result.textContent = JSON.stringify(data, null, 2);
        startStatePolling();
      } catch (error) {
        result.textContent = error.message;
      }
    });

    document.getElementById('preflight-button').addEventListener('click', async () => {
      try {
        const data = await getJson('/api/preflight');
        result.textContent = JSON.stringify(data, null, 2);
        const passing = data.checks.filter((check) => check.ok).length;
        preflightSummary.textContent = passing + '/' + data.checks.length + ' checks passing';
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
          await submitPlanAction({
            action,
            planUrl: '/api/apps/' + appId + '/install',
            executeUrl: '/api/apps/' + appId + '/execute',
            payload: {
              mountPath: payload.mountPath,
              port: payload.port,
              confirm: payload.confirm,
            },
          });
        } catch (error) {
          result.textContent = error.message;
        }
      });
    });

    document.querySelectorAll('.backup-form').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(event.target);
        const appId = event.target.dataset.appId;
        const payload = Object.fromEntries(formData.entries());
        const action = event.submitter?.dataset?.action || 'plan';
        try {
          await submitPlanAction({
            action,
            planUrl: '/api/apps/' + appId + '/backup-plan',
            executeUrl: '/api/apps/' + appId + '/backup/execute',
            payload: {
              confirm: payload.confirm,
            },
          });
          populateBackups(appId);
        } catch (error) {
          result.textContent = error.message;
        }
      });
    });

    document.querySelectorAll('.restore-form').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(event.target);
        const appId = event.target.dataset.appId;
        const payload = Object.fromEntries(formData.entries());
        const action = event.submitter?.dataset?.action || 'plan';
        try {
          await submitPlanAction({
            action,
            planUrl: '/api/apps/' + appId + '/restore-plan',
            executeUrl: '/api/apps/' + appId + '/restore/execute',
            payload: {
              backupDir: payload.backupDir,
              confirm: payload.confirm,
            },
          });
        } catch (error) {
          result.textContent = error.message;
        }
      });
    });

    document.querySelectorAll('[data-backup-select]').forEach((select) => {
      populateBackups(select.dataset.backupSelect);
    });

    if ((JSON.parse(${JSON.stringify(JSON.stringify(state.jobs || []))})).some((job) => job.status === 'queued' || job.status === 'running')) {
      startStatePolling();
    }
  </script>
</body>
</html>`;
}

function renderJobPage({ job, appName = 'Home Base' }) {
  const plan = safeJsonParse(job.planJson);
  const resultPayload = safeJsonParse(job.resultJson);
  const planSummary = plan
    ? JSON.stringify({
        kind: plan.kind,
        app: plan.app || null,
        backup: plan.backup || null,
        restore: plan.restore || null,
        stepCount: Array.isArray(plan.steps)
          ? plan.steps.length
          : Array.isArray(plan.executionSteps)
            ? plan.executionSteps.length
            : Array.isArray(plan.commands)
              ? plan.commands.length
              : 0,
      }, null, 2)
    : 'No parsed plan available.';
  const resultSummary = resultPayload
    ? JSON.stringify(resultPayload, null, 2)
    : 'No result payload yet.';

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
    .grid { display:grid; gap:1rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #08101c; padding: 1rem; border-radius: 12px; border: 1px solid #24324b; min-height: 10rem; max-height: 60vh; overflow: auto; }
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

    <section class="grid">
      <section class="card">
        <h2>Plan summary</h2>
        <pre>${escapeHtml(planSummary)}</pre>
      </section>
      <section class="card">
        <h2>Result summary</h2>
        <pre id="job-result">${escapeHtml(resultSummary)}</pre>
      </section>
    </section>

    <section class="card">
      <h2>Log</h2>
      <pre id="job-log">${escapeHtml(job.log || '')}</pre>
    </section>
  </main>
  <script>
    const jobId = ${JSON.stringify(job.id)};
    function escapeHtmlClient(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    }
    async function refreshJob() {
      const response = await fetch('/api/jobs/' + jobId);
      const data = await response.json();
      document.title = 'Job #' + data.id + ' · ${escapeHtml(appName)}';
      document.getElementById('current-step').textContent = data.currentStep || 'waiting';
      document.getElementById('started-at').textContent = data.startedAt || '';
      document.getElementById('finished-at').textContent = data.finishedAt || '';
      document.getElementById('job-log').textContent = data.log || '';
      const resultText = data.resultJson ? JSON.stringify(JSON.parse(data.resultJson), null, 2) : 'No result payload yet.';
      document.getElementById('job-result').textContent = resultText;
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
