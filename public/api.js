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

  window.HB = { getJson, postJson, escapeHtml, formatTimestamp, statusBadge };
}());
