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

  window.HB = {
    getJson,
    postJson,
    escapeHtml,
    formatTimestamp,
    statusBadge,
    latestBackup,
    backupSummary,
    localOnlyBackupNote,
  };
}());
