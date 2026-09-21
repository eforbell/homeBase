const { idempotencyKey } = require('../digest');

function operation({ id, type, title, risk = 'write', timeoutMs = 60000, dependsOn = [], preconditions = [], secretRefs = [], ...fields }) {
  const input = { id, type, title, risk, timeoutMs, dependsOn, preconditions, secretRefs, ...fields };
  return { ...input, idempotencyKey: idempotencyKey(input) };
}

function planEnvelope({ kind, target, policyProfile, operations, generatedAt = new Date().toISOString(), catalogRevision = process.env.HOME_BASE_CATALOG_REVISION || 'catalog-v1' }) {
  return { schemaVersion: 1, kind, target, catalogRevision, generatedAt, policyProfile, operations };
}

module.exports = { operation, planEnvelope };
