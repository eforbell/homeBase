(function homeBaseApi() {
  function checkResponse(response, payload) {
    if (!response.ok) {
      const message = payload && payload.error ? payload.error : `Request failed (${response.status})`;
      throw new Error(message);
    }
    return payload;
  }

  async function parseJson(response) {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  async function getJson(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    const payload = await parseJson(response);
    return checkResponse(response, payload);
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    const payload = await parseJson(response);
    return checkResponse(response, payload);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatTimestamp(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString();
  }

  function statusBadge(status) {
    const safe = escapeHtml(status || 'unknown');
    return `<span class="hb-badge">${safe}</span>`;
  }

  function latestBackup(backups) {
    const items = Array.isArray(backups) ? backups : [];
    return items.find((item) => item.status === 'completed') || items[0] || null;
  }

  function backupSummary(backups) {
    const latest = latestBackup(backups);
    if (!latest) {
      return '<span class="hb-warn">No backups yet</span>';
    }
    const status = latest.status ? ` · ${escapeHtml(latest.status)}` : '';
    return `Last backup: ${escapeHtml(formatTimestamp(latest.generatedAt))}${status}`;
  }

  function localOnlyBackupNote(config) {
    const backupRoot = config?.baseBackupDir || '/var/lib/sovereign-home/backups';
    return `Local-only backup path: ${escapeHtml(backupRoot)}. This protects app mistakes, not VM/disk loss.`;
  }

  function confirmInline(resultNode, message) {
    return new Promise((resolve, reject) => {
      resultNode.innerHTML = `
        <span class="hb-warn" style="display:block;margin-bottom:0.4rem;">${escapeHtml(message)}</span>
        <span style="display:flex;gap:0.4rem;flex-wrap:wrap;">
          <button class="hb-btn" type="button" data-ic="confirm">Confirm</button>
          <button class="hb-btn" type="button" data-ic="cancel">Cancel</button>
        </span>
      `;
      function onClick(e) {
        const btn = e.target.closest('[data-ic]');
        if (!btn) return;
        resultNode.removeEventListener('click', onClick);
        if (btn.dataset.ic === 'confirm') {
          resultNode.textContent = '';
          resolve();
        } else {
          resultNode.textContent = 'Cancelled.';
          reject(new Error('cancelled'));
        }
      }
      resultNode.addEventListener('click', onClick);
    });
  }

  window.HB = {
    getJson,
    postJson,
    escapeHtml,
    formatTimestamp,
    statusBadge,
    latestBackup,
    backupSummary,
    localOnlyBackupNote,
    confirmInline,
  };
}());
