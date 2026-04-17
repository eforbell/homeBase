(function settingsPage() {
  const root = document.getElementById('app');

  function renderChecks(preflight) {
    const checks = Array.isArray(preflight.checks) ? preflight.checks : [];
    if (!checks.length) return '<p class="hb-muted" style="margin:0;">No preflight checks returned.</p>';
    return `
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
    `;
  }

  async function submitConfig(form) {
    const result = form.querySelector('[data-config-result]');
    const payload = {
      hostname: form.elements.hostname.value.trim(),
      domain: form.elements.domain.value.trim(),
      gitTransport: form.elements.gitTransport.value,
      gitSshKeyPath: form.elements.gitSshKeyPath.value.trim(),
    };
    result.textContent = 'Saving...';
    try {
      const saved = await window.HB.postJson('/api/homebase/config', payload);
      result.textContent = `Saved. Host now ${saved.hostname}.${saved.domain}`;
    } catch (error) {
      result.textContent = error.message;
    }
  }

  async function triggerHomebaseAction(endpoint, body, resultNode) {
    resultNode.textContent = 'Submitting...';
    try {
      const payload = await window.HB.postJson(endpoint, body);
      resultNode.innerHTML = `Started job <a href="/jobs/${window.HB.escapeHtml(payload.jobId)}">#${window.HB.escapeHtml(payload.jobId)}</a>.`;
    } catch (error) {
      resultNode.textContent = error.message;
    }
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
        if (!dryRun) {
          const confirm = window.prompt('Type EXECUTE to install/enable the Home Base service for real.');
          if (confirm !== 'EXECUTE') return;
          payload.confirm = 'EXECUTE';
        }
        triggerHomebaseAction('/api/homebase/install-self', payload, installSelf.querySelector('[data-result]'));
        return;
      }
      const bootstrapHost = event.target.closest('form[data-action="bootstrap-host"]');
      if (bootstrapHost) {
        event.preventDefault();
        const dryRun = bootstrapHost.elements.dryRun.checked;
        const payload = { dryRun };
        if (!dryRun) {
          const confirm = window.prompt('Type EXECUTE to re-run host bootstrap for real.');
          if (confirm !== 'EXECUTE') return;
          payload.confirm = 'EXECUTE';
        }
        triggerHomebaseAction('/api/bootstrap/execute', payload, bootstrapHost.querySelector('[data-result]'));
        return;
      }
      const updateSelf = event.target.closest('form[data-action="update-self"]');
      if (updateSelf) {
        event.preventDefault();
        const ref = updateSelf.elements.ref.value.trim();
        const dryRun = updateSelf.elements.dryRun.checked;
        const payload = { ref, dryRun };
        if (!dryRun) {
          const confirm = window.prompt('Type EXECUTE to run update-self for real.');
          if (confirm !== 'EXECUTE') return;
          payload.confirm = 'EXECUTE';
        }
        triggerHomebaseAction('/api/homebase/update-self', payload, updateSelf.querySelector('[data-result]'));
      }
    });
  }

  async function load() {
    try {
      const [config, status, preflight] = await Promise.all([
        window.HB.getJson('/api/homebase/config'),
        window.HB.getJson('/api/homebase/status'),
        window.HB.getJson('/api/preflight'),
      ]);
      root.innerHTML = `
        <div class="hb-stack">
          <section class="hb-card">
            <h1 style="margin:0;">Settings</h1>
            <p class="hb-muted" style="margin-top:0.55rem;">
              Runtime user: ${window.HB.escapeHtml(status.runtimeUser)} · systemd: ${window.HB.escapeHtml(status.systemd?.active || 'unknown')}
            </p>
          </section>
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
              <button class="hb-btn hb-btn-primary" type="submit">Save config</button>
              <p class="hb-muted" data-config-result style="margin:0;"></p>
            </form>
          </section>
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
          <section class="hb-grid hb-grid-2">
            <article class="hb-card">
              <h2 style="margin-top:0;">Update self</h2>
              <form class="hb-form-grid" data-action="update-self">
                <label class="hb-label">Git ref <input class="hb-input" name="ref" value="main"></label>
                <label class="hb-label" style="display:flex;gap:0.45rem;align-items:center;"><input type="checkbox" name="dryRun" checked> Dry-run only</label>
                <button class="hb-btn" type="submit">Run update-self</button>
                <p class="hb-muted" data-result style="margin:0;"></p>
              </form>
            </article>
          </section>
          <section class="hb-card">
            <h2 style="margin-top:0;">Preflight checks</h2>
            ${renderChecks(preflight)}
          </section>
        </div>
      `;
      wireEvents();
    } catch (error) {
      root.innerHTML = `
        <section class="hb-card">
          <h1 style="margin:0;">Settings</h1>
          <p class="hb-muted" style="margin-top:0.5rem;">${window.HB.escapeHtml(error.message)}</p>
        </section>
      `;
    }
  }

  load();
}());
