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
  assert.match(plan.script, /listen 443 ssl default_server;/);
  assert.match(plan.script, /listen \[::\]:443 ssl default_server;/);
  assert.match(plan.script, /include snippets\/snakeoil\.conf;/);
  assert.match(plan.script, /ssl-cert/);
  assert.match(plan.script, /ufw app info OpenSSH/);
  assert.match(plan.script, /ufw allow 22\/tcp/);
  assert.match(plan.script, /tailscaled/);
});

test('bootstrap plan creates service user home dir, .npm cache dir, and .ssh dir', () => {
  const plan = buildBootstrapPlan({ serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps' });
  const step = plan.steps.find((s) => s.id === 'ensure-service-user');
  assert.ok(step, 'ensure-service-user step present');
  const cmds = step.run.join('\n');
  assert.match(cmds, /--home-dir \/opt\/sovereign-home/);
  assert.match(cmds, /install -d -m 0755 -o sovereign -g sovereign \/opt\/sovereign-home$/m);
  assert.match(cmds, /install -d -m 0755 -o sovereign -g sovereign \/opt\/sovereign-home\/.npm/);
  assert.match(cmds, /install -d -m 0700 -o sovereign -g sovereign \/opt\/sovereign-home\/.ssh/);
});

test('bootstrap plan derives service user home from baseInstallDir', () => {
  const plan = buildBootstrapPlan({ serviceUser: 'sov', baseInstallDir: '/data/apps/apps' });
  const step = plan.steps.find((s) => s.id === 'ensure-service-user');
  const cmds = step.run.join('\n');
  assert.match(cmds, /--home-dir \/data\/apps/);
  assert.match(cmds, /\/data\/apps\/.npm/);
  assert.match(cmds, /\/data\/apps\/.ssh/);
});
