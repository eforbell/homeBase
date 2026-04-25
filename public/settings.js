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
                <td>${check.ok ? '<span class="hb-ok">PASS</span>' : (check.severity === 'critical' ? '<span class="hb-err">FAIL</span>' : '<span class="hb-warn">WARN</span>')}</td>
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
          statusLine: `Runtime user: ${status.runtimeUser} · systemd: ${status.systemd?.active || 'unknown'}`,
        })}
        <section class="hb-grid hb-grid-2">
          <article class="hb-card">
            <h2 style="margin-top:0;">Bootstrap / repair host</h2>
            <form class="hb-form-grid" data-action="bootstrap-host">
              <label class="hb-label" style="display:flex;gap:0.45rem;align-items:center;"><input type="checkbox" name="dryRun" checked> Dry-run only</label>
              <button class="hb-btn" type="submit">Run bootstrap</button>
              <p class="hb-muted" style="margin:0;">Use this to recover from failed auto-bootstrap jobs or re-apply host repair steps such as nginx/Tailscale prerequisites.</p>
              <p class="hb-muted" data-result style="margin:0;"></p>
            </form>
          </article>
          <article class="hb-card">
            <h2 style="margin-top:0;">Install/enable Home Base service</h2>
            <form class="hb-form-grid" data-action="install-self">
              <label class="hb-label">Port <input class="hb-input" name="port" type="number" min="1" max="65535" value="${window.HB.escapeHtml(config.port)}"></label>
              <label class="hb-label" style="display:flex;gap:0.45rem;align-items:center;"><input type="checkbox" name="dryRun" checked> Dry-run only</label>
              <button class="hb-btn" type="submit">Install/enable service</button>
              <p class="hb-muted" style="margin:0;">When installed as a systemd service, Home Base can auto-start bootstrap on first service launch.</p>
              <p class="hb-muted" data-result style="margin:0;"></p>
            </form>
          </article>
        </section>
        <section class="hb-card">
          <h2 style="margin-top:0;">Runtime details</h2>
          <ul class="hb-stack" style="list-style:none;padding:0;margin:0;">
            <li class="hb-row"><strong>Service</strong><span>${window.HB.escapeHtml(status.serviceName || 'homebase')}</span><span class="hb-muted">${window.HB.escapeHtml(status.systemd?.active || 'unknown')}</span></li>
            <li class="hb-row"><strong>App dir</strong><span class="hb-muted">${window.HB.escapeHtml(status.appDir || '')}</span><span>${status.paths?.appDirExists ? '<span class="hb-ok">present</span>' : '<span class="hb-warn">missing</span>'}</span></li>
            <li class="hb-row"><strong>State dir</strong><span class="hb-muted">${window.HB.escapeHtml(status.stateDir || '')}</span><span>${status.paths?.stateDirExists ? '<span class="hb-ok">present</span>' : '<span class="hb-warn">missing</span>'}</span></li>
            <li class="hb-row"><strong>Env file</strong><span class="hb-muted">${window.HB.escapeHtml(status.envFile || '')}</span><span>${status.paths?.envFileExists ? '<span class="hb-ok">present</span>' : '<span class="hb-warn">missing</span>'}</span></li>
            <li class="hb-row"><strong>systemd unit</strong><span class="hb-muted">/etc/systemd/system/homebase.service</span><span>${status.paths?.serviceFileExists ? '<span class="hb-ok">present</span>' : '<span class="hb-warn">missing</span>'}</span></li>
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
          statusLine: `Current host: ${config.hostname}.${config.domain} · systemd: ${status.systemd?.active || 'unknown'}`,
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
            <label class="hb-label" style="display:flex;gap:0.45rem;align-items:center;">
              <input type="checkbox" name="healthAlertsEnabled" ${config.healthAlertsEnabled ? 'checked' : ''}>
              Enable critical health alerts
            </label>
            <label class="hb-label">Health alert webhook URL
              <input class="hb-input" name="healthAlertsWebhookUrl" placeholder="https://..." value="${window.HB.escapeHtml(config.healthAlertsWebhookUrl || '')}">
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
              <label class="hb-label" style="display:flex;gap:0.45rem;align-items:center;"><input type="checkbox" name="dryRun" checked> Dry-run only</label>
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

  function renderNetworkPage(config, preflight) {
    const host = `${config.hostname}.${config.domain}`;
    return `
      <div class="hb-stack">
        ${renderOverviewCard({
          title: 'Network',
          description: 'Tailnet reachability and the future home of Tailscale publishing automation.',
          statusLine: `Current intended host: ${host}`,
        })}
        <section class="hb-card">
          <h2 style="margin-top:0;">Tailscale publishing</h2>
          <p class="hb-muted" style="margin:0;">Feature-4 will land here. The goal is to detect Tailscale readiness, preview the managed Serve topology, and repair Home Base-owned publishing without crowding Config.</p>
          <ul class="hb-stack" style="margin:0.8rem 0 0 1rem;padding:0;">
            <li>Show current tailnet identity and Serve status.</li>
            <li>Preview <code>tailscale serve</code> changes before execution.</li>
            <li>Refuse silent overwrite of unrelated Serve config.</li>
          </ul>
        </section>
        <section class="hb-card">
          <h2 style="margin-top:0;">Publishing prerequisites</h2>
          ${renderChecks(preflight, { ids: ['tailscale', 'nginx', 'nginx-config', 'nginx-snippets-include'], label: 'Network publishing checks' })}
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

  function renderPage(config, status, preflight, adminStatus) {
    if (page === 'status') return renderStatusPage(config, status, preflight);
    if (page === 'admin') return renderAdminPage(adminStatus);
    if (page === 'network') return renderNetworkPage(config, preflight);
    if (page === 'settings') return renderLegacySettingsPage();
    return renderConfigPage(config, status);
  }

  async function load() {
    try {
      const [config, status, preflight, adminStatus] = await Promise.all([
        window.HB.getJson('/api/homebase/config'),
        window.HB.getJson('/api/homebase/status'),
        window.HB.getJson('/api/preflight'),
        window.HB.getJson('/api/admin/status'),
      ]);
      root.innerHTML = renderPage(config, status, preflight, adminStatus);
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
