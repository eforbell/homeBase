// Every state-changing API request must come from Home Base's own pages (bugBase #150). A browser marks a
// request from another site, or another tailnet hostname (D20: one site), in Sec-Fetch-Site; a form can't
// send application/json, and Home Base answers no CORS preflight, so the content type covers browsers
// without fetch metadata. That holds for empty requests too: a no-CORS POST with no body still carries the
// session cookie (lock). Clients outside a browser send no fetch metadata and only need the content type.
// SID-003's sovereignAuth mutation guard replaces this per app.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

function refuseUnsafeRequest(req, method = req.method || 'GET') {
  if (SAFE_METHODS.has(method)) return null;
  const site = req.headers['sec-fetch-site'];
  if (site && !ALLOWED_FETCH_SITES.has(String(site).toLowerCase())) {
    return { statusCode: 403, payload: { error: 'Home Base refuses changes requested from another site or hostname.', code: 'CROSS_ORIGIN' } };
  }
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return { statusCode: 415, payload: { error: 'Home Base accepts changes only as application/json.', code: 'JSON_REQUIRED' } };
  }
  return null;
}

module.exports = { refuseUnsafeRequest };
