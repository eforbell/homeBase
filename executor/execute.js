const { ProtocolError } = require('./protocol');
const { redactText } = require('../src/operations/redact');

// This dispatcher is intentionally injected by the privileged runtime.  It never
// receives unvalidated JSON and it never exposes the secret binding object in events.
async function executePlan(request, { handlers = {}, emit = () => {} } = {}) {
  const completed = new Set();
  for (const operation of request.plan.operations) {
    if (operation.dependsOn.some((id) => !completed.has(id))) {
      throw new ProtocolError('INVALID_PLAN', `Operation dependencies are incomplete for ${operation.id}.`);
    }
    if (operation.executor === 'homebase') continue;
    const handler = handlers[operation.type];
    if (typeof handler !== 'function') throw new ProtocolError('POLICY_DENIED', `No executor handler is available for ${operation.type}.`);
    emit({ eventType: 'operation.started', operationId: operation.id, title: operation.title });
    try {
      const output = await handler(operation, { secretBindings: request.secretBindings });
      if (output) emit({ eventType: 'operation.output', operationId: operation.id, output: redactText(output, Object.values(request.secretBindings)) });
      completed.add(operation.id);
      emit({ eventType: 'operation.completed', operationId: operation.id });
    } catch (error) {
      emit({ eventType: 'operation.failed', operationId: operation.id, code: error.code || 'OPERATION_FAILED' });
      throw error;
    }
  }
  return { completedOperationIds: [...completed] };
}

module.exports = { executePlan };
