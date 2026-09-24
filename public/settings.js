(function controlPlanePages() {
  const root = document.getElementById('app');
  const page = document.body.getAttribute('data-nav-page') || 'config';

  function renderAdminAudit(entries) {
    const items = Array.isArray(entries) ? entries : [];
    if (!items.length) return '<p class="hb-muted" style="margin:0;">No destructive action audit entries yet.</p>';
    return `
      <ul class="hb-stack" style="list-style:none;padding:0;margin:0;">
        ${items.map((item) => `
          <li class="hb-row">
            <span>${window.HB.escapeHtml(item.action)}</span>
            <span class="${item.outcome === 'queued' ? 'hb-ok' : 'hb-warn'}">${window.HB.escapeHtml(item.outcome)}</span>
            <span class="hb-muted">${window.HB.escapeHtml(item.target)}</span>
            <span class="hb-muted">${window.HB.escapeHtml(window.HB.formatTimestamp(item.createdAt))}</span>
            ${item.jobId ? `<a href="/jobs/${window.HB.escapeHtml(item.jobId)}">#${window.HB.escapeHtml(item.jobId)}</a>` : ''}
          </li>
        `).join('')}
      </ul>
    `;
  }

  function renderChecks(preflight, { ids = null, label = 'checks' } = {}) {
    const requestedIds = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    const checks = (Array.isArray(preflight?.checks) ? preflight.checks : []).filter((check) => !requestedIds || requestedIds.has(check.id));
    if (!checks.length) return `<p class="hb-muted" style="margin:0;">No ${window.HB.escapeHtml(label)} returned.</p>`;
    return `
      <div class="hb-table-wrap" role="region" aria-label="${window.HB.escapeHtml(label)}">
        <table class="hb-table">
          <thead><tr><th>Check</th><th>Status</th><th>Summary</th><th>Hint</th></tr></thead>
          <tbody>
            ${checks.map((check) => `
              <tr>
                <td>${window.HB.escapeHtml(check.title || check.id)}</td>
                <td>${check.ok === true ? '<span class="hb-ok">PASS</span>' : (check.ok === null ? '<span class="hb-warn">NOT CHECKED</span>' : (check.severity === 'critical' ? '<span class="hb-err">FAIL</span>' : '<span class="hb-warn">WARN</span>'))}</td>
                <td>${window.HB.escapeHtml(check.summary || '')}</td>
                <td>${window.HB.escapeHtml(check.hint || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  async function submitConfig(form) {
    const result = form.querySelector('[data-config-result]');
    const payload = {
      hostname: form.elements.hostname.value.trim(),
      domain: form.elements.domain.value.trim(),
      gitTransport: form.elements.gitTransport.value,
      gitSshKeyPath: form.elements.gitSshKeyPath.value.trim(),
      healthAlertsEnabled: form.elements.healthAlertsEnabled.checked,
      healthAlertsWebhookUrl: form.elements.healthAlertsWebhookUrl.value.trim(),
      tailscaleManagedServiceId: form.elements.tailscaleManagedServiceId.value.trim(),
      householdTimezone: form.elements.householdTimezone.value.trim(),
    };
    result.textContent = 'Saving...';
    try {
      const saved = await window.HB.postJson('/api/homebase/config', payload);
      result.textContent = `Saved. Host now ${saved.hostname}.${saved.domain}`;
    } catch (error) {
      result.textContent = error.message;
    }
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

  async function triggerHomebaseAction(endpoint, body, resultNode, form = null) {
    if (form?.dataset.submitting === 'true') return;
    if (form) form.dataset.submitting = 'true';
    const buttons = form ? [...form.querySelectorAll('button[type="submit"]')] : [];
    buttons.forEach((button) => { button.disabled = true; });
    resultNode.textContent = 'Submitting...';
    try {
      const payload = await window.HB.postJson(endpoint, body);
      if (payload && payload.jobId) {
        resultNode.innerHTML = `Started job <a href="/jobs/${window.HB.escapeHtml(payload.jobId)}">#${window.HB.escapeHtml(payload.jobId)}</a>. This page will refresh when it finishes.`;
        void waitForJobCompletion(payload.jobId, resultNode, {
          onComplete: () => {
            if (form) form.dataset.submitting = 'false';
            buttons.forEach((button) => { button.disabled = false; });
            load();
          },
        });
        return;
      }
      resultNode.textContent = 'Completed.';
    } catch (error) {
      resultNode.textContent = error.message;
    }
    if (form) form.dataset.submitting = 'false';
    buttons.forEach((button) => { button.disabled = false; });
  }

  function wireEvents() {
    root.addEventListener('submit', async (event) => {
      const configForm = event.target.closest('form[data-action="config"]');
      if (configForm) {
        event.preventDefault();
        submitConfig(configForm);
        return;
      }
      const installSelf = event.target.closest('form[data-action="install-self"]');
      if (installSelf) {
        event.preventDefault();
        const port = Number(installSelf.elements.port.value);
        const dryRun = installSelf.elements.dryRun.checked;
        const payload = { port, dryRun };
        if (!dryRun) payload.confirm = 'EXECUTE';
        triggerHomebaseAction('/api/homebase/install-self', payload, installSelf.querySelector('[data-result]'), installSelf);
        return;
      }
      const bootstrapHost = event.target.closest('form[data-action="bootstrap-host"]');
      if (bootstrapHost) {
        event.preventDefault();
        const dryRun = bootstrapHost.elements.dryRun.checked;
        const payload = { dryRun };
        if (!dryRun) payload.confirm = 'EXECUTE';
        triggerHomebaseAction('/api/bootstrap/execute', payload, bootstrapHost.querySelector('[data-result]'), bootstrapHost);
        return;
      }
      const updateSelf = event.target.closest('form[data-action="update-self"]');
      if (updateSelf) {
        event.preventDefault();
        const ref = updateSelf.elements.ref.value.trim();
        const dryRun = updateSelf.elements.dryRun.checked;
        const payload = { ref, dryRun };
        if (!dryRun) payload.confirm = 'EXECUTE';
        triggerHomebaseAction('/api/homebase/update-self', payload, updateSelf.querySelector('[data-result]'), updateSelf);
        return;
      }
      const testAlerts = event.target.closest('form[data-action="test-alerts"]');
      if (testAlerts) {
        event.preventDefault();
        triggerHomebaseAction('/api/alerts/test', {}, testAlerts.querySelector('[data-result]'), testAlerts);
        return;
      }
      const tailscalePublishExecute = event.target.closest('form[data-action="tailscale-publish-execute"]');
      if (tailscalePublishExecute) {
        event.preventDefault();
        const dryRun = tailscalePublishExecute.elements.dryRun.checked;
        const payload = { dryRun };
        if (!dryRun) payload.confirm = 'EXECUTE';
        triggerHomebaseAction('/api/network/tailscale/publish-execute', payload, tailscalePublishExecute.querySelector('[data-result]'), tailscalePublishExecute);
        return;
      }
      const adminSetup = event.target.closest('form[data-action="admin-setup"]');
      if (adminSetup) {
        event.preventDefault();
        triggerHomebaseAction('/api/admin/setup', {
          passphrase: adminSetup.elements.passphrase.value,
        }, adminSetup.querySelector('[data-result]'), adminSetup);
        return;
      }
      const adminUnlock = event.target.closest('form[data-action="admin-unlock"]');
      if (adminUnlock) {
        event.preventDefault();
        triggerHomebaseAction('/api/admin/unlock', {
          passphrase: adminUnlock.elements.passphrase.value,
        }, adminUnlock.querySelector('[data-result]'), adminUnlock);
        return;
      }
      const adminLock = event.target.closest('form[data-action="admin-lock"]');
      if (adminLock) {
        event.preventDefault();
        triggerHomebaseAction('/api/admin/lock', {}, adminLock.querySelector('[data-result]'), adminLock);
        return;
      }
      const adminRotate = event.target.closest('form[data-action="admin-rotate"]');
      if (adminRotate) {
        event.preventDefault();
        triggerHomebaseAction('/api/admin/rotate', {
          currentPassphrase: adminRotate.elements.currentPassphrase.value,
          newPassphrase: adminRotate.elements.newPassphrase.value,
        }, adminRotate.querySelector('[data-result]'), adminRotate);
      }
    });
  }

  function renderOverviewCard({ title, description, statusLine = '' }) {
    return `
      <section class="hb-card">
        <h1 style="margin:0;">${window.HB.escapeHtml(title)}</h1>
        <p class="hb-muted" style="margin:0.55rem 0 0;">${window.HB.escapeHtml(description)}</p>
        ${statusLine ? `<p class="hb-muted" style="margin:0.55rem 0 0;">${statusLine}</p>` : ''}
      </section>
    `;
  }

  function renderStatusPage(config, status, preflight) {
    return `
      <div class="hb-stack">
        ${renderOverviewCard({
          title: 'Status',
          description: 'Host readiness, Home Base runtime posture, and repair actions.',
          statusLine: `Runtime user: ${status.runtimeUser} · systemd: ${status.systemd?.active || 'unknown'} · execution: ${status.executionMode || 'plan-only'}`,
        })}
        <section class="hb-grid hb-grid-2">
          <article class="hb-card">
            <h2 style="margin-top:0;">Bootstrap / repair host</h2>
            <form class="hb-form-grid" data-action="bootstrap-host">
              <label class="hb-label hb-check-row"><input type="checkbox" name="dryRun" checked ${status.privilegedJobsEnabled ? '' : 'disabled'}> Plan only</label>
              <button class="hb-btn" type="submit">${status.privilegedJobsEnabled ? 'Run bootstrap' : 'Generate bootstrap plan'}</button>
              <p class="hb-muted" style="margin:0;">${status.executionMode === 'executor' ? 'The unprivileged web service delegates approved host mutations to the root-only executor after Admin unlock.' : 'Review the generated plan and execute it from an operator shell.'}</p>
              <p class="hb-muted" data-result style="margin:0;"></p>
            </form>
          </article>
          <article class="hb-card">
            <h2 style="margin-top:0;">Install/enable Home Base service</h2>
            <form class="hb-form-grid" data-action="install-self">
              <label class="hb-label">Port <input class="hb-input" name="port" type="number" min="1" max="65535" value="${window.HB.escapeHtml(config.port)}"></label>
              <label class="hb-label hb-check-row"><input type="checkbox" name="dryRun" checked ${status.privilegedJobsEnabled ? '' : 'disabled'}> Plan only</label>
              <button class="hb-btn" type="submit">${status.privilegedJobsEnabled ? 'Install/repair service' : 'Generate service plan'}</button>
              <p class="hb-muted" style="margin:0;">Installed Home Base binds to loopback. The web service remains unprivileged even when the root-only executor is enabled.</p>
              <p class="hb-muted" data-result style="margin:0;"></p>
            </form>
          </article>
        </section>
        <section class="hb-card">
          <h2 style="margin-top:0;">Runtime details</h2>
          <ul class="hb-stack" style="list-style:none;padding:0;margin:0;">
            <li class="hb-row"><strong>Service</strong><span>${window.HB.escapeHtml(status.serviceName || 'homebase')}</span><span class="hb-muted">${window.HB.escapeHtml(status.systemd?.active || 'unknown')}</span></li>
            <li class="hb-row"><strong>Execution</strong><span class="hb-muted">${window.HB.escapeHtml(status.executionMode || 'plan-only')} · ${window.HB.escapeHtml(status.bindHost || '127.0.0.1')}</span><span>${status.sudoersPolicyStatus === 'legacy-broad' ? '<span class="hb-err">legacy broad sudoers detected</span>' : (status.sudoersPolicyStatus === 'present' ? '<span class="hb-warn">sudoers policy present</span>' : (status.sudoersPolicyStatus === 'unknown' ? '<span class="hb-warn">sudoers status unknown</span>' : '<span class="hb-ok">hardened</span>'))}</span></li>
            <li class="hb-row"><strong>App dir</strong><span class="hb-muted">${window.HB.escapeHtml(status.appDir || '')}</span><span>${status.paths?.appDirExists ? '<span class="hb-ok">present</span>' : '<span class="hb-warn">missing</span>'}</span></li>
            <li class="hb-row"><strong>State dir</strong><span class="hb-muted">${window.HB.escapeHtml(status.stateDir || '')}</span><span>${status.paths?.stateDirExists ? '<span class="hb-ok">present</span>' : '<span class="hb-warn">missing</span>'}</span></li>
            <li class="hb-row"><strong>Env file</strong><span class="hb-muted">${window.HB.escapeHtml(status.envFile || '')}</span><span>${status.paths?.envFileExists ? '<span class="hb-ok">present</span>' : '<span class="hb-warn">missing</span>'}</span></li>
            <li class="hb-row"><strong>systemd unit</strong><span class="hb-muted">/etc/systemd/system/homebase.service</span><span>${status.paths?.serviceFileExists ? '<span class="hb-ok">present</span>' : '<span class="hb-warn">missing</span>'}</span></li>
            <li class="hb-row"><strong>Sovereign fonts</strong><span class="hb-muted">${window.HB.escapeHtml(status.sovereignFonts?.assetDir || 'n/a')} · ${window.HB.escapeHtml(status.sovereignFonts?.mountPath || '/_sovereign/fonts/')}</span><span>${status.sovereignFonts?.available ? '<span class="hb-ok">local ready</span>' : '<span class="hb-warn">missing</span>'}</span></li>
            <li class="hb-row"><strong>Font source mode</strong><span class="hb-muted">${window.HB.escapeHtml(status.sovereignFonts?.configuredSource || 'auto')}</span><span>${status.sovereignFonts?.configuredSource === 'google' ? '<span class="hb-warn">google forced</span>' : '<span class="hb-ok">auto/local</span>'}</span></li>
          </ul>
        </section>
        <section class="hb-card">
          <h2 style="margin-top:0;">Preflight checks</h2>
          ${renderChecks(preflight, { label: 'Preflight checks' })}
        </section>
      </div>
    `;
  }

  function renderAdminPage(adminStatus) {
    return `
      <div class="hb-stack">
        ${renderOverviewCard({
          title: 'Admin',
          description: 'Execution lock posture and destructive-action audit for Home Base.',
          statusLine: `Status: ${adminStatus.configured ? (adminStatus.unlocked ? 'Configured + unlocked' : 'Configured but locked') : 'Not configured'}`,
        })}
        <section class="hb-card">
          <h2 style="margin-top:0;">Admin execution lock</h2>
          <p class="hb-muted" style="margin:0.4rem 0 0.8rem;">
            Status: ${adminStatus.configured ? (adminStatus.unlocked ? '<span class="hb-ok">Configured + unlocked</span>' : '<span class="hb-warn">Configured but locked</span>') : '<span class="hb-warn">Not configured</span>'}
          </p>
          ${adminStatus.unlocked && adminStatus.sessionExpiresAt ? `<p class="hb-muted" style="margin:0 0 0.8rem;">Session expires: ${window.HB.escapeHtml(window.HB.formatTimestamp(adminStatus.sessionExpiresAt))}</p>` : ''}
          ${adminStatus.configured ? `
            <div class="hb-grid hb-grid-2">
              <form class="hb-form-grid" data-action="admin-unlock">
                <label class="hb-label">Passphrase <input class="hb-input" name="passphrase" type="password" autocomplete="current-password"></label>
                <button class="hb-btn" type="submit">Unlock admin</button>
                <p class="hb-muted" data-result style="margin:0;"></p>
              </form>
              <form class="hb-form-grid" data-action="admin-lock">
                <p class="hb-muted" style="margin:0;">Lock the current admin session before leaving shared terminals.</p>
                <button class="hb-btn" type="submit">Lock admin</button>
                <p class="hb-muted" data-result style="margin:0;"></p>
              </form>
            </div>
            <form class="hb-form-grid" data-action="admin-rotate" style="margin-top:0.85rem;">
              <label class="hb-label">Current passphrase <input class="hb-input" name="currentPassphrase" type="password" autocomplete="current-password"></label>
              <label class="hb-label">New passphrase <input class="hb-input" name="newPassphrase" type="password" autocomplete="new-password"></label>
              <button class="hb-btn" type="submit">Rotate admin passphrase</button>
              <p class="hb-muted" data-result style="margin:0;"></p>
            </form>
          ` : `
            <form class="hb-form-grid" data-action="admin-setup">
              <label class="hb-label">Create admin passphrase <input class="hb-input" name="passphrase" type="password" autocomplete="new-password"></label>
              <button class="hb-btn" type="submit">Set admin passphrase</button>
              <p class="hb-muted" data-result style="margin:0;"></p>
            </form>
          `}
        </section>
        <section class="hb-card">
          <h2 style="margin-top:0;">Recent destructive action audit</h2>
          <div data-admin-audit>${adminStatus.unlocked ? '<p class="hb-muted" style="margin:0;">Loading audit history…</p>' : '<p class="hb-muted" style="margin:0;">Unlock admin to view audit history.</p>'}</div>
        </section>
      </div>
    `;
  }

  function renderConfigPage(config, status) {
    return `
      <div class="hb-stack">
        ${renderOverviewCard({
          title: 'Config',
          description: 'Home Base identity, update posture, and alert preferences.',
          statusLine: `Current host: ${config.hostname}.${config.domain} · service ID: ${config.tailscaleManagedServiceId || 'svc:home'} · systemd: ${status.systemd?.active || 'unknown'}`,
        })}
        <section class="hb-card">
          <h2 style="margin-top:0;">Home Base configuration</h2>
          <form class="hb-form-grid" data-action="config">
            <label class="hb-label">Hostname <input class="hb-input" name="hostname" value="${window.HB.escapeHtml(config.hostname)}" required></label>
            <label class="hb-label">Domain <input class="hb-input" name="domain" value="${window.HB.escapeHtml(config.domain)}" required></label>
            <label class="hb-label">
              Git transport
              <select class="hb-select" name="gitTransport">
                <option value="https" ${config.gitTransport === 'https' ? 'selected' : ''}>https</option>
                <option value="ssh" ${config.gitTransport === 'ssh' ? 'selected' : ''}>ssh</option>
                <option value="ssh-key" ${config.gitTransport === 'ssh-key' ? 'selected' : ''}>ssh-key</option>
              </select>
            </label>
            <label class="hb-label">SSH key path (for ssh-key transport)
              <input class="hb-input" name="gitSshKeyPath" value="${window.HB.escapeHtml(config.gitSshKeyPath || '')}">
            </label>
            <label class="hb-label hb-check-row">
              <input type="checkbox" name="healthAlertsEnabled" ${config.healthAlertsEnabled ? 'checked' : ''}>
              Enable critical health alerts
            </label>
            <label class="hb-label">Health alert webhook URL
              <input class="hb-input" name="healthAlertsWebhookUrl" placeholder="https://..." value="${window.HB.escapeHtml(config.healthAlertsWebhookUrl || '')}">
            </label>
            <label class="hb-label">Household timezone
              <select class="hb-select" name="householdTimezone">
                <option value="America/New_York" ${(config.householdTimezone || 'America/New_York') === 'America/New_York' ? 'selected' : ''}>Eastern (America/New_York)</option>
                <option value="America/Chicago" ${config.householdTimezone === 'America/Chicago' ? 'selected' : ''}>Central (America/Chicago)</option>
                <option value="America/Denver" ${config.householdTimezone === 'America/Denver' ? 'selected' : ''}>Mountain (America/Denver)</option>
                <option value="America/Phoenix" ${config.householdTimezone === 'America/Phoenix' ? 'selected' : ''}>Arizona (America/Phoenix)</option>
                <option value="America/Los_Angeles" ${config.householdTimezone === 'America/Los_Angeles' ? 'selected' : ''}>Pacific (America/Los_Angeles)</option>
                <option value="America/Anchorage" ${config.householdTimezone === 'America/Anchorage' ? 'selected' : ''}>Alaska (America/Anchorage)</option>
                <option value="Pacific/Honolulu" ${config.householdTimezone === 'Pacific/Honolulu' ? 'selected' : ''}>Hawaii (Pacific/Honolulu)</option>
              </select>
            </label>
            <label class="hb-label">Managed Tailscale service ID
              <input class="hb-input" name="tailscaleManagedServiceId" placeholder="svc:home" value="${window.HB.escapeHtml(config.tailscaleManagedServiceId || 'svc:home')}">
            </label>
            <button class="hb-btn hb-btn-primary" type="submit">Save config</button>
            <p class="hb-muted" data-config-result style="margin:0;"></p>
          </form>
        </section>
        <section class="hb-grid hb-grid-2">
          <article class="hb-card">
            <h2 style="margin-top:0;">Update Home Base</h2>
            <form class="hb-form-grid" data-action="update-self">
              <label class="hb-label">Git ref <input class="hb-input" name="ref" value="main"></label>
              <label class="hb-label hb-check-row"><input type="checkbox" name="dryRun" checked> Dry-run only</label>
              <button class="hb-btn" type="submit">Run Home Base update</button>
              <p class="hb-muted" data-result style="margin:0;"></p>
            </form>
          </article>
          <article class="hb-card">
            <h2 style="margin-top:0;">Health alerts</h2>
            <form class="hb-form-grid" data-action="test-alerts">
              <p class="hb-muted" style="margin:0;">Send a test notification to confirm your configured alert target works before relying on automated critical alerts.</p>
              <button class="hb-btn" type="submit">Send test alert</button>
              <p class="hb-muted" data-result style="margin:0;"></p>
            </form>
          </article>
        </section>
      </div>
    `;
  }

  function renderPublishPlanSummary(plan) {
    if (!plan) return '<p class="hb-muted" style="margin:0;">Publish plan unavailable.</p>';
    const conflicts = Array.isArray(plan.conflicts) ? plan.conflicts : [];
    const diff = Array.isArray(plan.diff) ? plan.diff : [];
    return `
      <div class="hb-stack">
        <p style="margin:0;"><span class="${plan.canExecute ? 'hb-ok' : 'hb-warn'}">${window.HB.escapeHtml(plan.canExecute ? 'Executable plan' : 'Blocked plan')}</span></p>
        <p class="hb-muted" style="margin:0.35rem 0 0;">${window.HB.escapeHtml(plan.summary || '')}</p>
        <ul class="hb-stack" style="list-style:none;padding:0;margin:0.75rem 0 0;">
          <li class="hb-row"><strong>Changes required</strong><span>${plan.requiresChanges ? '<span class="hb-warn">yes</span>' : '<span class="hb-ok">no</span>'}</span></li>
          <li class="hb-row"><strong>Conflict count</strong><span>${window.HB.escapeHtml(String(conflicts.length))}</span></li>
          <li class="hb-row"><strong>Preview Home Base URL</strong><span class="hb-muted">${window.HB.escapeHtml(plan.previewUrls?.homebase || 'n/a')}</span></li>
          <li class="hb-row"><strong>Preview app base URL</strong><span class="hb-muted">${window.HB.escapeHtml(plan.previewUrls?.appsBase || 'n/a')}</span></li>
        </ul>
        ${diff.length ? `<div class="hb-table-wrap" role="region" aria-label="managed endpoint diff"><table class="hb-table"><thead><tr><th>Endpoint</th><th>Current</th><th>Desired</th><th>Changed</th></tr></thead><tbody>${diff.map((item) => `<tr><td>${window.HB.escapeHtml(item.endpoint)}</td><td>${window.HB.escapeHtml(item.current || 'missing')}</td><td>${window.HB.escapeHtml(item.desired || '')}</td><td>${item.changed ? '<span class="hb-warn">yes</span>' : '<span class="hb-ok">no</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${conflicts.length ? `<div class="hb-table-wrap" role="region" aria-label="endpoint conflicts"><table class="hb-table"><thead><tr><th>Endpoint</th><th>Owner service</th><th>Owner target</th><th>Home target</th></tr></thead><tbody>${conflicts.map((item) => `<tr><td>${window.HB.escapeHtml(item.endpoint)}</td><td>${window.HB.escapeHtml(item.ownerService)}</td><td>${window.HB.escapeHtml(item.ownerTarget)}</td><td>${window.HB.escapeHtml(item.desiredTarget)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </div>
    `;
  }

  function renderVerificationSummary(verification) {
    if (!verification) return '<p class="hb-muted" style="margin:0;">Verification unavailable.</p>';
    const checks = Array.isArray(verification.checks) ? verification.checks : [];
    return `
      <div class="hb-stack">
        <p style="margin:0;"><span class="${verification.repairRequired ? 'hb-warn' : 'hb-ok'}">${window.HB.escapeHtml(verification.repairRequired ? 'Repair recommended' : 'Publishing verified')}</span></p>
        ${verification.staleBecauseConfigChanged ? `<p class="hb-warn" style="margin:0.35rem 0 0;">${window.HB.escapeHtml(verification.staleReason || 'Hostname/domain changed since last publish.')}</p>` : ''}
        <ul class="hb-stack" style="list-style:none;padding:0;margin:0.7rem 0 0;">
          ${checks.map((check) => `<li class="hb-row"><strong>${window.HB.escapeHtml(check.title)}</strong><span>${check.ok ? '<span class="hb-ok">ok</span>' : '<span class="hb-warn">needs attention</span>'}</span></li>`).join('')}
        </ul>
        <div class="hb-form-grid" style="margin-top:0.7rem;">
          <label class="hb-label">Home Base URL
            <input class="hb-input" readonly value="${window.HB.escapeHtml(verification.recommendedUrls?.homebase || '')}">
          </label>
          <label class="hb-label">Apps base URL
            <input class="hb-input" readonly value="${window.HB.escapeHtml(verification.recommendedUrls?.appsBase || '')}">
          </label>
        </div>
      </div>
    `;
  }

  function renderNetworkPage(config, preflight, tailscale = null, publishPlan = null, verification = null) {
    const host = `${config.hostname}.${config.domain}`;
    const readiness = tailscale?.readiness || {};
    const status = tailscale?.status || {};
    const serve = tailscale?.serve || {};
    const managedServiceId = publishPlan?.policy?.managedServiceId || tailscale?.managedServiceId || serve?.managedServiceId || verification?.managedServiceId || 'svc:home';
    const readinessClass = readiness.state === 'published'
      ? 'hb-ok'
      : (readiness.state === 'authenticated-unpublished' ? 'hb-warn' : 'hb-err');

    const serviceRows = Array.isArray(serve.services) ? serve.services : [];
    const serviceList = serviceRows.length
      ? `<ul class="hb-stack" style="list-style:none;padding:0;margin:0;">${serviceRows.map((service) => `<li class="hb-row"><strong>${window.HB.escapeHtml(service.id)}</strong><span class="hb-muted">${window.HB.escapeHtml((service.endpointCount || 0) + ' endpoint(s)')}</span></li>`).join('')}</ul>`
      : '<p class="hb-muted" style="margin:0;">No Tailscale Serve services reported yet.</p>';

    return `
      <div class="hb-stack">
        ${renderOverviewCard({
          title: 'Network',
          description: 'Tailnet reachability and managed Tailscale publishing readiness.',
          statusLine: `Current intended host: ${host}`,
        })}
        <section class="hb-card">
          <h2 style="margin-top:0;">Tailscale readiness</h2>
          ${tailscale?.error ? `<p class="hb-err" style="margin:0;">${window.HB.escapeHtml(tailscale.error)}</p>` : `
            <p style="margin:0;"><span class="${readinessClass}">${window.HB.escapeHtml(readiness.label || 'Unknown')}</span></p>
            <p class="hb-muted" style="margin:0.45rem 0 0;">${window.HB.escapeHtml(readiness.summary || 'Unable to determine readiness state.')}</p>
            <ul class="hb-stack" style="list-style:none;padding:0;margin:0.8rem 0 0;">
              <li class="hb-row"><strong>Installed</strong><span>${tailscale?.installed?.ok ? '<span class="hb-ok">yes</span>' : '<span class="hb-err">no</span>'}</span></li>
              <li class="hb-row"><strong>Backend state</strong><span>${window.HB.escapeHtml(status.backendState || 'unknown')}</span></li>
              <li class="hb-row"><strong>Authenticated</strong><span>${status.authenticated ? '<span class="hb-ok">yes</span>' : '<span class="hb-warn">no</span>'}</span></li>
              <li class="hb-row"><strong>Daemon running</strong><span>${status.daemonRunning ? '<span class="hb-ok">yes</span>' : '<span class="hb-warn">no</span>'}</span></li>
              <li class="hb-row"><strong>Node</strong><span class="hb-muted">${window.HB.escapeHtml(status.nodeName || 'n/a')}</span></li>
              <li class="hb-row"><strong>MagicDNS</strong><span class="hb-muted">${window.HB.escapeHtml(status.dnsName || 'n/a')}</span></li>
              <li class="hb-row"><strong>Tailnet</strong><span class="hb-muted">${window.HB.escapeHtml(status.tailnetName || 'n/a')}</span></li>
              <li class="hb-row"><strong>Serve services</strong><span>${window.HB.escapeHtml(String(serve.serviceCount || 0))}</span></li>
            </ul>
          `}
        </section>
        <section class="hb-card">
          <h2 style="margin-top:0;">Current Serve summary</h2>
          ${serve.error ? `<p class="hb-warn" style="margin:0;">${window.HB.escapeHtml(serve.error)}</p>` : serviceList}
          ${serve.tcp443Owners?.length ? `<p class="hb-muted" style="margin:0.7rem 0 0;">tcp:443 owners: ${window.HB.escapeHtml(serve.tcp443Owners.join(', '))}</p>` : ''}
        </section>
        <section class="hb-card">
          <h2 style="margin-top:0;">Managed publish plan (${window.HB.escapeHtml(managedServiceId)})</h2>
          ${renderPublishPlanSummary(publishPlan)}
          <form class="hb-form-grid" data-action="tailscale-publish-execute" style="margin-top:0.85rem;">
            <label class="hb-label hb-check-row"><input type="checkbox" name="dryRun" checked> Dry-run only</label>
            <button class="hb-btn" type="submit">Apply managed publish plan</button>
            <p class="hb-muted" style="margin:0;">Real execution requires Admin unlock and will refuse endpoint ownership conflicts by policy for ${window.HB.escapeHtml(managedServiceId)}.</p>
            <p class="hb-muted" data-result style="margin:0;"></p>
          </form>
        </section>
        <section class="hb-card">
          <h2 style="margin-top:0;">Verification & repair</h2>
          ${renderVerificationSummary(verification)}
        </section>
        <section class="hb-card">
          <h2 style="margin-top:0;">Publishing prerequisites</h2>
          ${renderChecks(preflight, { ids: ['tailscale', 'nginx', 'nginx-config', 'nginx-gateway', 'nginx-snippets-include'], label: 'Network publishing checks' })}
        </section>
      </div>
    `;
  }

  function renderLegacySettingsPage() {
    return `
      <div class="hb-stack">
        ${renderOverviewCard({
          title: 'Settings moved',
          description: 'Home Base now organizes this control plane into Status, Admin, Config, and Network pages.',
        })}
        <section class="hb-card">
          <p class="hb-muted" style="margin:0;">Use <a href="/config">Config</a> for Home Base settings, <a href="/admin">Admin</a> for execution lock and audit, <a href="/status">Status</a> for host readiness, and <a href="/network">Network</a> for Tailscale-related work.</p>
        </section>
      </div>
    `;
  }

  function renderPage(config, status, preflight, adminStatus, tailscale, publishPlan, verification) {
    if (page === 'status') return renderStatusPage(config, status, preflight);
    if (page === 'admin') return renderAdminPage(adminStatus);
    if (page === 'network') return renderNetworkPage(config, preflight, tailscale, publishPlan, verification);
    if (page === 'settings') return renderLegacySettingsPage();
    return renderConfigPage(config, status);
  }

  async function load() {
    try {
      const [config, status, preflight, adminStatus, tailscale, publishPlan, verification] = await Promise.all([
        window.HB.getJson('/api/homebase/config'),
        window.HB.getJson('/api/homebase/status'),
        window.HB.getJson('/api/preflight'),
        window.HB.getJson('/api/admin/status'),
        page === 'network'
          ? window.HB.getJson('/api/network/tailscale').catch((error) => ({ error: error.message }))
          : Promise.resolve(null),
        page === 'network'
          ? window.HB.getJson('/api/network/tailscale/publish-plan').catch((error) => ({ canExecute: false, summary: error.message, conflicts: [], diff: [] }))
          : Promise.resolve(null),
        page === 'network'
          ? window.HB.getJson('/api/network/tailscale/verify').catch((error) => ({ repairRequired: true, checks: [], staleBecauseConfigChanged: false, staleReason: error.message, recommendedUrls: {} }))
          : Promise.resolve(null),
      ]);
      root.innerHTML = renderPage(config, status, preflight, adminStatus, tailscale, publishPlan, verification);
      wireEvents();
      if (page === 'admin' && adminStatus.unlocked) {
        const auditNode = root.querySelector('[data-admin-audit]');
        window.HB.getJson('/api/admin/audit?limit=10').then((payload) => {
          if (auditNode) auditNode.innerHTML = renderAdminAudit(payload.entries || []);
        }).catch((error) => {
          if (auditNode) auditNode.innerHTML = `<p class="hb-warn" style="margin:0;">${window.HB.escapeHtml(error.message)}</p>`;
        });
      }
    } catch (error) {
      const pageTitle = page === 'config' ? 'Config' : (page ? page.charAt(0).toUpperCase() + page.slice(1) : 'Control plane');
      root.innerHTML = `
        <section class="hb-card">
          <h1 style="margin:0;">${window.HB.escapeHtml(pageTitle)}</h1>
          <p class="hb-muted" style="margin-top:0.5rem;">${window.HB.escapeHtml(error.message)}</p>
        </section>
      `;
    }
  }

  load();
}());
