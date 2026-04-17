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
          ${job.kind === 'bootstrap' && job.status === 'failed' ? `
            <form class="hb-actions" data-action="rerun-bootstrap">
              <button class="hb-btn" type="submit">Re-run bootstrap</button>
              <span class="hb-muted" data-result></span>
            </form>
          ` : ''}
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

  async function rerunBootstrap(form) {
    const resultNode = form.querySelector('[data-result]');
    const confirm = window.prompt('Type EXECUTE to re-run host bootstrap for real.');
    if (confirm !== 'EXECUTE') {
      if (resultNode) resultNode.textContent = 'Cancelled.';
      return;
    }
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
