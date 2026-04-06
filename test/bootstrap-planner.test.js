const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBootstrapPlan } = require('../src/services/bootstrap-planner');

test('bootstrap plan includes Debian host setup essentials', () => {
  const plan = buildBootstrapPlan({ serviceUser: 'sovereign' });
  assert.equal(plan.kind, 'bootstrap');
  assert.ok(plan.steps.some((step) => step.id === 'install-base-packages'));
  assert.ok(plan.steps.some((step) => step.id === 'install-tailscale'));
  assert.ok(plan.steps.some((step) => step.id === 'configure-nginx-gateway'));
  assert.match(plan.script, /apt-get install -y/);
  assert.match(plan.script, /include \/etc\/nginx\/snippets\/\*\.conf;/);
  assert.match(plan.script, /tailscaled/);
});
