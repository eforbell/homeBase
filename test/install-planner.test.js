const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInstallPlan } = require('../src/services/install-planner');

test('install planner allocates a free port when the preferred port is already used', () => {
  const plan = buildInstallPlan({
    appId: 'family-help',
    state: {
      installations: {
        dinner: { port: 3000 },
        plan: { port: 3001 },
        help: { port: 3002 },
        pulse: { port: 3003 },
      },
    },
    options: {},
    config: { port: 3080, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', defaultHostname: 'homebase', defaultDomain: 'tailnet' },
  });

  assert.equal(plan.install.port, 3004);
});

test('bitcoin accounting plan renders postgres-oriented env and readiness probes', () => {
  const plan = buildInstallPlan({
    appId: 'bitcoin-accounting',
    state: { installations: {} },
    options: { dbPassword: 'secret-pass' },
    config: { port: 3080, serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps', defaultHostname: 'homebase', defaultDomain: 'tailnet' },
  });

  assert.match(plan.files['.env'], /DB_BACKEND=postgres/);
  assert.match(plan.files['.env'], /BITCOIN_ACCOUNTING_WEB_BASE_PATH=\/bitcoin-accounting/);
  assert.match(plan.script, /bitcoin-accounting-web-init/);
  assert.equal(plan.install.health.readinessPath, '/api/ready');
});

test('install planner prefers SSH repository URLs by default', () => {
  const plan = buildInstallPlan({
    appId: 'family-help',
    state: { installations: {} },
    options: {},
    config: {
      port: 3080,
      serviceUser: 'sovereign',
      baseInstallDir: '/opt/sovereign-home/apps',
      defaultHostname: 'homebase',
      defaultDomain: 'tailnet',
      gitTransport: 'ssh',
    },
  });

  assert.equal(plan.app.repoUrl, 'git@github.com:eforbell/familyHelp.git');
  assert.match(plan.script, /git clone git@github.com:eforbell\/familyHelp.git/);
  assert.match(plan.script, /Timed out waiting for http:\/\/127.0.0.1:3002/);
});
