const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const schema = require('../../schemas/homebase-operation-plan-v1.schema.json');

class OperationPlanError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = 'OperationPlanError';
    this.code = code;
    this.details = details;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

function validateOperationSchema(plan) {
  if (!validateSchema(plan)) {
    throw new OperationPlanError('INVALID_PLAN', 'Operation plan does not match schema v1.', validateSchema.errors || []);
  }
  const ids = new Set();
  for (const operation of plan.operations) {
    if (ids.has(operation.id)) throw new OperationPlanError('INVALID_PLAN', `Duplicate operation id: ${operation.id}`);
    if (operation.dependsOn.some((id) => !ids.has(id))) {
      throw new OperationPlanError('INVALID_PLAN', `Operation ${operation.id} depends on an unknown or later operation.`);
    }
    ids.add(operation.id);
  }
  return plan;
}

module.exports = { OperationPlanError, validateOperationSchema };
