const { ProtocolError } = require('./protocol');
const { redactText } = require('../src/operations/redact');
const { getAppById } = require('../src/catalog');
const { appLayout } = require('../src/operations/app-layout');

const MAX_FAILURE_OUTPUT_CHARS = 8 * 1024;

function getFailureOutput(error, secrets) {
  const captured = error?.output;
  if (!captured || typeof captured !== 'object') return null;
  const text = [captured.stderr, captured.stdout]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n')
    .trim();
  if (!text) return null;
  const redacted = redactText(text, secrets);
  if (redacted.length <= MAX_FAILURE_OUTPUT_CHARS) {
    return { output: redacted, truncated: captured.truncated === true };
  }
  return {
    output: `[truncated; showing final ${MAX_FAILURE_OUTPUT_CHARS} characters]\n${redacted.slice(-MAX_FAILURE_OUTPUT_CHARS)}`,
    truncated: true,
  };
}

// This dispatcher is intentionally injected by the privileged runtime.  It never
// receives unvalidated JSON and it never exposes the secret binding object in events.
async function executePlan(request, { handlers = {}, emit = () => {} } = {}) {
  const completed = new Set();
  // App operations resolve every path, unit, and name from the target's catalog layout.
  const layout = request.plan.kind === 'app-install' ? appLayout(getAppById(request.plan.target)) : null;
  for (const operation of request.plan.operations) {
    if (operation.dependsOn.some((id) => !completed.has(id))) {
      throw new ProtocolError('INVALID_PLAN', `Operation dependencies are incomplete for ${operation.id}.`);
    }
    if (operation.executor === 'homebase') continue;
    const handler = handlers[operation.type];
    if (typeof handler !== 'function') throw new ProtocolError('POLICY_DENIED', `No executor handler is available for ${operation.type}.`);
    emit({ eventType: 'operation.started', operationId: operation.id, title: operation.title });
    try {
      const output = await handler(operation, { secretBindings: request.secretBindings, layout });
      if (output) emit({ eventType: 'operation.output', operationId: operation.id, output: redactText(output, Object.values(request.secretBindings)) });
      completed.add(operation.id);
      emit({ eventType: 'operation.completed', operationId: operation.id });
    } catch (error) {
      const failure = getFailureOutput(error, Object.values(request.secretBindings || {}));
      emit({
        eventType: 'operation.failed',
        operationId: operation.id,
        code: error.code || 'OPERATION_FAILED',
        ...(failure || {}),
      });
      throw error;
    }
  }
  return { completedOperationIds: [...completed] };
}

module.exports = { executePlan, getFailureOutput, MAX_FAILURE_OUTPUT_CHARS };
