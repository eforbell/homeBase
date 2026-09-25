const test = require('node:test');
const assert = require('node:assert/strict');
const { createBaseHandlers } = require('../executor/handlers');
const { createFakeFs } = require('./fixtures/fake-fs');
const { appLayout } = require('../src/operations/app-layout');
const { getAppById } = require('../src/catalog');
const { buildAppAdoptPlan, buildAppInstallPlan } = require('../src/operations/compilers/install');
const { validateOperationPolicy } = require('../src/operations/policy');
const { normalizeAction, compileAction } = require('../executor/actions');

// Adopt takes over an app legacy-sudo mode installed, in place, on a host whose own nginx server
// block serves app snippets (erebor's erebor.forbell.com site, numenor's nginx.conf).

const BUGS = appLayout(getAppById('bug-base'));
const BITCOIN = appLayout(getAppById('bitcoin-accounting'));
const SITE = { hostname: 'home', domain: 'example.ts.net', householdTimezone: 'America/New_York' };
const POSTGRES = { uid: 999, gid: 999 };

function base(type, fields = {}) {
  return { id: 'test-op', type, title: 'test', risk: 'write', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], ...fields };
}
const NGINX_WITH_INCLUDE = '# configuration file /etc/nginx/nginx.conf:\nhttp {\n  server {\n      include /etc/nginx/snippets/*.conf;\n      include /etc/nginx/sovereign-home.d/*.conf;\n  }\n}\n';
const NGINX_WITHOUT = '# configuration file /etc/nginx/nginx.conf:\nhttp {\n  server {\n      include /etc/nginx/snippets/*.conf;\n      # include /etc/nginx/sovereign-home.d/*.conf;\n  }\n}\n';
const nginxRun = (config, calls = []) => async (input) => { calls.push(input); return { stdout: input.binary === '/usr/sbin/nginx' ? config : '', stderr: '' }; };

test('adopt compiles from the install plan: checks nginx and backs up first, never installs a gateway', () => {
  const plan = buildAppAdoptPlan({ appId: 'bitcoin-accounting', site: SITE, generatedAt: '2026-09-26T12:00:00.000Z' });
  validateOperationPolicy(plan);
  const ids = plan.operations.map((operation) => operation.id);
  assert.deepEqual(ids.slice(0, 2), ['check-nginx-include', 'safety-backup']);
  assert.equal(plan.operations[1].archiveName, '20260926T120000Z');
  assert.equal(ids.includes('ensure-gateway'), false);
  assert.ok(ids.indexOf('ensure-database') < ids.indexOf('transfer-ownership'));
  assert.equal(ids.indexOf('retire-legacy-snippets'), ids.indexOf('write-nginx') + 1);
  assert.equal(ids.at(-1), 'wait-ready');
  assert.equal(plan.policyProfile, 'app-adopt-v1');
});

test('adopt-only operations are refused in install plans, and an install cannot be relabelled as an adopt', () => {
  const install = JSON.parse(JSON.stringify(buildAppInstallPlan({ appId: 'bitcoin-accounting', site: SITE })));
  const { operation } = require('../src/operations/compilers/common');
  install.operations.push(operation({ id: 'sneak', type: 'nginx.retire-legacy-snippets', title: 'Retire', risk: 'destructive', dependsOn: [install.operations.at(-1).id] }));
  assert.throws(() => validateOperationPolicy(install), (error) => error.code === 'POLICY_DENIED');
  const relabelled = { ...JSON.parse(JSON.stringify(buildAppAdoptPlan({ appId: 'bitcoin-accounting', site: SITE }))), kind: 'app-install' };
  assert.throws(() => validateOperationPolicy(relabelled), (error) => error.code === 'POLICY_DENIED');
  const transfer = JSON.parse(JSON.stringify(buildAppAdoptPlan({ appId: 'bitcoin-accounting', site: SITE })));
  transfer.operations.find((operation) => operation.type === 'postgres.transfer-ownership').owner = 'postgres';
  assert.throws(() => validateOperationPolicy(transfer), (error) => error.code === 'POLICY_DENIED');
});

test('adopt is a named action with the same fields as install', () => {
  const action = normalizeAction({ action: 'adopt', appId: 'helm', ref: 'main', transport: 'ssh', site: SITE });
  assert.deepEqual(action, { action: 'adopt', appId: 'helm', ref: 'main', transport: 'ssh', site: SITE });
  assert.equal(compileAction(action).plan.kind, 'app-adopt');
  assert.throws(() => normalizeAction({ action: 'adopt', appId: 'helm', ref: 'main', transport: 'ssh', site: SITE, keepBackups: true }), (error) => error.code === 'INVALID_REQUEST');
});

test('the nginx include check refuses with operator guidance until the host server includes sovereign-home.d', async () => {
  const withInclude = createBaseHandlers({ fsImpl: createFakeFs(), run: nginxRun(NGINX_WITH_INCLUDE) });
  assert.match(await withInclude['nginx.assert-app-include'](base('nginx.assert-app-include', { risk: 'read' })), /includes/);
  const without = createBaseHandlers({ fsImpl: createFakeFs(), run: nginxRun(NGINX_WITHOUT) });
  await assert.rejects(() => without['nginx.assert-app-include'](base('nginx.assert-app-include', { risk: 'read' })), (error) => error.code === 'POLICY_DENIED' && /include \/etc\/nginx\/sovereign-home\.d\/\*\.conf;/.test(error.message));
});

test('an operator gateway that includes the app snippets is left alone; otherwise the managed one is installed', async () => {
  const calls = [];
  const operatorHost = createFakeFs({ '/etc/nginx/sites-available': { kind: 'dir' }, '/etc/nginx/sites-enabled': { kind: 'dir' } });
  const result = await createBaseHandlers({ fsImpl: operatorHost, run: nginxRun(NGINX_WITH_INCLUDE, calls) })['nginx.ensure-gateway'](base('nginx.ensure-gateway'));
  assert.match(result, /managed gateway not installed/);
  assert.equal(operatorHost.existsSync('/etc/nginx/sites-available/sovereign-home'), false);
  assert.deepEqual(calls[0].args, ['-T']);

  const fresh = createFakeFs({ '/etc/nginx/sites-available': { kind: 'dir' }, '/etc/nginx/sites-enabled': { kind: 'dir' } });
  await createBaseHandlers({ fsImpl: fresh, run: nginxRun(NGINX_WITHOUT) })['nginx.ensure-gateway'](base('nginx.ensure-gateway'));
  assert.equal(fresh.existsSync('/etc/nginx/sites-available/sovereign-home'), true);
});

test('retiring legacy snippets keeps root-only copies and covers nginx-published sidecars', async () => {
  const fsImpl = createFakeFs({ '/etc/nginx/snippets/bug-base.conf': '# bug-base\n', '/etc/nginx/snippets/bug-base-mcp.conf': '# mcp\n', '/etc/nginx/snippets/sovereign-fonts.conf': '# fonts\n' });
  const handlers = createBaseHandlers({ fsImpl });
  const result = await handlers['nginx.retire-legacy-snippets'](base('nginx.retire-legacy-snippets', { risk: 'destructive' }), { layout: BUGS });
  assert.match(result, /bug-base\.conf, \/etc\/nginx\/snippets\/bug-base-mcp\.conf/);
  assert.equal(fsImpl.existsSync('/etc/nginx/snippets/bug-base.conf'), false);
  assert.equal(fsImpl.existsSync('/etc/nginx/snippets/sovereign-fonts.conf'), true, 'shared snippets are untouched');
  const kept = fsImpl.entries.get('/var/lib/homebase-executor/retired-nginx-snippets/bug-base/bug-base-mcp.conf');
  assert.deepEqual([kept.content, kept.mode], ['# mcp\n', 0o600]);
  // Re-running after a partial adopt is a no-op.
  assert.match(await handlers['nginx.retire-legacy-snippets'](base('nginx.retire-legacy-snippets', { risk: 'destructive' }), { layout: BUGS }), /no legacy nginx snippets/);
  const planted = createFakeFs({ '/etc/nginx/snippets/bug-base.conf': { kind: 'link', target: '/etc/shadow' } });
  await assert.rejects(() => createBaseHandlers({ fsImpl: planted })['nginx.retire-legacy-snippets'](base('nginx.retire-legacy-snippets', { risk: 'destructive' }), { layout: BUGS }), /not a regular file/);
});

test('ownership transfer runs as postgres in the app database, bound to the catalog role', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ fsImpl: createFakeFs(), lookupUser: () => POSTGRES, run: async (input) => { calls.push(input); return { stdout: '', stderr: 'NOTICE:  transferred 9 objects to bitcoin_accountant\n' }; } });
  const result = await handlers['postgres.transfer-ownership'](base('postgres.transfer-ownership', { database: 'bitcoin_accounting', owner: 'bitcoin_accountant' }), { layout: BITCOIN });
  assert.equal(result, 'transferred 9 objects to bitcoin_accountant');
  assert.deepEqual([calls[0].binary, calls[0].args, calls[0].uid], ['/usr/bin/psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', 'bitcoin_accounting'], 999]);
  assert.match(calls[0].stdin, /OWNER TO %I', CASE/);
  assert.match(calls[0].stdin, /relowner <> 'bitcoin_accountant'::regrole/);
  assert.match(calls[0].stdin, /deptype IN \('a', 'i'\)/, 'column-owned sequences move with their table');
  await assert.rejects(() => handlers['postgres.transfer-ownership'](base('postgres.transfer-ownership', { database: 'helm', owner: 'helm' }), { layout: BITCOIN }), (error) => error.code === 'POLICY_DENIED');
});

test('adopt never generates database credentials: no existing wiring means nothing to adopt', async () => {
  const { createRunAction } = require('../executor/run-action');
  const finished = [];
  const journal = { begin() {}, progress() {}, finish: (jobId, outcome) => finished.push(outcome) };
  let executed = false;
  const runAction = createRunAction({ handlers: {}, journal, existingPassword: () => null, execute: async () => { executed = true; return {}; } });
  await assert.rejects(() => runAction({ action: 'adopt', appId: 'helm', ref: 'main', transport: 'ssh', site: SITE }, { emit() {}, jobId: '9', requestId: 'r' }), (error) => error.code === 'POLICY_DENIED' && /install it instead of adopting/.test(error.message));
  assert.equal(executed, false);
  assert.equal(finished[0].ok, false);
});
