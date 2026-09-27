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
// The reproduced false positive: the executor include lives in another server block than the legacy route.
const NGINX_SPLIT = '# configuration file /etc/nginx/nginx.conf:\nhttp {\n  server {\n      server_name erebor.forbell.com;\n      include /etc/nginx/snippets/*.conf;\n  }\n  server {\n      listen 8443;\n      include /etc/nginx/sovereign-home.d/*.conf;\n  }\n}\n';
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
  assert.equal(compileAction(action, { adoptAllowed: () => true }).plan.kind, 'app-adopt');
  // Outside a legacy host's move (no root-owned coexistence marker) the executor refuses adopt.
  assert.throws(() => compileAction(action, { adoptAllowed: () => false }), (error) => error.code === 'POLICY_DENIED' && /--add-executor/.test(error.message));
  assert.throws(() => normalizeAction({ action: 'adopt', appId: 'helm', ref: 'main', transport: 'ssh', site: SITE, keepBackups: true }), (error) => error.code === 'INVALID_REQUEST');
});

test('the nginx include check refuses with operator guidance until the host server includes sovereign-home.d', async () => {
  const withInclude = createBaseHandlers({ fsImpl: createFakeFs(), run: nginxRun(NGINX_WITH_INCLUDE) });
  assert.match(await withInclude['nginx.assert-app-include'](base('nginx.assert-app-include', { risk: 'read' })), /includes/);
  const without = createBaseHandlers({ fsImpl: createFakeFs(), run: nginxRun(NGINX_WITHOUT) });
  await assert.rejects(() => without['nginx.assert-app-include'](base('nginx.assert-app-include', { risk: 'read' })), (error) => error.code === 'POLICY_DENIED' && /include \/etc\/nginx\/sovereign-home\.d\/\*\.conf;/.test(error.message));
  const split = createBaseHandlers({ fsImpl: createFakeFs(), run: nginxRun(NGINX_SPLIT) });
  await assert.rejects(() => split['nginx.assert-app-include'](base('nginx.assert-app-include', { risk: 'read' })), (error) => error.code === 'POLICY_DENIED' && /inside every server block/.test(error.message));
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
  const nginxRuns = [];
  const handlers = createBaseHandlers({ fsImpl, run: async (input) => { nginxRuns.push(input.args); return { stdout: '' }; } });
  const result = await handlers['nginx.retire-legacy-snippets'](base('nginx.retire-legacy-snippets', { risk: 'destructive' }), { layout: BUGS });
  assert.match(result, /bug-base\.conf, \/etc\/nginx\/snippets\/bug-base-mcp\.conf/);
  assert.equal(fsImpl.existsSync('/etc/nginx/snippets/bug-base.conf'), false);
  assert.equal(fsImpl.existsSync('/etc/nginx/snippets/sovereign-fonts.conf'), true, 'shared snippets are untouched');
  assert.deepEqual(nginxRuns[0], ['-t'], 'nginx validates the swap straight away');
  const kept = fsImpl.entries.get('/var/lib/homebase-executor/retired-nginx-snippets/bug-base/bug-base-mcp.conf');
  assert.deepEqual([kept.content, kept.mode], ['# mcp\n', 0o600]);
  // Re-running after a partial adopt is a no-op.
  assert.match(await handlers['nginx.retire-legacy-snippets'](base('nginx.retire-legacy-snippets', { risk: 'destructive' }), { layout: BUGS }), /no legacy nginx snippets/);
  const planted = createFakeFs({ '/etc/nginx/snippets/bug-base.conf': { kind: 'link', target: '/etc/shadow' } });
  await assert.rejects(() => createBaseHandlers({ fsImpl: planted, run: async () => ({ stdout: '' }) })['nginx.retire-legacy-snippets'](base('nginx.retire-legacy-snippets', { risk: 'destructive' }), { layout: BUGS }), /not a regular file/);
});

test('a snippet swap nginx rejects is undone: legacy snippet restored, new one removed', async () => {
  const fsImpl = createFakeFs({ '/etc/nginx/snippets/bug-base.conf': '# legacy bug-base\n', '/etc/nginx/sovereign-home.d/bug-base.conf': '# executor bug-base\n' });
  const reject = async () => { throw Object.assign(new Error('exit 1'), { code: 'OPERATION_FAILED', output: { stderr: 'nginx: [emerg] "location" directive is not allowed here' } }); };
  await assert.rejects(() => createBaseHandlers({ fsImpl, run: reject })['nginx.retire-legacy-snippets'](base('nginx.retire-legacy-snippets', { risk: 'destructive' }), { layout: BUGS }), /legacy snippet was restored.*not allowed here.*inside the server block/);
  assert.equal(fsImpl.readFileSync('/etc/nginx/snippets/bug-base.conf'), '# legacy bug-base\n');
  assert.equal(fsImpl.existsSync('/etc/nginx/sovereign-home.d/bug-base.conf'), false);
});

test('a re-run whose nginx check fails for another reason never deletes the only snippet', async () => {
  // The first attempt already retired the legacy snippet; now nginx -t fails because of something else.
  const fsImpl = createFakeFs({ '/etc/nginx/sovereign-home.d/bug-base.conf': '# executor bug-base\n', '/etc/nginx/snippets': { kind: 'dir' } });
  const reject = async () => { throw Object.assign(new Error('exit 1'), { code: 'OPERATION_FAILED', output: { stderr: 'cannot load certificate "/etc/letsencrypt/live/x/fullchain.pem"' } }); };
  await assert.rejects(() => createBaseHandlers({ fsImpl, run: reject })['nginx.retire-legacy-snippets'](base('nginx.retire-legacy-snippets', { risk: 'destructive' }), { layout: BUGS }), /nginx -t failed: cannot load certificate/);
  assert.equal(fsImpl.readFileSync('/etc/nginx/sovereign-home.d/bug-base.conf'), '# executor bug-base\n');
});

test('ownership transfer runs as postgres in the app database, bound to the catalog role', async () => {
  const calls = [];
  const handlers = createBaseHandlers({ fsImpl: createFakeFs(), lookupUser: () => POSTGRES, run: async (input) => { calls.push(input); return { stdout: '', stderr: 'NOTICE:  transferred 9 objects to bitcoin_accountant\n' }; } });
  const result = await handlers['postgres.transfer-ownership'](base('postgres.transfer-ownership', { database: 'bitcoin_accounting', owner: 'bitcoin_accountant' }), { layout: BITCOIN });
  assert.equal(result, 'transferred 9 objects to bitcoin_accountant');
  assert.deepEqual([calls[0].binary, calls[0].args, calls[0].uid], ['/usr/bin/psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', 'bitcoin_accounting'], 999]);
  // Runs as superuser in a database the app owns: search_path is pinned and operators are qualified, so
  // nothing the app planted in public can run (verified against PostgreSQL 14 and 16 with a trap operator).
  assert.match(calls[0].stdin, /^SET search_path = pg_catalog, pg_temp;\n/);
  assert.match(calls[0].stdin, /set_config\('search_path', 'pg_catalog, pg_temp', true\)/);
  assert.match(calls[0].stdin, /c\.relowner OPERATOR\(pg_catalog\.<>\) 'bitcoin_accountant'::pg_catalog\.regrole::pg_catalog\.oid/);
  const body = calls[0].stdin.replace(/^SET search_path = [^\n]*\n/, '').replace(/OPERATOR\(pg_catalog\.(<>|=|!~~|\+)\)/g, '');
  assert.doesNotMatch(body, / (<>|=) /, 'no unqualified comparison operators');
  assert.match(calls[0].stdin, /deptype OPERATOR\(pg_catalog\.=\) ANY \(ARRAY\['a', 'i'\]/, 'column-owned sequences move with their table');
  assert.match(calls[0].stdin, /ALTER ROUTINE %s OWNER TO %I/);
  assert.match(calls[0].stdin, /'DOMAIN' ELSE 'TYPE'/);
  await assert.rejects(() => handlers['postgres.transfer-ownership'](base('postgres.transfer-ownership', { database: 'helm', owner: 'helm' }), { layout: BITCOIN }), (error) => error.code === 'POLICY_DENIED');
});

test('adopt never generates database credentials: no existing wiring means nothing to adopt', async () => {
  const { createRunAction } = require('../executor/run-action');
  const finished = [];
  const journal = { begin() {}, progress() {}, finish: (jobId, outcome) => finished.push(outcome) };
  let executed = false;
  const runAction = createRunAction({ handlers: {}, journal, compile: (spec) => compileAction(spec, { adoptAllowed: () => true }), existingPassword: () => null, execute: async () => { executed = true; return {}; } });
  await assert.rejects(() => runAction({ action: 'adopt', appId: 'helm', ref: 'main', transport: 'ssh', site: SITE }, { emit() {}, jobId: '9', requestId: 'r' }), (error) => error.code === 'POLICY_DENIED' && /nothing to adopt/.test(error.message));
  assert.equal(executed, false);
  assert.equal(finished[0].ok, false);
});

test('the web client sends exactly the fields the executor accepts for every action', () => {
  const { ACTIONS } = require('../executor/actions');
  const source = require('fs').readFileSync(require.resolve('../src/executor/client'), 'utf8');
  const table = source.slice(source.indexOf('const ACTION_FIELD_NAMES = {'), source.indexOf('};', source.indexOf('const ACTION_FIELD_NAMES = {')));
  for (const [name, spec] of Object.entries(ACTIONS)) {
    const match = new RegExp(`\\n  ${name}: \\[([^\\]]*)\\]`).exec(table);
    assert.ok(match, `client has no field list for ${name}`);
    const fields = match[1].split(',').map((field) => field.trim().replace(/'/g, '')).filter(Boolean);
    assert.deepEqual(fields, spec.fields, name);
  }
});

test('the coexistence marker counts only as a root-owned regular file that nobody else can write', () => {
  const { legacyCoexistence, LEGACY_COEXISTENCE_MARKER } = require('../executor/actions');
  const fake = (entry) => ({ lstatSync: () => { if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { isFile: () => entry.file !== false, uid: entry.uid, mode: entry.mode }; } });
  assert.equal(LEGACY_COEXISTENCE_MARKER, '/etc/sovereign-home/legacy-coexistence');
  assert.equal(legacyCoexistence(fake({ uid: 0, mode: 0o100644 })), true);
  assert.equal(legacyCoexistence(fake(null)), false);
  assert.equal(legacyCoexistence(fake({ uid: 997, mode: 0o100644 })), false);
  assert.equal(legacyCoexistence(fake({ uid: 0, mode: 0o100666 })), false);
  assert.equal(legacyCoexistence(fake({ uid: 0, mode: 0o100644, file: false })), false);
});
