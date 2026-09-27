(function appDetailPage() {
  const root = document.getElementById('app');
  const appId = (window.location.pathname.split('/')[2] || '').trim();

  function renderError(message) {
    root.innerHTML = `
      <section class="hb-card">
        <h1 style="margin:0;">App not available</h1>
        <p class="hb-muted" style="margin-top:0.5rem;">${window.HB.escapeHtml(message || 'Unable to load app')}</p>
        <a href="/apps">← Back to Apps</a>
      </section>
    `;
  }

  function renderBackupSummary(backups, config) {
    const latest = window.HB.latestBackup(backups);
    const backupLine = latest
      ? `Last backup: ${window.HB.escapeHtml(window.HB.formatTimestamp(latest.generatedAt))}${latest.status ? ` · ${window.HB.escapeHtml(latest.status)}` : ''}`
      : '<span class="hb-warn">No backups recorded yet. Take a first backup before relying on this install.</span>';
    return `<p class="hb-muted" style="margin:0.65rem 0 0;">${backupLine}<br>${window.HB.localOnlyBackupNote(config)}</p>`;
  }

  function scrollToCurrentHash() {
    if (!window.location.hash) return;
    const target = document.getElementById(window.location.hash.slice(1));
    if (target) target.scrollIntoView({ block: 'start' });
  }

  function buildBackupOptions(backups) {
    if (!backups.length) {
      return '<option value="">No backups available</option>';
    }
    return backups.map((item) => `
      <option value="${window.HB.escapeHtml(item.archiveDir)}">${window.HB.escapeHtml(item.name || item.archiveDir)} — ${window.HB.escapeHtml(window.HB.formatTimestamp(item.generatedAt))}</option>
    `).join('');
  }

  function probeSummary(label, probe) {
    const status = probe?.status || probe?.state || 'unknown';
    const message = probe?.message || '';
    return `
      <li class="hb-row">
        <strong>${window.HB.escapeHtml(label)}</strong>
        <span class="hb-badge">${window.HB.escapeHtml(status)}</span>
        <span class="hb-muted">${window.HB.escapeHtml(message)}</span>
      </li>
    `;
  }

  function updateStatusSummary(updateStatus) {
    if (!updateStatus) return 'Checking update status...';
    if (updateStatus.status === 'update-available') return 'Update available';
    if (updateStatus.status === 'check-failed') return 'Update check failed';
    return 'Up to date';
  }


  function lastJobSummary(lastJob, activeJob) {
    if (activeJob) {
      return `<span style="color:var(--yellow)">Job <a href="/jobs/${window.HB.escapeHtml(activeJob.id)}">#${window.HB.escapeHtml(activeJob.id)}</a> ${window.HB.escapeHtml(activeJob.kind)} running...</span>`;
    }
    if (!lastJob) return '';
    const color = lastJob.status === 'completed' ? '--green' : '--red';
    const label = lastJob.status === 'completed' ? 'succeeded' : 'failed';
    const ts = lastJob.finishedAt ? ` · ${window.HB.escapeHtml(window.HB.formatTimestamp(lastJob.finishedAt))}` : '';
    return `<span style="color:var(${color})">Last ${window.HB.escapeHtml(lastJob.kind)} <a href="/jobs/${window.HB.escapeHtml(lastJob.id)}">#${window.HB.escapeHtml(lastJob.id)}</a> ${label}${ts}</span>`;
  }

  function helperProbeSummary(helperProbe) {
    const state = helperProbe?.state || 'unknown';
    const message = helperProbe?.message || '';
    const unitName = helperProbe?.unitName || '';
    const label = helperProbe?.label || unitName || 'Helper unit';
    return `
      <li class="hb-row">
        <strong>${window.HB.escapeHtml(label)}</strong>
        <span class="hb-badge">${window.HB.escapeHtml(state)}</span>
        <span class="hb-muted">${window.HB.escapeHtml(unitName)}${message ? ` · ${window.HB.escapeHtml(message)}` : ''}</span>
      </li>
    `;
  }


  function isTerminalJobStatus(status) {
    return ['completed', 'failed', 'cancelled'].includes(String(status || ''));
  }

  async function waitForJobCompletion(jobId, resultNode, { refreshOnComplete = true, onComplete = null } = {}) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const job = await window.HB.getJson(`/api/jobs/${encodeURIComponent(jobId)}`);
        if (resultNode) {
          resultNode.innerHTML = `Job <a href="/jobs/${window.HB.escapeHtml(jobId)}">#${window.HB.escapeHtml(jobId)}</a> ${window.HB.escapeHtml(job.status)}.`;
        }
        if (isTerminalJobStatus(job.status)) {
          if (typeof onComplete === 'function') {
            onComplete(job);
          } else if (refreshOnComplete) {
            setTimeout(() => load(), 650);
          }
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

  async function handleBackup(form) {
    const dryRun = form.elements.dryRun.checked;
    const resultNode = form.querySelector('[data-result]');
    const submitButton = form.querySelector('button[type="submit"]');
    const payload = { dryRun };
    if (!dryRun) {
      payload.confirm = 'EXECUTE';
    }
    if (submitButton) submitButton.disabled = true;
    resultNode.textContent = 'Submitting...';
    try {
      const response = await window.HB.postJson(`/api/apps/${appId}/backup/execute`, payload);
      const mode = dryRun ? 'Backup dry-run' : 'Backup';
      resultNode.innerHTML = `${mode} job <a href="/jobs/${window.HB.escapeHtml(response.jobId)}">#${window.HB.escapeHtml(response.jobId)}</a> started. This page will refresh when it finishes.`;
      // Intentional fire-and-forget: keep the form responsive while the page repaints on terminal job state.
      void waitForJobCompletion(response.jobId, resultNode);
    } catch (error) {
      resultNode.textContent = error.message;
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  }

  async function handleUpdate(form, actionLabel = 'Update') {
    if (form.dataset.submitting === 'true') return;
    form.dataset.submitting = 'true';
    const mountPath = form.elements.mountPath.value.trim();
    const portRaw = form.elements.port.value.trim();
    const ref = form.elements.ref.value.trim();
    const dryRun = form.elements.dryRun.checked;
    const resultNode = form.querySelector('[data-result]');
    const submitButton = form.querySelector('button[type="submit"]');
    const payload = { mountPath, dryRun };
    if (submitButton) submitButton.disabled = true;
    if (portRaw) payload.port = Number(portRaw);
    if (ref) payload.ref = ref;
    if (!dryRun) {
      payload.confirm = 'EXECUTE';
    }
    resultNode.textContent = 'Submitting...';
    try {
      const response = await window.HB.postJson(`/api/apps/${appId}/execute`, payload);
      const mode = dryRun ? `${actionLabel} dry-run` : actionLabel;
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

  async function handleUpdateCheck(form) {
    const resultNode = form.querySelector('[data-result]');
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    if (resultNode) resultNode.textContent = 'Checking...';
    try {
      const payload = await window.HB.getJson('/api/apps/updates?refresh=1');
      const updateStatus = payload?.byAppId?.[appId] || null;
      const summary = updateStatusSummary(updateStatus);
      const statusNode = root.querySelector('[data-update-status]');
      if (statusNode) statusNode.textContent = summary;
      if (resultNode) resultNode.textContent = summary;
    } catch (error) {
      if (resultNode) resultNode.textContent = error.message;
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  }

  async function handleRestore(form) {
    const backupDir = form.elements.backupDir.value;
    const dryRun = form.elements.dryRun.checked;
    const resultNode = form.querySelector('[data-result]');
    if (!backupDir) {
      resultNode.textContent = 'Select a backup first.';
      return;
    }
    const payload = { backupDir, dryRun };
    if (!dryRun) {
      try {
        await window.HB.confirmInline(resultNode, 'Restore will overwrite the current app database and files. This cannot be undone.');
      } catch (_) {
        return;
      }
      payload.confirm = 'EXECUTE';
    }
    resultNode.textContent = 'Submitting...';
    try {
      const response = await window.HB.postJson(`/api/apps/${appId}/restore/execute`, payload);
      resultNode.innerHTML = `Started job <a href="/jobs/${window.HB.escapeHtml(response.jobId)}">#${window.HB.escapeHtml(response.jobId)}</a>. This page will refresh when it finishes.`;
      // Intentional fire-and-forget: keep the form responsive while the page repaints on terminal job state.
      void waitForJobCompletion(response.jobId, resultNode);
    } catch (error) {
      resultNode.textContent = error.message;
    }
  }

  async function handleRestart(form) {
    const dryRun = form.elements.dryRun.checked;
    const resultNode = form.querySelector('[data-result]');
    const payload = { dryRun };
    if (!dryRun) {
      payload.confirm = 'EXECUTE';
    }
    resultNode.textContent = 'Submitting...';
    try {
      const response = await window.HB.postJson(`/api/apps/${appId}/restart/execute`, payload);
      resultNode.innerHTML = `Started restart job <a href="/jobs/${window.HB.escapeHtml(response.jobId)}">#${window.HB.escapeHtml(response.jobId)}</a>.`;
      void waitForJobCompletion(response.jobId, resultNode, { refreshOnComplete: false });
    } catch (error) {
      resultNode.textContent = error.message;
    }
  }

  async function handleAbandonAdopt(form) {
    const resultNode = form.querySelector('[data-result]');
    try {
      await window.HB.confirmInline(resultNode, 'Abandoning returns this app to legacy routing. Files the adopt already changed stay as they are; the next steps to restore them are shown here.');
    } catch (_error) {
      return;
    }
    try {
      const response = await window.HB.postJson(`/api/apps/${appId}/adopt/abandon`, { confirm: 'ABANDON' });
      resultNode.innerHTML = `Back to legacy. Next:<ol>${(response.nextSteps || []).map((step) => `<li><code>${window.HB.escapeHtml(step)}</code></li>`).join('')}</ol>`;
    } catch (error) {
      resultNode.textContent = error.message;
    }
  }

  async function handleAdopt(form) {
    if (form.dataset.submitting === 'true') return;
    const dryRun = form.elements.dryRun.checked;
    const resultNode = form.querySelector('[data-result]');
    const payload = { dryRun };
    if (!dryRun) {
      try {
        await window.HB.confirmInline(resultNode, 'Adopt backs up this app, then rewrites its units, .env, and nginx snippet so the executor manages it from now on. Data and settings are kept.');
      } catch (_error) {
        return;
      }
      payload.confirm = 'EXECUTE';
    }
    form.dataset.submitting = 'true';
    resultNode.textContent = 'Submitting...';
    try {
      const response = await window.HB.postJson(`/api/apps/${appId}/adopt/execute`, payload);
      resultNode.innerHTML = `Started ${dryRun ? 'adopt preview' : 'adopt'} job <a href="/jobs/${window.HB.escapeHtml(response.jobId)}">#${window.HB.escapeHtml(response.jobId)}</a>.`;
      void waitForJobCompletion(response.jobId, resultNode, { refreshOnComplete: !dryRun });
    } catch (error) {
      resultNode.textContent = error.message;
    } finally {
      form.dataset.submitting = 'false';
    }
  }

  async function handleUninstall(form) {
    if (form.dataset.submitting === 'true') return;
    form.dataset.submitting = 'true';
    const dryRun = form.elements.dryRun.checked;
    const keepBackups = form.elements.keepBackups.checked;
    const resultNode = form.querySelector('[data-result]');
    const submitButton = form.querySelector('button[type="submit"]');
    const payload = { dryRun, keepBackups };
    if (submitButton) submitButton.disabled = true;
    if (!dryRun) {
      const backupClause = keepBackups
        ? ' Backup archives will be preserved under the existing backup root.'
        : ' Existing backup archives for this app will also be deleted.';
      try {
        await window.HB.confirmInline(resultNode, `Uninstall will stop and remove this app from Home Base.${backupClause} This cannot be undone from the UI.`);
      } catch (_error) {
        form.dataset.submitting = 'false';
        if (submitButton) submitButton.disabled = false;
        return;
      }
      payload.confirm = 'EXECUTE';
    }
    resultNode.textContent = 'Submitting...';
    try {
      const response = await window.HB.postJson(`/api/apps/${appId}/uninstall/execute`, payload);
      const mode = dryRun ? 'Uninstall dry-run' : 'Uninstall';
      resultNode.innerHTML = `${mode} job <a href="/jobs/${window.HB.escapeHtml(response.jobId)}">#${window.HB.escapeHtml(response.jobId)}</a> started.`;
      void waitForJobCompletion(response.jobId, resultNode, {
        refreshOnComplete: false,
        onComplete: (job) => {
          form.dataset.submitting = 'false';
          if (submitButton) submitButton.disabled = false;
          if (!dryRun && job.status === 'completed') {
            window.location.href = '/apps';
          }
        },
      });
      return;
    } catch (error) {
      resultNode.textContent = error.message;
    }
    form.dataset.submitting = 'false';
    if (submitButton) submitButton.disabled = false;
  }

  async function handleDiscardPlan(form) {
    const resultNode = form.querySelector('[data-result]');
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    try {
      await window.HB.confirmInline(resultNode, 'Discard this saved dry-run? It only removes Home Base metadata; no app files or backups will be deleted.');
      await window.HB.postJson(`/api/apps/${appId}/discard-plan`, { confirm: 'DISCARD' });
      window.location.href = '/apps';
    } catch (error) {
      resultNode.textContent = error.message === 'cancelled' ? 'Cancelled.' : error.message;
      if (submitButton) submitButton.disabled = false;
    }
  }

  function wireActions() {
    root.addEventListener('submit', (event) => {
      const backupForm = event.target.closest('form[data-action="backup"]');
      if (backupForm) {
        event.preventDefault();
        handleBackup(backupForm);
        return;
      }
      const updateForm = event.target.closest('form[data-action="update"]');
      if (updateForm) {
        event.preventDefault();
        handleUpdate(updateForm);
        return;
      }
      const installPlannedForm = event.target.closest('form[data-action="install-planned"]');
      if (installPlannedForm) {
        event.preventDefault();
        handleUpdate(installPlannedForm, 'Install');
        return;
      }
      const updateCheckForm = event.target.closest('form[data-action="update-check"]');
      if (updateCheckForm) {
        event.preventDefault();
        handleUpdateCheck(updateCheckForm);
        return;
      }
      const restoreForm = event.target.closest('form[data-action="restore"]');
      if (restoreForm) {
        event.preventDefault();
        handleRestore(restoreForm);
        return;
      }
      const restartForm = event.target.closest('form[data-action="restart"]');
      if (restartForm) {
        event.preventDefault();
        handleRestart(restartForm);
        return;
      }
      const uninstallForm = event.target.closest('form[data-action="uninstall"]');
      if (uninstallForm) {
        event.preventDefault();
        handleUninstall(uninstallForm);
        return;
      }
      const abandonForm = event.target.closest('form[data-action="abandon-adopt"]');
      if (abandonForm) {
        event.preventDefault();
        handleAbandonAdopt(abandonForm);
        return;
      }
      const adoptForm = event.target.closest('form[data-action="adopt"]');
      if (adoptForm) {
        event.preventDefault();
        handleAdopt(adoptForm);
        return;
      }
      const discardPlanForm = event.target.closest('form[data-action="discard-plan"]');
      if (discardPlanForm) {
        event.preventDefault();
        handleDiscardPlan(discardPlanForm);
      }
    });
  }

  async function load() {
    if (!appId) {
      renderError('Missing app id in URL.');
      return;
    }
    try {
      const [statePayload, catalogPayload, backupPayload, actionsPayload, config, healthPayload, updatesPayload] = await Promise.all([
        window.HB.getJson('/api/state'),
        window.HB.getJson('/api/catalog'),
        window.HB.getJson(`/api/apps/${appId}/backups`),
        window.HB.getJson(`/api/apps/${appId}/actions`),
        window.HB.getJson('/api/homebase/config'),
        window.HB.getJson('/api/apps/health'),
        window.HB.getJson('/api/apps/updates'),
      ]);
      const catalogApps = Array.isArray(catalogPayload.apps) ? catalogPayload.apps : [];
      const app = catalogApps.find((item) => item.id === appId);
      if (!app) {
        renderError(`Unknown app id: ${appId}`);
        return;
      }
      const install = (statePayload.installations || {})[appId] || null;
      const allJobs = Array.isArray(statePayload.jobs) ? statePayload.jobs : [];
      const lastAppJob = allJobs.find((j) => j.target === appId && ['completed', 'failed'].includes(j.status));
      const activeAppJob = (Array.isArray(statePayload.activeJobs) ? statePayload.activeJobs : []).find((j) => j.target === appId);
      const backups = Array.isArray(backupPayload.backups) ? backupPayload.backups : [];
      const backupAccess = backupPayload.access || { status: 'available' };
      const actions = actionsPayload.actions || {};
      const appHealth = (healthPayload.byAppId || {})[appId] || null;
      const updateStatus = (updatesPayload.byAppId || {})[appId] || install?.updateStatus || null;
      const mountPath = install?.mountPath || app.network?.preferredMountPath || `/${appId}/`;
      const port = install?.port || app.network?.preferredPort || '';
      const ref = install?.ref || app.repository?.defaultRef || 'main';

      document.title = `${app.name} - Home Base`;

      root.innerHTML = `
        <div class="hb-stack">
          <section class="hb-card">
            <div class="hb-row">
              ${app.icon ? `<span class="hb-app-icon" style="font-size:1.5rem;">${window.HB.escapeHtml(app.icon)}</span>` : ''}
              <h1 style="margin:0;">${window.HB.escapeHtml(app.name)}</h1>
              ${window.HB.statusBadge(install?.status || 'not-installed')}
            </div>
            <p class="hb-muted" style="margin:0.45rem 0 0;font-size:0.9rem;">${window.HB.escapeHtml(app.purpose || '')}</p>
            <p class="hb-muted" style="margin:0.35rem 0 0;font-size:0.83rem;">
              App ID: ${window.HB.escapeHtml(app.id)} · Port: ${window.HB.escapeHtml(port)} · Route: ${window.HB.escapeHtml(mountPath)}${install && actionsPayload.managedBy ? ` · Managed by: ${({ executor: 'executor', adopting: 'adoption incomplete (re-run adopt)' })[actionsPayload.managedBy] || 'legacy (sudo)'}` : ''}
            </p>
            <div class="hb-actions" style="margin-top:0.75rem;">
              ${install?.externalUrl ? `<a class="hb-btn hb-btn-primary" href="${window.HB.escapeHtml(install.externalUrl)}" target="_blank" rel="noreferrer">Open ↗</a>` : ''}
              ${appHealth?.onboarding?.setupUrl ? `<a class="hb-btn" href="${window.HB.escapeHtml(appHealth.onboarding.setupUrl)}" target="_blank" rel="noreferrer">Setup ↗</a>` : ''}
              <span class="hb-muted" style="font-size:0.83rem;margin-left:0.25rem;">
                <a href="#health">Health</a> · <a href="#backup">Backup</a> · <a href="#restore">Restore</a> · <a href="#update">Update</a> · <a href="#uninstall" style="color:var(--red);">Uninstall</a>
              </span>
            </div>
            ${renderBackupSummary(backups, config)}
          </section>

          <section id="health" class="hb-card">
            <div class="hb-row">
              <h2 style="margin:0;">Runtime health</h2>
              ${window.HB.runtimeStatusPill(appHealth?.runtimeStatus || 'unknown')}
              ${window.HB.statusBadge(install?.status || 'not-installed')}
            </div>
            <p class="hb-muted" style="margin:0.55rem 0 0;">
              Last check: ${window.HB.escapeHtml(window.HB.formatTimestamp(appHealth?.checkedAt))}
            </p>
            ${appHealth?.recoveryHint ? `<p class="${['service-down', 'http-failing', 'readiness-failing', 'helper-failing'].includes(appHealth.runtimeStatus) ? 'hb-warn' : 'hb-muted'}" style="margin:0.55rem 0 0;">${window.HB.escapeHtml(appHealth.recoveryHint)}</p>` : ''}
            <ul class="hb-stack" style="list-style:none;padding:0;margin:0.75rem 0 0;">
              ${probeSummary('Service state', appHealth?.service)}
              ${probeSummary('HTTP liveness', appHealth?.liveness)}
              ${probeSummary('HTTP readiness', appHealth?.readiness)}
              ${probeSummary('Onboarding', appHealth?.onboarding)}
            </ul>
            ${(appHealth?.helperUnits || []).length
    ? `
            <h3 style="margin:0.85rem 0 0.35rem;font-size:0.95rem;">Helper units</h3>
            <ul class="hb-stack" style="list-style:none;padding:0;margin:0;">
              ${(appHealth.helperUnits || []).map(helperProbeSummary).join('')}
            </ul>
            `
    : ''}
          </section>

          ${install?.status === 'planned' ? `
            <section class="hb-card">
              <h2 style="margin-top:0;">Saved dry-run</h2>
              <p class="hb-warn" style="margin:0 0 0.75rem;">This plan did not install the app. Run the real typed install below, or discard only the saved Home Base metadata.</p>
              <form class="hb-form-grid" data-action="install-planned">
                <label class="hb-label">Mount path <input class="hb-input" name="mountPath" value="${window.HB.escapeHtml(mountPath)}"></label>
                <label class="hb-label">Port <input class="hb-input" name="port" type="number" min="1" max="65535" value="${window.HB.escapeHtml(port)}"></label>
                <label class="hb-label">Git ref <input class="hb-input" name="ref" value="${window.HB.escapeHtml(ref)}" placeholder="main"></label>
                <label class="hb-label hb-check-row"><input name="dryRun" type="checkbox"> Plan only</label>
                <div><button class="hb-btn hb-btn-primary" type="submit">Run real install</button></div>
                <p class="hb-muted" data-result style="margin:0;"></p>
              </form>
              ${actions.discardPlan ? `
                <form class="hb-form-grid" data-action="discard-plan" style="margin-top:0.85rem;">
                  <div><button class="hb-btn" type="submit" style="border-color:rgba(248,113,113,0.35);color:var(--red);">Discard saved plan</button></div>
                  <p class="hb-muted" data-result style="margin:0;"></p>
                </form>
              ` : ''}
            </section>
          ` : ''}

          ${actions.adopt ? `
            <section id="adopt" class="hb-card">
              <h2 style="margin-top:0;">Executor adoption</h2>
              ${actionsPayload.managedBy === 'adopting' ? `
                <p class="hb-warn" style="margin:0 0 0.75rem;">The last adopt did not finish. Re-run it; it picks up where it stopped. Other actions stay disabled for this app until it completes, or until you abandon it.</p>
                <form class="hb-form-grid" data-action="abandon-adopt" style="margin:0 0 0.75rem;">
                  <div><button class="hb-btn" type="submit" style="border-color:rgba(248,113,113,0.35);color:var(--red);">Abandon adopt (back to legacy)</button></div>
                  <p class="hb-muted" data-result style="margin:0;"></p>
                </form>` : ''}
              <p class="hb-muted" style="margin:0 0 0.75rem;">This app was installed by legacy (sudo) mode. Adopting hands it to the typed executor in place: same checkout, data, and settings. Adopt apps one at a time; switch the host to executor mode once all of them are adopted.</p>
              <form class="hb-form-grid" data-action="adopt">
                <label class="hb-label hb-check-row"><input name="dryRun" type="checkbox" checked> Preview the plan only</label>
                <div><button class="hb-btn hb-btn-primary" type="submit">Adopt into executor</button></div>
                <p class="hb-muted" data-result style="margin:0;"></p>
              </form>
            </section>
          ` : ''}

          ${backupAccess.status === 'unavailable' ? `<section class="hb-card"><p class="hb-warn" style="margin:0;">${window.HB.escapeHtml(backupAccess.summary || 'Backup inventory is unavailable.')}</p></section>` : ''}

          <section class="hb-grid hb-grid-2">
            <article id="backup" class="hb-card">
              <h2 style="margin-top:0;">Backup</h2>
              <form class="hb-form-grid" data-action="backup">
                <label class="hb-label hb-check-row">
                  <input name="dryRun" type="checkbox" checked> Dry-run only
                </label>
                <div><button class="hb-btn" type="submit">Run backup</button></div>
                <p class="hb-muted" data-result style="margin:0;"></p>
              </form>
              <form class="hb-form-grid" data-action="restart" style="margin-top:0.75rem;">
                <label class="hb-label hb-check-row">
                  <input name="dryRun" type="checkbox" checked> Dry-run only
                </label>
                <div><button class="hb-btn" type="submit" ${actions.restart ? '' : 'disabled'}>Run restart</button></div>
                <p class="hb-muted" data-result style="margin:0;"></p>
              </form>
              <p class="hb-muted" style="margin:0.6rem 0 0;">
                Restart: ${actions.restart ? 'Available' : 'Install app first'} ·
                Update: Available ·
                Uninstall: ${actions.uninstall ? 'Available' : 'Install app first'}
              </p>
            </article>

            <article id="update" class="hb-card">
              <h2 style="margin-top:0;">Update</h2>
              <p class="hb-muted" data-update-status style="margin:0 0 0.6rem;">${window.HB.escapeHtml(updateStatusSummary(updateStatus))}</p>
              ${lastJobSummary(lastAppJob, activeAppJob) ? `<p style="margin:0 0 0.6rem;">${lastJobSummary(lastAppJob, activeAppJob)}</p>` : ''}
              <form class="hb-form-grid" data-action="update-check" style="margin-bottom:0.75rem;">
                <div><button class="hb-btn" type="submit">Check now</button></div>
                <p class="hb-muted" data-result style="margin:0;"></p>
              </form>
              <form class="hb-form-grid" data-action="update">
                <label class="hb-label">Mount path <input class="hb-input" name="mountPath" value="${window.HB.escapeHtml(mountPath)}"></label>
                <label class="hb-label">Port <input class="hb-input" name="port" type="number" min="1" max="65535" value="${window.HB.escapeHtml(port)}"></label>
                <label class="hb-label">Git ref <input class="hb-input" name="ref" value="${window.HB.escapeHtml(ref)}" placeholder="main"></label>
                <label class="hb-label hb-check-row">
                  <input name="dryRun" type="checkbox" checked> Dry-run only
                </label>
                <div><button class="hb-btn hb-btn-primary" type="submit">Run update</button></div>
                <p class="hb-muted" data-result style="margin:0;"></p>
                <p class="hb-muted" style="margin:0;">Update code to a branch or ref, re-apply services, and fully redeploy this app.</p>
              </form>
            </article>
          </section>

          <section id="restore" class="hb-card">
            <h2 style="margin-top:0;">Restore from backup</h2>
            <form class="hb-form-grid" data-action="restore">
              <label class="hb-label">
                Backup snapshot
                <select class="hb-select" name="backupDir">${buildBackupOptions(backups)}</select>
              </label>
              <label class="hb-label hb-check-row">
                <input name="dryRun" type="checkbox" checked> Dry-run only
              </label>
              <div><button class="hb-btn" type="submit">Run restore</button></div>
              <p class="hb-muted" data-result style="margin:0;"></p>
            </form>
          </section>

          <section id="uninstall" class="hb-card">
            <h2 style="margin-top:0;">Uninstall</h2>
            <p class="hb-warn" style="margin:0 0 0.75rem;">Uninstall removes this app from Home Base management and is intended to fully remove the current install.</p>
            <form class="hb-form-grid" data-action="uninstall">
              <label class="hb-label hb-check-row">
                <input name="keepBackups" type="checkbox" checked> Keep backups
              </label>
              <label class="hb-label hb-check-row">
                <input name="dryRun" type="checkbox" checked> Dry-run only
              </label>
              <div><button class="hb-btn" type="submit" style="border-color:rgba(248,113,113,0.35);color:var(--red);" ${actions.uninstall ? '' : 'disabled'}>Run uninstall</button></div>
              <p class="hb-muted" style="margin:0;">Backups are preserved by default under the existing backup root. Disable Keep backups to delete them too.</p>
              <p class="hb-muted" data-result style="margin:0;"></p>
            </form>
          </section>

          <section class="hb-card">
            <h2 style="margin-top:0;">Backup history</h2>
            ${backups.length
    ? `<ul class="hb-stack" style="list-style:none;padding:0;margin:0;">${backups.map((item) => `
                  <li class="hb-row">
                    <span>${window.HB.escapeHtml(item.name || item.archiveDir)}</span>
                    ${window.HB.statusBadge(item.status)}
                    <span class="hb-muted">${window.HB.escapeHtml(window.HB.formatTimestamp(item.generatedAt))}</span>
                  </li>
                `).join('')}</ul>`
    : '<p class="hb-muted" style="margin:0;">No backups recorded yet.</p>'}
          </section>

          <details class="hb-card">
            <summary>Advanced details</summary>
            <pre class="hb-pre" style="margin-top:0.75rem;">${window.HB.escapeHtml(JSON.stringify({
    app,
    installation: install,
    actions,
    backupsCount: backups.length,
  }, null, 2))}</pre>
          </details>
        </div>
      `;
      wireActions();
      scrollToCurrentHash();
    } catch (error) {
      renderError(error.message);
    }
  }

  load();
}());
