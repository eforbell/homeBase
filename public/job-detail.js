(function jobDetailPage() {
  const root = document.getElementById('app');
  const jobId = (window.location.pathname.split('/')[2] || '').trim();
  let pollTimer = null;

  function parseJsonText(value) {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }

  function renderError(message) {
    root.innerHTML = `
      <section class="hb-card">
        <h1>Job not available</h1>
        <p class="hb-muted">${window.HB.escapeHtml(message || 'Unable to load job')}</p>
        <a href="/jobs">← Back to Jobs</a>
      </section>
    `;
  }

  function rerunSpec(job, plan) {
    if (job.status !== 'failed') return null;
    const dryRun = job.dryRun !== false;
    if (job.kind === 'bootstrap') {
      return { label: 'Re-run bootstrap', endpoint: '/api/bootstrap/execute', body: { dryRun } };
    }
    if (job.kind === 'install' && job.target) {
      const install = plan?.install || {};
      const body = { dryRun };
      if (install.mountPath) body.mountPath = install.mountPath;
      if (install.port) body.port = install.port;
      return { label: 'Re-run install', endpoint: `/api/apps/${encodeURIComponent(job.target)}/execute`, body };
    }
    if (job.kind === 'backup' && job.target) {
      return { label: 'Re-run backup', endpoint: `/api/apps/${encodeURIComponent(job.target)}/backup/execute`, body: { dryRun } };
    }
    if (job.kind === 'restore' && job.target && plan?.restore?.archiveDir) {
      return { label: 'Re-run restore', endpoint: `/api/apps/${encodeURIComponent(job.target)}/restore/execute`, body: { dryRun, backupDir: plan.restore.archiveDir } };
    }
    return { unsupportedReason: 'This failed job type does not support one-click rerun yet.' };
  }

  function renderRerunAction(job, plan) {
    const spec = rerunSpec(job, plan);
    if (!spec) return '';
    if (spec.unsupportedReason) {
      return `<p class="hb-muted" style="margin-top:0.65rem;">${window.HB.escapeHtml(spec.unsupportedReason)}</p>`;
    }
    return `
      <form class="hb-actions" data-action="rerun-job" data-job-id="${window.HB.escapeHtml(job.id)}">
        <button class="hb-btn" type="submit">${window.HB.escapeHtml(spec.label)}</button>
        <span class="hb-muted" data-result></span>
      </form>
    `;
  }

  function renderJob(job) {
    const plan = parseJsonText(job.planJson);
    const result = parseJsonText(job.resultJson);
    const planSummary = Array.isArray(plan?.steps) ? plan.steps.map((step) => `• ${step.id}: ${step.title}`).join('\n') : 'No step summary available yet.';
    const resultSummary = result ? JSON.stringify(result, null, 2) : 'No result payload yet.';
    const logText = job.log || 'No log lines yet.';
    root.innerHTML = `
      <div class="hb-stack">
        <section class="hb-card">
          <div class="hb-row">
            <h1 style="margin:0;">Job #${window.HB.escapeHtml(job.id)}</h1>
            ${window.HB.statusBadge(job.status)}
          </div>
          <p class="hb-muted" style="margin-top:0.5rem;">
            Kind: ${window.HB.escapeHtml(job.kind)} · Target: ${window.HB.escapeHtml(job.target)}
          </p>
          <p class="hb-muted" style="margin-top:0.5rem;">
            Created: ${window.HB.escapeHtml(window.HB.formatTimestamp(job.createdAt))}<br>
            Started: ${window.HB.escapeHtml(window.HB.formatTimestamp(job.startedAt))}<br>
            Finished: ${window.HB.escapeHtml(window.HB.formatTimestamp(job.finishedAt))}
          </p>
          ${renderRerunAction(job, plan)}
          <a href="/jobs">← Back to Jobs</a>
        </section>
        <section class="hb-card">
          <h2 style="margin-top:0;">Plan summary</h2>
          <pre class="hb-pre">${window.HB.escapeHtml(planSummary)}</pre>
        </section>
        <section class="hb-card">
          <h2 style="margin-top:0;">Result payload</h2>
          <pre class="hb-pre">${window.HB.escapeHtml(resultSummary)}</pre>
        </section>
        <section class="hb-card">
          <h2 style="margin-top:0;">Execution log</h2>
          <pre class="hb-pre">${window.HB.escapeHtml(logText)}</pre>
        </section>
      </div>
    `;
  }

  async function rerunJob(form) {
    const resultNode = form.querySelector('[data-result]');
    const currentJobId = form.getAttribute('data-job-id') || jobId;
    let job;
    let plan;
    try {
      job = await window.HB.getJson(`/api/jobs/${encodeURIComponent(currentJobId)}`);
      plan = parseJsonText(job.planJson);
    } catch (error) {
      if (resultNode) resultNode.textContent = error.message;
      return;
    }
    const spec = rerunSpec(job, plan);
    if (!spec || spec.unsupportedReason) {
      if (resultNode) resultNode.textContent = spec?.unsupportedReason || 'Rerun is not available for this job.';
      return;
    }
    const body = { ...spec.body };
    if (body.dryRun === false) {
      const confirm = window.prompt('Type EXECUTE to re-run this real job.');
      if (confirm !== 'EXECUTE') {
        if (resultNode) resultNode.textContent = 'Cancelled.';
        return;
      }
      body.confirm = 'EXECUTE';
    }
    if (resultNode) resultNode.textContent = 'Submitting...';
    try {
      const payload = await window.HB.postJson(spec.endpoint, body);
      window.location.href = `/jobs/${encodeURIComponent(payload.jobId)}`;
    } catch (error) {
      if (resultNode) resultNode.textContent = error.message;
    }
  }

  function wireEvents() {
    root.addEventListener('submit', (event) => {
      const rerunForm = event.target.closest('form[data-action="rerun-job"]');
      if (!rerunForm) return;
      event.preventDefault();
      rerunJob(rerunForm);
    });
  }

  async function loadJob() {
    if (!jobId || !/^\d+$/.test(jobId)) {
      renderError('Invalid job id in URL.');
      return;
    }
    try {
      const job = await window.HB.getJson(`/api/jobs/${jobId}`);
      renderJob(job);
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (job.status === 'queued' || job.status === 'running') {
        pollTimer = setTimeout(loadJob, 1500);
      }
    } catch (error) {
      renderError(error.message);
    }
  }

  wireEvents();
  loadJob();
}());
