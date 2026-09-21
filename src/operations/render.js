function renderOperationPlan(plan) {
  return plan.operations.map((operation, index) => `${index + 1}. [${operation.risk}] ${operation.title}`).join('\n');
}
module.exports = { renderOperationPlan };
