function secretForms(secret) {
  const value = String(secret);
  return [value, encodeURIComponent(value), Buffer.from(value).toString('base64')].filter(Boolean);
}

function redactText(value, secrets = []) {
  let output = String(value);
  for (const secret of secrets.flatMap(secretForms).sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

function redactValue(value, secrets = []) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /secret|password|token/i.test(key) ? '[REDACTED]' : redactValue(item, secrets)]));
  return value;
}

function redactPlan(plan, secretBindings = {}) {
  const safe = redactValue(plan, Object.values(secretBindings));
  return safe;
}

module.exports = { redactText, redactValue, redactPlan };
