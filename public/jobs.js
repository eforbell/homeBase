(function jobsPage() {
  const root = document.getElementById('app');
  let pollTimer = null;

  function renderJobRow(job) {
    return `
      <li class="hb-card">
        <div class="hb-row">
          <a href="/jobs/${window.HB.escapeHtml(job.id)}"><strong>Job #${window.HB.escapeHtml(job.id)}</strong></a>
          ${window.HB.statusBadge(job.status)}
        </div>
        <p class="hb-muted" style="margin:0.5rem 0 0;">
          ${window.HB.escapeHtml(job.kind)} · ${window.HB.escapeHtml(job.target)} · ${window.HB.escapeHtml(window.HB.formatTimestamp(job.createdAt))}
        </p>
      </li>
    `;
  }

  function renderJobs(jobs) {
    const rows = jobs.length
      ? jobs.map((job) => renderJobRow(job)).join('')
      : '<li class="hb-card"><p class="hb-muted" style="margin:0;">No jobs yet.</p></li>';
    root.innerHTML = `
      <div class="hb-stack">
        <section class="hb-card">
          <h1 style="margin:0;">Jobs</h1>
          <p class="hb-muted" style="margin:0.5rem 0 0;">Recent install/backup/restore/bootstrap activity.</p>
        </section>
        <ul class="hb-stack" style="list-style:none;padding:0;margin:0;">${rows}</ul>
      </div>
    `;
  }

  async function loadJobs() {
    try {
      const payload = await window.HB.getJson('/api/jobs');
      const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
      renderJobs(jobs);
      if (pollTimer) clearTimeout(pollTimer);
      if (jobs.some((job) => job.status === 'queued' || job.status === 'running')) {
        pollTimer = setTimeout(loadJobs, 1500);
      }
    } catch (error) {
      root.innerHTML = `
        <section class="hb-card">
          <h1 style="margin:0;">Jobs</h1>
          <p class="hb-muted" style="margin-top:0.5rem;">${window.HB.escapeHtml(error.message)}</p>
        </section>
      `;
    }
  }

  loadJobs();
}());
