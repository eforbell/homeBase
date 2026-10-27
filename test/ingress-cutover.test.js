const test = require('node:test');
const assert = require('node:assert/strict');
const { createBaseHandlers, NGINX_GATEWAY_CONTENT, INGRESS_STATE_PATH } = require('../executor/handlers');
const { createFakeFs } = require('./fixtures/fake-fs');
const { buildIngressCutoverPlan, buildIngressRollbackPlan } = require('../src/operations/compilers/ingress');
const { buildAppInstallPlan } = require('../src/operations/compilers/install');
const { validateOperationPolicy } = require('../src/operations/policy');

const SITE = '/etc/nginx/sites-available/sovereign-home';
const DOMAIN = 'example-tailnet.ts.net';
const FRESH_NGINX = '# configuration file /etc/nginx/nginx.conf:\nhttp {\n  include /etc/nginx/sites-enabled/*;\n}\n';
const OPERATOR_NGINX = `${FRESH_NGINX}# configuration file /etc/nginx/sites-enabled/mine:\nserver {\n  listen 443 ssl;\n  include /etc/nginx/sovereign-home.d/*.conf;\n}\n`;

function base(type, fields = {}) {
  return { id: 'op', type, title: 't', risk: 'write', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], ...fields };
}

// systemd-tmpfiles creates the socket directory the way the tmpfiles.d entry says; nginx -T prints `dump`.
function harness(files = {}, { dump = FRESH_NGINX, socketDirMode = 0o700 } = {}) {
  // Present on every host: the executor's state directory (its job journal lives there) and tmpfiles.d.
  const fsImpl = createFakeFs({ '/var/lib/homebase-executor': { kind: 'dir', mode: 0o700 }, '/etc/tmpfiles.d': { kind: 'dir' }, '/etc/nginx/sites-enabled': { kind: 'dir' }, '/etc/nginx/sites-available': { kind: 'dir' }, ...files });
  const calls = [];
  const run = async (input) => {
    calls.push(input);
    if (input.binary === '/usr/bin/systemd-tmpfiles' && !fsImpl.existsSync('/run/sovereign-serve')) fsImpl.mkdirSync('/run/sovereign-serve', { mode: socketDirMode });
    if (input.binary === '/usr/sbin/nginx') return { stdout: dump, stderr: '' };
    return { stdout: '' };
  };
  return { fsImpl, calls, handlers: createBaseHandlers({ fsImpl, run }) };
}

const cutover = (fields = {}) => base('nginx.ensure-socket-gateway', { instance: 'smith', domain: DOMAIN, ...fields });

test('cutover records the host as socket ingress and installs tmpfiles, identity snippet, and socket gateway', async () => {
  const { fsImpl, calls, handlers } = harness({ '/etc/nginx/sites-enabled/default': { kind: 'link', target: '/etc/nginx/sites-available/default' } });
  assert.match(await handlers['nginx.ensure-socket-gateway'](cutover()), /for smith on example-tailnet\.ts\.net/);
  assert.deepEqual(JSON.parse(fsImpl.readFileSync(INGRESS_STATE_PATH)), { mode: 'sockets', instance: 'smith', domain: DOMAIN });
  assert.match(fsImpl.readFileSync('/etc/tmpfiles.d/sovereign-serve.conf'), /^d \/run\/sovereign-serve 0700 root root -$/m);
  assert.match(fsImpl.readFileSync('/etc/tmpfiles.d/sovereign-serve.conf'), /^d \/run\/homebase-identity 0750 homebase www-data -$/m);
  assert.doesNotMatch(fsImpl.readFileSync('/etc/tmpfiles.d/sovereign-serve.conf'), /\/run\/homebase[ /]/, "the executor's own /run/homebase stays root-owned");
  assert.deepEqual(calls.find((call) => call.binary === '/usr/bin/systemd-tmpfiles').args, ['--create', '/etc/tmpfiles.d/sovereign-serve.conf']);
  assert.match(fsImpl.readFileSync('/etc/nginx/sovereign-identity.conf'), /^auth_request \/_sovereign\/identity;$/m);
  const site = fsImpl.readFileSync(SITE);
  assert.match(site, /^# sovereign-ingress: sockets$/m);
  assert.match(site, /listen unix:\/run\/sovereign-serve\/home\.sock;/);
  assert.doesNotMatch(site, /listen \d|listen \[::\]/);
  assert.equal(fsImpl.readlinkSync('/etc/nginx/sites-enabled/sovereign-home'), SITE);
  assert.equal(fsImpl.existsSync('/etc/nginx/sites-enabled/default'), false);
});

test('after cutover, an install or repair refreshes the socket gateway and never restores TCP', async () => {
  const { fsImpl, handlers } = harness();
  await handlers['nginx.ensure-socket-gateway'](cutover());
  fsImpl.writeFileSync(SITE, `${fsImpl.readFileSync(SITE)}# stale\n`);
  assert.match(await handlers['nginx.ensure-gateway'](base('nginx.ensure-gateway')), /refreshed the per-service socket gateway/);
  assert.doesNotMatch(fsImpl.readFileSync(SITE), /# stale|listen 443/);
  // The record is gone but the site is still the socket gateway: refuse rather than write TCP over it.
  fsImpl.unlinkSync(INGRESS_STATE_PATH);
  await assert.rejects(() => handlers['nginx.ensure-gateway'](base('nginx.ensure-gateway')), /is a socket gateway but .* is missing/);
  assert.match(fsImpl.readFileSync(SITE), /^# sovereign-ingress: sockets/);
});

test('an unreadable cutover record is refused, never read as "not cut over"', async () => {
  for (const content of ['not json', '{"mode":"tcp"}', '{"mode":"sockets","instance":"Bad","domain":"example-tailnet.ts.net"}']) {
    const { handlers } = harness({ [INGRESS_STATE_PATH]: content });
    await assert.rejects(() => handlers['nginx.ensure-gateway'](base('nginx.ensure-gateway')), /is unreadable/, content);
  }
});

test('cutover refuses an operator server block that would keep serving apps over TCP', async () => {
  const { fsImpl, handlers } = harness({}, { dump: OPERATOR_NGINX });
  await assert.rejects(() => handlers['nginx.ensure-socket-gateway'](cutover()), /outside the managed gateway includes \/etc\/nginx\/sovereign-home\.d/);
  assert.equal(fsImpl.existsSync(INGRESS_STATE_PATH), false);
  assert.equal(fsImpl.existsSync(SITE), false);
});

test('cutover refuses a socket directory that is not root-only, a renamed instance, and malformed values', async () => {
  const loose = harness({}, { socketDirMode: 0o755 });
  await assert.rejects(() => loose.handlers['nginx.ensure-socket-gateway'](cutover()), /must be a root-owned 0700 directory/);
  const { handlers } = harness();
  await handlers['nginx.ensure-socket-gateway'](cutover());
  await assert.rejects(() => handlers['nginx.ensure-socket-gateway'](cutover({ instance: 'jones' })), /already cut over as smith/);
  await assert.rejects(() => handlers['nginx.ensure-socket-gateway'](cutover({ domain: 'other.ts.net' })), /already cut over/);
  await assert.rejects(() => harness().handlers['nginx.ensure-socket-gateway'](cutover({ domain: 'example.com' })), /malformed/);
});

test('rollback restores the TCP gateway and forgets the cutover', async () => {
  const { fsImpl, handlers } = harness();
  await handlers['nginx.ensure-socket-gateway'](cutover());
  await handlers['nginx.restore-tcp-gateway'](base('nginx.restore-tcp-gateway', { risk: 'destructive' }));
  assert.equal(fsImpl.readFileSync(SITE), NGINX_GATEWAY_CONTENT);
  assert.equal(fsImpl.existsSync(INGRESS_STATE_PATH), false);
});

test('planner: cutover and rollback plans pass policy; rollback waits for every app to leave tailnet mode', () => {
  const plan = buildIngressCutoverPlan({ instance: 'smith', domain: 'Example-Tailnet.ts.net' });
  assert.equal(validateOperationPolicy(plan), plan);
  assert.equal(plan.operations[0].domain, DOMAIN, 'the domain is lowercased');
  assert.throws(() => buildIngressCutoverPlan({ instance: 'smith', domain: 'example.com' }), /<tailnet>\.ts\.net/);
  assert.throws(() => buildIngressCutoverPlan({ instance: 'Smith--x', domain: DOMAIN }), /instance must be/);
  const rollback = buildIngressRollbackPlan({ installations: { 'family-dinner': { identityMode: 'local' } } });
  assert.equal(validateOperationPolicy(rollback), rollback);
  assert.throws(() => buildIngressRollbackPlan({ installations: { 'family-pulse': { identityMode: 'tailnet' }, helm: { identityMode: 'tailnet' }, 'family-dinner': {} } }),
    /while family-pulse, helm are in tailnet mode: return them to local mode first/);
});

test('policy: ingress operations stay in their own profiles, and rollback must declare itself destructive', () => {
  const install = buildAppInstallPlan({ appId: 'family-dinner' });
  const smuggled = { ...install, operations: [...install.operations, buildIngressRollbackPlan({}).operations[0]] };
  assert.throws(() => validateOperationPolicy(smuggled), /not allowed by app-install-v1/);
  const rollback = buildIngressRollbackPlan({});
  const quiet = { ...rollback, operations: [{ ...rollback.operations[0], risk: 'write' }, rollback.operations[1]] };
  assert.throws(() => validateOperationPolicy(quiet), /must declare risk "destructive"/);
  const cutover = buildIngressCutoverPlan({ instance: 'smith', domain: DOMAIN });
  assert.throws(() => validateOperationPolicy({ ...cutover, target: 'family-dinner' }), /target does not match/);
});

test('app snippets follow the ingress mode: TCP before cutover, identity after, TCP again after rollback', async () => {
  const D = '/etc/nginx/sovereign-home.d';
  const { fsImpl, handlers } = harness({
    [D]: { kind: 'dir' },
    // Installed before SID-001 (old name) and after it (new name), both rendered for the TCP gateway.
    [`${D}/family-dinner.conf`]: '# family-dinner (old name)\nlocation /dinner/ { proxy_pass http://127.0.0.1:3000/; }\n',
    '/opt/sovereign-home/apps/familyDinner': { kind: 'dir' },
  });
  const write = (layoutApp) => handlers['filesystem.write-managed-file'](base('filesystem.write-managed-file', { purpose: 'nginx-snippet', template: 'app-nginx-v1' }), { layout: require('../src/operations/app-layout').appLayout(require('../src/catalog').getAppById(layoutApp)) });
  await write('home-source');
  assert.doesNotMatch(fsImpl.readFileSync(`${D}/source--home-source.conf`), /sovereign-identity/, 'a pre-cutover install must not call a lookup the TCP gateway lacks');
  await handlers['nginx.ensure-socket-gateway'](cutover());
  assert.equal(fsImpl.existsSync(`${D}/family-dinner.conf`), false);
  for (const file of ['home--family-dinner.conf', 'source--home-source.conf']) assert.match(fsImpl.readFileSync(`${D}/${file}`), /include \/etc\/nginx\/sovereign-identity\.conf;/, file);
  await write('home-source');
  assert.match(fsImpl.readFileSync(`${D}/source--home-source.conf`), /sovereign-identity/, 'installs after cutover render for sockets');
  await handlers['nginx.restore-tcp-gateway'](base('nginx.restore-tcp-gateway', { risk: 'destructive' }));
  for (const file of ['home--family-dinner.conf', 'source--home-source.conf']) assert.doesNotMatch(fsImpl.readFileSync(`${D}/${file}`), /sovereign-identity/, file);
});

test('rollback refuses while any app reads identity from headers, by its own .env', async () => {
  const fsImpl = createFakeFs({ '/opt/sovereign-home/apps/familyPulse/.env': 'SOVEREIGN_IDENTITY_MODE=tailnet\n', '/opt/sovereign-home/apps/familyDinner/.env': 'SOVEREIGN_IDENTITY_MODE=local\n' });
  const reads = [];
  const handlers = createBaseHandlers({ fsImpl, run: async () => ({ stdout: '' }), lookupUser: () => ({ uid: 1001, gid: 1002 }), asUser: (user, fn) => { reads.push(user.uid); return fn(); } });
  await assert.rejects(() => handlers['nginx.restore-tcp-gateway'](base('nginx.restore-tcp-gateway', { risk: 'destructive' })), /family-pulse still trusts identity headers \(SOVEREIGN_IDENTITY_MODE=tailnet\)/);
  assert.ok(reads.length > 0 && reads.every((uid) => uid === 1001), 'app files are read as sovereign, never as root');
});

test('rollback reads the identity mode the way dotenv loaders do, and fails closed', async () => {
  const { trustsIdentityHeaders } = require('../executor/handlers');
  for (const content of ['SOVEREIGN_IDENTITY_MODE=tailnet # pilot', 'export SOVEREIGN_IDENTITY_MODE=tailnet', 'SOVEREIGN_IDENTITY_MODE = "tailnet"', "  SOVEREIGN_IDENTITY_MODE='Tailnet'", 'SOVEREIGN_IDENTITY_MODE=tailnet\r', 'SOVEREIGN_IDENTITY_MODE=headers', 'SOVEREIGN_IDENTITY_MODE=local\nSOVEREIGN_IDENTITY_MODE=tailnet']) {
    assert.equal(trustsIdentityHeaders(content), true, JSON.stringify(content));
  }
  for (const content of ['', 'SOVEREIGN_IDENTITY_MODE=local', 'SOVEREIGN_IDENTITY_MODE=', 'SOVEREIGN_IDENTITY_MODE="local" # default', '# SOVEREIGN_IDENTITY_MODE=tailnet', 'OTHER_SOVEREIGN_IDENTITY_MODE=tailnet']) {
    assert.equal(trustsIdentityHeaders(content), false, JSON.stringify(content));
  }
  const fsImpl = createFakeFs({ '/opt/sovereign-home/apps/familyPulse/.env': { kind: 'link', target: '/opt/sovereign-home/apps/familyPulse/real.env' }, '/opt/sovereign-home/apps/familyPulse/real.env': 'SOVEREIGN_IDENTITY_MODE=tailnet\n' });
  const handlers = createBaseHandlers({ fsImpl, run: async () => ({ stdout: '' }), lookupUser: () => ({ uid: 1001, gid: 1002 }), asUser: (_user, fn) => fn() });
  await assert.rejects(() => handlers['nginx.restore-tcp-gateway'](base('nginx.restore-tcp-gateway', { risk: 'destructive' })), /family-pulse still trusts identity headers/, 'a symlinked .env counts as trusting');
});
