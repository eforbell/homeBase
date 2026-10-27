const test = require('node:test');
const assert = require('node:assert/strict');
const { createBaseHandlers, INGRESS_STATE_PATH } = require('../executor/handlers');
const { createServeHandlers, PRE_INGRESS_SNAPSHOT, SERVE_CONFIG_FILE } = require('../executor/serve-handlers');
const { buildIngressCutoverPlan, buildIngressRollbackPlan, buildServicePublishPlan } = require('../src/operations/compilers/ingress');
const { validateOperationPolicy } = require('../src/operations/policy');
const { createFakeFs } = require('./fixtures/fake-fs');

const DOMAIN = 'example-tailnet.ts.net';
// Recorded on the test VM (Tailscale 1.102.4) after `tailscale serve --service=svc:<name> --https=443
// unix:<socket>`, names replaced: a socket target is stored as "https://unix:<path>" under tcp:443.
const RECORDED_SOCKET_SERVICE = { 'tcp:443': 'https://unix:/run/sovereign-serve/svc-example-home.sock' };
// A pre-SID-001 host: svc:home → nginx's TCP :443, plus an unrelated service.
const LEGACY = {
  version: '0.0.1',
  services: {
    'svc:home': { endpoints: { 'tcp:3080': 'http://127.0.0.1:3080', 'tcp:443': 'https+insecure://localhost:443' } },
    'svc:family-pulse-mcp': { endpoints: { 'tcp:443': 'http://127.0.0.1:3004' } },
  },
};

// Emulates the CLI as measured on the test VM: set-config --all replaces the services map with the file's
// (services left out are removed) and keeps node-level Serve entries.
function fakeTailscale({ config = LEGACY, tags = ['tag:smith-host'], fsImpl }) {
  const state = { config: JSON.parse(JSON.stringify(config)), node: { 'host:443': 'kept' }, calls: [] };
  const run = async (input) => {
    state.calls.push(input);
    if (input.binary === '/usr/sbin/nginx') return { stdout: '# configuration file /etc/nginx/nginx.conf:\nhttp {\n}\n' };
    if (input.binary !== '/usr/bin/tailscale') return { stdout: '' };
    const args = input.args.join(' ');
    if (args === 'status --json --peers=false') return { stdout: JSON.stringify({ Self: { ID: 'nSelf1CNTRL', Tags: tags } }) };
    if (args === 'serve get-config --all') return { stdout: JSON.stringify(state.config) };
    if (args === `serve set-config --all ${SERVE_CONFIG_FILE}`) {
      const file = JSON.parse(fsImpl.readFileSync(SERVE_CONFIG_FILE));
      state.config = { version: file.version, ...(Object.keys(file.services || {}).length ? { services: file.services } : {}) };
      return { stdout: '' };
    }
    throw new Error(`unexpected tailscale ${args}`);
  };
  return { state, run };
}

function host({ cutOver = true, ...options } = {}) {
  const fsImpl = createFakeFs({
    '/var/lib/homebase-executor': { kind: 'dir', mode: 0o700 },
    ...(cutOver ? { [INGRESS_STATE_PATH]: JSON.stringify({ mode: 'sockets', instance: 'smith', domain: DOMAIN }) } : {}),
  });
  const { state, run } = fakeTailscale({ ...options, fsImpl });
  return { fsImpl, state, handlers: createServeHandlers({ fsImpl, run }) };
}
const op = (type, fields = {}) => ({ id: 'op', type, title: 't', risk: 'write', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], ...fields });

test('publishing targets the service socket, keeps every other service, and snapshots the original once', async () => {
  const { fsImpl, state, handlers } = host();
  assert.match(await handlers['tailscale.publish-service'](op('tailscale.publish-service', { serviceKey: 'home' })), /published svc:smith-home → unix:\/run\/sovereign-serve\/home\.sock/);
  assert.deepEqual(state.config.services['svc:smith-home'].endpoints, { 'tcp:443': 'https://unix:/run/sovereign-serve/home.sock' });
  assert.deepEqual(state.config.services['svc:home'], LEGACY.services['svc:home'], 'publishing never touches another service');
  assert.deepEqual(state.config.services['svc:family-pulse-mcp'], LEGACY.services['svc:family-pulse-mcp']);
  assert.deepEqual(JSON.parse(fsImpl.readFileSync(PRE_INGRESS_SNAPSHOT)), LEGACY);
  await handlers['tailscale.publish-service'](op('tailscale.publish-service', { serviceKey: 'pulse' }));
  assert.deepEqual(JSON.parse(fsImpl.readFileSync(PRE_INGRESS_SNAPSHOT)), LEGACY, 'the snapshot is the state before the first publish');
  assert.match(await handlers['tailscale.publish-service'](op('tailscale.publish-service', { serviceKey: 'pulse' })), /already targets/);
  assert.ok(!state.calls.some((call) => call.args?.includes('set-raw')), 'never set-raw');
  // Matches the recorded CLI format for a socket target.
  assert.match(Object.values(RECORDED_SOCKET_SERVICE)[0], /^https:\/\/unix:\/run\/sovereign-serve\/[a-z0-9-]+\.sock$/);
});

test('publishing refuses: not cut over, unknown service key, untagged host, foreign endpoints on the service', async () => {
  await assert.rejects(() => host({ cutOver: false }).handlers['tailscale.publish-service'](op('tailscale.publish-service', { serviceKey: 'home' })), /not cut over/);
  await assert.rejects(() => host().handlers['tailscale.publish-service'](op('tailscale.publish-service', { serviceKey: 'family-dinner' })), /not a service this host can serve/);
  await assert.rejects(() => host({ tags: [] }).handlers['tailscale.publish-service'](op('tailscale.publish-service', { serviceKey: 'home' })), /user-owned \(untagged\)/);
  const taken = { version: '0.0.1', services: { 'svc:smith-home': { endpoints: { 'tcp:443': 'http://127.0.0.1:9999' } } } };
  const { state, handlers } = host({ config: taken });
  await assert.rejects(() => handlers['tailscale.publish-service'](op('tailscale.publish-service', { serviceKey: 'home' })), /already has other endpoints/);
  assert.deepEqual(state.config, taken);
});

test('the cutover retires the legacy service; socket services cannot be retired that way', async () => {
  const { state, handlers } = host();
  assert.match(await handlers['tailscale.retire-service'](op('tailscale.retire-service', { risk: 'destructive', service: 'svc:home' })), /retired svc:home/);
  assert.equal(state.config.services['svc:home'], undefined);
  assert.ok(state.config.services['svc:family-pulse-mcp']);
  assert.match(await handlers['tailscale.retire-service'](op('tailscale.retire-service', { risk: 'destructive', service: 'svc:home' })), /not served by this host/);
  await assert.rejects(() => handlers['tailscale.retire-service'](op('tailscale.retire-service', { risk: 'destructive', service: 'svc:smith-pulse' })), /socket-ingress service/);
});

test('rollback restores Serve exactly as it was before the cutover', async () => {
  const { fsImpl, state, handlers } = host();
  await handlers['tailscale.retire-service'](op('tailscale.retire-service', { risk: 'destructive', service: 'svc:home' }));
  await handlers['tailscale.publish-service'](op('tailscale.publish-service', { serviceKey: 'home' }));
  await handlers['tailscale.restore-serve-snapshot'](op('tailscale.restore-serve-snapshot', { risk: 'destructive' }));
  assert.deepEqual(state.config, LEGACY);
  assert.equal(fsImpl.existsSync(PRE_INGRESS_SNAPSHOT), false);
  assert.match(await handlers['tailscale.restore-serve-snapshot'](op('tailscale.restore-serve-snapshot', { risk: 'destructive' })), /no pre-ingress Serve snapshot/);
});

test('end to end on one host: cutover, publish, rollback', async () => {
  const fsImpl = createFakeFs({ '/var/lib/homebase-executor': { kind: 'dir', mode: 0o700 }, '/etc/tmpfiles.d': { kind: 'dir' }, '/etc/nginx/sites-enabled': { kind: 'dir' }, '/etc/nginx/sites-available': { kind: 'dir' } });
  const { state, run } = fakeTailscale({ fsImpl });
  const tmpfilesRun = async (input) => {
    if (input.binary === '/usr/bin/systemd-tmpfiles') fsImpl.mkdirSync('/run/sovereign-serve', { mode: 0o700 });
    return run(input);
  };
  const handlers = { ...createBaseHandlers({ fsImpl, run: tmpfilesRun }), ...createServeHandlers({ fsImpl, run: tmpfilesRun }) };
  const execute = async (plan) => { validateOperationPolicy(plan); for (const operation of plan.operations) await handlers[operation.type](operation); };
  await execute(buildIngressCutoverPlan({ instance: 'smith', domain: DOMAIN, legacyService: 'svc:home' }));
  for (const serviceKey of ['homebase', 'home']) await execute(buildServicePublishPlan({ serviceKey }));
  assert.deepEqual(Object.keys(state.config.services).sort(), ['svc:family-pulse-mcp', 'svc:smith-home', 'svc:smith-homebase']);
  await execute(buildIngressRollbackPlan({ installations: {} }));
  assert.deepEqual(state.config, LEGACY);
  assert.doesNotMatch(fsImpl.readFileSync('/etc/nginx/sites-available/sovereign-home'), /sovereign-ingress: sockets/);
  assert.deepEqual(state.node, { 'host:443': 'kept' });
});
