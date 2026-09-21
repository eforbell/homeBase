const crypto = require('crypto');

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutSecretBindings(value) {
  if (Array.isArray(value)) return value.map(withoutSecretBindings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'secretBindings')
      .map(([key, item]) => [key, withoutSecretBindings(item)]));
  }
  return value;
}

function digestOperationPlan(plan) {
  return `sha256:${crypto.createHash('sha256').update(canonicalize(withoutSecretBindings(plan))).digest('hex')}`;
}

function idempotencyKey(operation) {
  return crypto.createHash('sha256').update(canonicalize(operation)).digest('hex');
}

module.exports = { canonicalize, withoutSecretBindings, digestOperationPlan, idempotencyKey };
