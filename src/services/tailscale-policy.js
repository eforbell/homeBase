const DEFAULT_MANAGED_SERVICE_ID = 'svc:home';

const REQUIRED_MANAGED_ENDPOINTS = Object.freeze({
  'tcp:3080': 'http://127.0.0.1:3080',
  'tcp:443': 'https+insecure://localhost:443',
});

function normalizeManagedServiceId(value) {
  const candidate = String(value || '').trim();
  return candidate || DEFAULT_MANAGED_SERVICE_ID;
}

module.exports = {
  DEFAULT_MANAGED_SERVICE_ID,
  REQUIRED_MANAGED_ENDPOINTS,
  normalizeManagedServiceId,
};
