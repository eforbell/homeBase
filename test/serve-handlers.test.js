const test = require('node:test');
const assert = require('node:assert/strict');
const { createBaseHandlers, INGRESS_STATE_PATH } = require('../executor/handlers');
const { createServeHandlers, PRE_INGRESS_SNAPSHOT, restoreArgs } = require('../executor/serve-handlers');
const { buildIngressCutoverPlan, buildIngressRollbackPlan, buildServicePublishPlan } = require('../src/operations/compilers/ingress');
const { validateOperationPolicy } = require('../src/operations/policy');
const { createFakeFs } = require('./fixtures/fake-fs');
const numenorCapture = require('./fixtures/tailscale/serve-config-all-numenor.json');

const DOMAIN = 'example-tailnet.ts.net';
const hostOf = (name) => `${name.slice(4)}.${DOMAIN}`;

// The services captured from a real host, with an independent HTTPS-frontend/HTTP-upstream service beside
// the legacy one (bugBase #156). The capture is get-config output, which can't show frontends; the operator's
// `serve status` showed HTTPS on both Lightning ports.
const CAPTURED = (typeof numenorCapture.stdout === 'string' ? JSON.parse(numenorCapture.stdout) : numenorCapture.stdout).services;
const LEGACY_NAME = 'svc:bitcoin';
const FOREIGN_NAME = 'svc:lightning';

const frontendForScheme = (target) => {
  if (target.startsWith('tcp://')) return 'tcp';
  if (target.startsWith('tls-terminated-tcp://')) return 'tls';
  return target.startsWith('http://') ? 'http' : 'https';
};
const portsFromExport = (endpoints, frontends = {}) => Object.fromEntries(Object.entries(endpoints).map(([endpoint, exported]) => {
  const port = endpoint.slice(4);
  const frontend = frontends[port] || frontendForScheme(exported);
  const target = exported.replace(/^https?:\/\/unix:/, 'unix:').replace(/^tls-terminated-tcp:/, 'tcp:');
  return [port, { frontend, handlers: { '/': target } }];
}));
const NUMENOR = () => ({
  [LEGACY_NAME]: { advertised: false, ports: portsFromExport(CAPTURED[LEGACY_NAME].endpoints) },
  [FOREIGN_NAME]: { advertised: true, ports: portsFromExport(CAPTURED[FOREIGN_NAME].endpoints, { 443: 'https', 8029: 'https' }) },
});

// Behaves as the real CLI was measured to on 1.104.4, including how it fails: the export names only the
// upstream, so `set-config --all` reads "http://" as a plain-HTTP frontend. It refuses that over a live HTTPS
// port and, when the port is free, silently serves plain HTTP. `get-config` exits 1 on a service whose
// handlers have no root.
function fakeTailscale({ services = NUMENOR(), tags = ['tag:smith-host'], fsImpl, failOn = null }) {
  const state = { services: JSON.parse(JSON.stringify(services)), node: { TCP: { 3080: { HTTPS: true } }, Web: { 'host:3080': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3080' } } } } }, calls: [] };
  const exportEndpoint = (entry) => {
    const root = entry.handlers['/'];
    if (entry.frontend === 'tcp') return root;
    if (entry.frontend === 'tls') return root.replace(/^tcp:/, 'tls-terminated-tcp:');
    return root.startsWith('unix:') ? `${entry.frontend}://${root}` : root;
  };
  const exportService = (name) => {
    const service = state.services[name];
    for (const entry of Object.values(service.ports)) {
      if (!entry.handlers['/']) throw new Error(`service "${name}": root handler not set`);
    }
    return { endpoints: Object.fromEntries(Object.entries(service.ports).map(([port, entry]) => [`tcp:${port}`, exportEndpoint(entry)])), ...(service.advertised ? {} : { advertised: false }) };
  };
  const statusOf = (name) => {
    const service = state.services[name];
    const TCP = {};
    const Web = {};
    for (const [port, entry] of Object.entries(service.ports)) {
      if (entry.frontend === 'https') TCP[port] = { HTTPS: true };
      else if (entry.frontend === 'http') TCP[port] = { HTTP: true };
      else TCP[port] = { TCPForward: entry.handlers['/'].replace(/^tcp:\/\//, ''), ...(entry.frontend === 'tls' ? { TerminateTLS: hostOf(name) } : {}) };
      if (entry.frontend === 'https' || entry.frontend === 'http') Web[`${hostOf(name)}:${port}`] = { Handlers: Object.fromEntries(Object.entries(entry.handlers).map(([path, target]) => [path, { Proxy: target }])) };
    }
    return { TCP, ...(Object.keys(Web).length ? { Web } : {}) };
  };
  const setPort = (name, port, frontend, target) => {
    const service = state.services[name] || (state.services[name] = { advertised: true, ports: {} });
    const existing = service.ports[port];
    if (existing && existing.frontend !== frontend) throw new Error(`sending serve config: updating config: want to serve "${frontend}", but port ${port} is already serving "${existing.frontend}" for ${name}`);
    service.ports[port] = { frontend, handlers: { '/': target } };
    service.advertised = true;
  };
  const run = async (input) => {
    state.calls.push(input);
    if (input.binary === '/usr/sbin/nginx') {
      const site = '/etc/nginx/sites-available/sovereign-home';
      return { stdout: `# configuration file /etc/nginx/nginx.conf:\nhttp {\n  include /etc/nginx/sites-enabled/*;\n}\n${fsImpl?.existsSync(site) ? fsImpl.readFileSync(site) : ''}\n` };
    }
    if (input.binary !== '/usr/bin/tailscale') return { stdout: '' };
    const args = input.args.join(' ');
    if (failOn && failOn(args, state)) throw new Error(`injected failure: ${args}`);
    if (args === 'status --json --peers=false') return { stdout: JSON.stringify({ Self: { ID: 'nSelf1CNTRL', Tags: tags } }) };
    if (args === 'serve status --json') return { stdout: JSON.stringify({ Services: Object.fromEntries(Object.keys(state.services).map((name) => [name, statusOf(name)])), ...state.node }) };
    if (args === 'serve get-config --all') return { stdout: JSON.stringify({ version: '0.0.1', services: Object.fromEntries(Object.keys(state.services).map((name) => [name, exportService(name)])) }) };
    if (input.args[1] === 'get-config' && input.args[2]?.startsWith('--service=')) {
      const name = input.args[2].slice('--service='.length);
      return { stdout: JSON.stringify(state.services[name] ? { version: '0.0.1', ...exportService(name) } : {}) };
    }
    if (input.args[1] === 'set-config' && input.args[2] === '--all') {
      const file = JSON.parse(fsImpl.readFileSync(input.args[3]));
      const next = {};
      for (const [name, value] of Object.entries(file.services || {})) {
        for (const [endpoint, target] of Object.entries(value.endpoints || {})) {
          const port = endpoint.slice(4);
          const wanted = frontendForScheme(target);
          const live = state.services[name]?.ports[port];
          if (live && live.frontend !== wanted) throw new Error(`sending serve config: updating config: want to serve "${wanted}", but port ${port} is already serving "${live.frontend}" for ${name}`);
        }
        next[name] = { advertised: value.advertised !== false, ports: portsFromExport(value.endpoints || {}) };
      }
      state.services = next;
      return { stdout: '' };
    }
    if (input.args[1] === 'clear') { delete state.services[input.args[2]]; return { stdout: '' }; }
    if (input.args[1] === 'drain') { state.services[input.args[2]].advertised = false; return { stdout: '' }; }
    if (input.args[1] === 'advertise') { state.services[input.args[2]].advertised = true; return { stdout: '' }; }
    if (input.args[1] === '--bg') {
      assert.equal(input.args[2], '--yes', 'the executor has no terminal, so a prompt must not be possible');
      assert.match(input.args[3], /^--service=svc:/, 'every change names one service');
      const name = input.args[3].slice('--service='.length);
      const [, flag, port] = /^--(https|http|tcp|tls-terminated-tcp)=(\d+)$/.exec(input.args[4]);
      const frontend = { https: 'https', http: 'http', tcp: 'tcp', 'tls-terminated-tcp': 'tls' }[flag];
      setPort(name, port, frontend, input.args[5]);
      return { stdout: '' };
    }
    throw new Error(`unexpected tailscale ${args}`);
  };
  return { state, run };
}

function host({ cutOver = true, snapshot = null, ...options } = {}) {
  const fsImpl = createFakeFs({
    '/var/lib/homebase-executor': { kind: 'dir', mode: 0o700 },
    ...(cutOver ? { [INGRESS_STATE_PATH]: JSON.stringify({ mode: 'sockets', instance: 'smith', domain: DOMAIN }) } : {}),
    ...(snapshot ? { [PRE_INGRESS_SNAPSHOT]: JSON.stringify(snapshot) } : {}),
  });
  const { state, run } = fakeTailscale({ ...options, fsImpl });
  return { fsImpl, state, handlers: createServeHandlers({ fsImpl, run }) };
}
const op = (type, fields = {}) => ({ id: 'op', type, title: 't', risk: 'write', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], ...fields });
const publish = (handlers, serviceKey) => handlers['tailscale.publish-service'](op('tailscale.publish-service', { serviceKey }));
const retire = (handlers, service) => handlers['tailscale.retire-service'](op('tailscale.retire-service', { risk: 'destructive', service }));
const restore = (handlers) => handlers['tailscale.restore-serve-snapshot'](op('tailscale.restore-serve-snapshot', { risk: 'destructive' }));
const writesWholeConfig = (state) => state.calls.some((call) => call.args?.includes('set-config') || call.args?.includes('set-raw'));

test('publishing beside a service with an HTTPS frontend and an HTTP upstream changes nothing else (#156)', async () => {
  const { state, handlers } = host();
  const lightning = JSON.stringify(state.services[FOREIGN_NAME]);
  const node = JSON.stringify(state.node);
  assert.match(await publish(handlers, 'home'), /published svc:smith-home → unix:\/run\/sovereign-serve\/home\.sock/);
  assert.deepEqual(state.services['svc:smith-home'].ports, { 443: { frontend: 'https', handlers: { '/': 'unix:/run/sovereign-serve/home.sock' } } });
  assert.equal(JSON.stringify(state.services[FOREIGN_NAME]), lightning, 'the foreign service keeps its frontends and upstream');
  assert.equal(state.services[LEGACY_NAME].advertised, false, 'a drained service stays drained');
  assert.equal(JSON.stringify(state.node), node, 'node-level entries are kept');
  assert.ok(!writesWholeConfig(state), 'never writes the whole Serve config');
});

test('publishing again is a no-op, and republishing a drained service advertises it', async () => {
  const { state, handlers } = host();
  await publish(handlers, 'pulse');
  const writes = () => state.calls.filter((call) => call.args?.[1] === '--bg').length;
  assert.equal(writes(), 1);
  assert.match(await publish(handlers, 'pulse'), /already targets/);
  assert.equal(writes(), 1, 'nothing was rewritten');
  state.services['svc:smith-pulse'].advertised = false;
  assert.match(await publish(handlers, 'pulse'), /published/);
  assert.equal(state.services['svc:smith-pulse'].advertised, true);
});

test('a foreign service with only a path handler breaks a whole-config read, but not a publish', async () => {
  const services = { ...NUMENOR(), 'svc:pathonly': { advertised: true, ports: { 8443: { frontend: 'https', handlers: { '/foo': 'http://127.0.0.1:8443' } } } } };
  const { state, handlers } = host({ services });
  assert.match(await publish(handlers, 'home'), /published/);
  assert.deepEqual(state.services['svc:pathonly'], services['svc:pathonly']);
  assert.ok(!state.calls.some((call) => call.args?.join(' ') === 'serve get-config --all'), 'never reads the whole config');
});

test('publishing refuses: not cut over, unknown service key, untagged host, foreign endpoints on the service', async () => {
  await assert.rejects(() => publish(host({ cutOver: false }).handlers, 'home'), /not cut over/);
  await assert.rejects(() => publish(host().handlers, 'family-dinner'), /not a service this host can serve/);
  await assert.rejects(() => publish(host({ tags: [] }).handlers, 'home'), /user-owned \(untagged\)/);
  const taken = { 'svc:smith-home': { advertised: true, ports: { 443: { frontend: 'https', handlers: { '/': 'http://127.0.0.1:9999' } } } } };
  const { state, handlers } = host({ services: taken });
  await assert.rejects(() => publish(handlers, 'home'), /already has other endpoints/);
  assert.deepEqual(state.services, taken);
});

test('a publish that changes another entry is reported, not passed off as success', async () => {
  const { state, run } = fakeTailscale({ fsImpl: null });
  const fsImpl = createFakeFs({ '/var/lib/homebase-executor': { kind: 'dir', mode: 0o700 }, [INGRESS_STATE_PATH]: JSON.stringify({ mode: 'sockets', instance: 'smith', domain: DOMAIN }) });
  const handlers = createServeHandlers({ fsImpl, run: async (input) => {
    const result = await run(input);
    if (input.args?.[1] === '--bg') state.services[FOREIGN_NAME].ports[443].frontend = 'http';
    return result;
  } });
  await assert.rejects(() => publish(handlers, 'home'), /was applied, but svc:lightning also changed/);
});

test('a change made by someone else mid-job is named, and running the job again finishes it', async () => {
  const { state, run } = fakeTailscale({ fsImpl: null });
  const fsImpl = createFakeFs({ '/var/lib/homebase-executor': { kind: 'dir', mode: 0o700 }, [INGRESS_STATE_PATH]: JSON.stringify({ mode: 'sockets', instance: 'smith', domain: DOMAIN }) });
  const interfere = async (input) => {
    const result = await run(input);
    if (input.args?.[1] === '--bg' || input.args?.[1] === 'clear') state.node.TCP[9999] = { HTTPS: true };
    return result;
  };
  const handlers = createServeHandlers({ fsImpl, run: interfere });
  await assert.rejects(() => publish(handlers, 'home'), /was applied, but node-level entries also changed/);
  assert.match(await publish(handlers, 'home'), /already targets/);
  delete state.node.TCP[9999];
  await assert.rejects(() => retire(handlers, LEGACY_NAME), /was applied, but node-level entries also changed/);
  assert.match(await retire(handlers, LEGACY_NAME), /not served by this host/);
  assert.ok(fsImpl.existsSync(PRE_INGRESS_SNAPSHOT), 'the record of what was retired survives');
});

test('retiring removes only the legacy service, and saves it first (#156)', async () => {
  const { fsImpl, state, handlers } = host();
  const lightning = JSON.stringify(state.services[FOREIGN_NAME]);
  assert.match(await retire(handlers, LEGACY_NAME), /retired svc:bitcoin/);
  assert.equal(state.services[LEGACY_NAME], undefined);
  assert.equal(JSON.stringify(state.services[FOREIGN_NAME]), lightning);
  assert.ok(!writesWholeConfig(state), 'never writes the whole Serve config');
  const saved = JSON.parse(fsImpl.readFileSync(PRE_INGRESS_SNAPSHOT));
  assert.deepEqual(Object.keys(saved.services), [LEGACY_NAME], 'only what Home Base removed');
  assert.equal(saved.services[LEGACY_NAME].advertised, false);
  assert.deepEqual(saved.frontends[LEGACY_NAME][443], { HTTPS: true });
  assert.match(await retire(handlers, LEGACY_NAME), /not served by this host/);
  assert.ok(fsImpl.existsSync(PRE_INGRESS_SNAPSHOT), 'retiring again keeps the record');
});

test('an interrupted retire leaves a complete record and the service in place', async () => {
  const { fsImpl, state, handlers } = host({ failOn: (args) => args.startsWith('serve clear') });
  await assert.rejects(() => retire(handlers, LEGACY_NAME), /injected failure/);
  assert.ok(state.services[LEGACY_NAME]);
  assert.ok(JSON.parse(fsImpl.readFileSync(PRE_INGRESS_SNAPSHOT)).services[LEGACY_NAME]);
});

test('a retire that stopped inside serve clear keeps the real state, whichever way it continues', async () => {
  const services = { 'svc:home': { advertised: true, ports: portsFromExport({ 'tcp:443': 'https+insecure://localhost:443' }) } };
  const original = JSON.parse(JSON.stringify(services));
  // As the CLI does it: the advertisement goes first, then the config.
  const interrupted = () => {
    let fail = true;
    return (args, state) => {
      if (!fail || !args.startsWith('serve clear')) return false;
      fail = false;
      state.services['svc:home'].advertised = false;
      return true;
    };
  };
  const rolledBack = host({ services, failOn: interrupted() });
  await assert.rejects(() => retire(rolledBack.handlers, 'svc:home'), /injected failure/);
  assert.equal(rolledBack.state.services['svc:home'].advertised, false);
  assert.match(await restore(rolledBack.handlers), /restored svc:home/);
  assert.deepEqual(rolledBack.state.services, original, 'advertised again, not left unavailable');
  assert.equal(rolledBack.fsImpl.existsSync(PRE_INGRESS_SNAPSHOT), false);

  const retried = host({ services, failOn: interrupted() });
  await assert.rejects(() => retire(retried.handlers, 'svc:home'), /injected failure/);
  assert.match(await retire(retried.handlers, 'svc:home'), /retired svc:home/);
  assert.equal(JSON.parse(retried.fsImpl.readFileSync(PRE_INGRESS_SNAPSHOT)).services['svc:home'].advertised, undefined, 'the retry does not record the half-cleared state');
  await restore(retried.handlers);
  assert.deepEqual(retried.state.services, original);
});

test('retiring a service again records it afresh if it has changed since the last record', async () => {
  const snapshot = { version: '0.0.1', services: { 'svc:home': { endpoints: { 'tcp:443': 'http://localhost:1' } } }, frontends: { 'svc:home': { 443: { HTTPS: true } } } };
  const services = { 'svc:home': { advertised: true, ports: portsFromExport({ 'tcp:443': 'https+insecure://localhost:443' }) } };
  const { fsImpl, handlers } = host({ services, snapshot });
  await retire(handlers, 'svc:home');
  assert.deepEqual(JSON.parse(fsImpl.readFileSync(PRE_INGRESS_SNAPSHOT)).services['svc:home'].endpoints, { 'tcp:443': 'https+insecure://localhost:443' });
});

test('retiring refuses what a rollback could not restore, and socket services', async () => {
  await assert.rejects(() => retire(host().handlers, 'svc:smith-pulse'), /socket-ingress service/);
  await assert.rejects(() => retire(host().handlers, '--all'), /not a Tailscale service name/);
  const pathed = { 'svc:old': { advertised: true, ports: { 443: { frontend: 'https', handlers: { '/': 'http://127.0.0.1:1', '/foo': 'http://127.0.0.1:2' } } } } };
  const { state, fsImpl, handlers } = host({ services: pathed });
  await assert.rejects(() => retire(handlers, 'svc:old'), /path handlers/);
  assert.deepEqual(state.services, pathed);
  assert.equal(fsImpl.existsSync(PRE_INGRESS_SNAPSHOT), false);
  assert.throws(() => restoreArgs('svc:old', 'tcp:443', 'text:hello', { HTTPS: true }), /can't restore/);
  assert.throws(() => restoreArgs('svc:old', 'udp:443', 'http://x', { HTTPS: true }), /can't restore/);
});

test('every endpoint shape measured on the CLI maps to the flag that recreates it', () => {
  const scoped = ['serve', '--bg', '--yes', '--service=svc:x'];
  assert.deepEqual(restoreArgs('svc:x', 'tcp:443', 'https+insecure://localhost:443', { HTTPS: true }), [...scoped, '--https=443', 'https+insecure://localhost:443']);
  assert.deepEqual(restoreArgs('svc:x', 'tcp:3080', 'http://127.0.0.1:3080', { HTTPS: true }), [...scoped, '--https=3080', 'http://127.0.0.1:3080']);
  assert.deepEqual(restoreArgs('svc:x', 'tcp:8081', 'http://127.0.0.1:8081', { HTTP: true }), [...scoped, '--http=8081', 'http://127.0.0.1:8081']);
  assert.deepEqual(restoreArgs('svc:x', 'tcp:5432', 'tcp://localhost:5432', { TCPForward: 'localhost:5432' }), [...scoped, '--tcp=5432', 'tcp://localhost:5432']);
  assert.deepEqual(restoreArgs('svc:x', 'tcp:6000', 'tls-terminated-tcp://localhost:6000', { TCPForward: 'localhost:6000', TerminateTLS: 'x' }), [...scoped, '--tls-terminated-tcp=6000', 'tcp://localhost:6000']);
  assert.deepEqual(restoreArgs('svc:x', 'tcp:443', 'https://unix:/run/x.sock', { HTTPS: true }), [...scoped, '--https=443', 'unix:/run/x.sock']);
  assert.deepEqual(restoreArgs('svc:x', 'tcp:8082', 'http://unix:/run/x.sock', { HTTP: true }), [...scoped, '--http=8082', 'unix:/run/x.sock']);
  assert.deepEqual(restoreArgs('svc:x', 'tcp:3080', 'http://127.0.0.1:3080'), [...scoped, '--https=3080', 'http://127.0.0.1:3080'], 'an unknown frontend is never guessed as plain HTTP');
});

test('rollback keeps HTTPS on a retired service with an HTTP upstream, instead of downgrading it (#156)', async () => {
  const services = { 'svc:home': { advertised: true, ports: portsFromExport({ 'tcp:3080': 'http://127.0.0.1:3080', 'tcp:443': 'https+insecure://localhost:443' }, { 3080: 'https' }) } };
  const original = JSON.parse(JSON.stringify(services));
  const { state, handlers } = host({ services });
  await retire(handlers, 'svc:home');
  assert.match(await restore(handlers), /restored svc:home/);
  assert.deepEqual(state.services, original);
  assert.equal(state.services['svc:home'].ports[3080].frontend, 'https');
});

test('rollback restores the retired service exactly, removes socket services, and leaves foreign ones alone', async () => {
  const { fsImpl, state, handlers } = host();
  const original = JSON.parse(JSON.stringify(state.services));
  await retire(handlers, LEGACY_NAME);
  await publish(handlers, 'home');
  await publish(handlers, 'homebase');
  // Someone adds a service of their own after the cutover: not Home Base's to remove.
  state.services['svc:theirs'] = { advertised: true, ports: portsFromExport({ 'tcp:443': 'http://localhost:9000' }, { 443: 'https' }) };
  const theirs = JSON.parse(JSON.stringify(state.services['svc:theirs']));
  const message = await restore(handlers);
  assert.match(message, /restored svc:bitcoin; removed svc:smith-home, svc:smith-homebase/);
  assert.deepEqual(state.services, { ...original, 'svc:theirs': theirs });
  assert.equal(state.services[LEGACY_NAME].advertised, false, 'it was drained before the cutover and stays drained');
  assert.ok(!writesWholeConfig(state), 'never writes the whole Serve config');
  assert.equal(fsImpl.existsSync(PRE_INGRESS_SNAPSHOT), false);
  assert.match(await restore(handlers), /restored no retired services; removed no socket services/);
});

test('a retired service on an HTTP frontend with a socket upstream comes back the same', async () => {
  const services = { 'svc:old': { advertised: true, ports: { 8082: { frontend: 'http', handlers: { '/': 'unix:/run/legacy-app.sock' } } } } };
  const original = JSON.parse(JSON.stringify(services));
  const { state, handlers } = host({ services });
  await retire(handlers, 'svc:old');
  await restore(handlers);
  assert.deepEqual(state.services, original);
});

test('rollback clears only the exact shape a publish creates', async () => {
  const site = (port, handlers, frontend = 'https') => ({ [port]: { frontend, handlers } });
  const socket = 'unix:/run/sovereign-serve/home.sock';
  const services = {
    'svc:mixed-path': { advertised: true, ports: site(443, { '/': 'http://127.0.0.1:9000', '/home': socket }) },
    'svc:mixed-port': { advertised: true, ports: { ...site(443, { '/': socket }), ...site(9443, { '/': 'http://127.0.0.1:9001' }) } },
    'svc:other-port': { advertised: true, ports: site(9443, { '/': socket }) },
    'svc:traversal': { advertised: true, ports: site(443, { '/': 'unix:/run/sovereign-serve/../unrelated.sock' }) },
    'svc:plain-http': { advertised: true, ports: site(443, { '/': socket }, 'http') },
    'svc:smith-home': { advertised: true, ports: site(443, { '/': socket }) },
  };
  const { 'svc:smith-home': removed, ...kept } = services;
  const { state, handlers } = host({ services });
  const message = await restore(handlers);
  assert.deepEqual(state.services, kept, 'nothing someone else may own is cleared');
  assert.match(message, /removed svc:smith-home/);
  assert.match(message, /left svc:mixed-path, svc:mixed-port, svc:other-port, svc:plain-http in place/);
  assert.doesNotMatch(message, /svc:traversal/, 'it is not a Home Base socket at all');
  assert.ok(removed);
});

test('rollback with no record still takes the socket services down', async () => {
  const { state, handlers } = host();
  await publish(handlers, 'home');
  assert.match(await restore(handlers), /restored no retired services; removed svc:smith-home/);
  assert.equal(state.services['svc:smith-home'], undefined);
  assert.ok(state.services[FOREIGN_NAME]);
});

test('an interrupted rollback keeps its record and finishes when run again', async () => {
  let fail = true;
  const failOn = (args) => {
    if (fail && args.startsWith('serve --bg') && args.includes('--tcp=5432')) { fail = false; return true; }
    return false;
  };
  const { fsImpl, state, handlers } = host({ failOn });
  const original = JSON.parse(JSON.stringify(state.services));
  await retire(handlers, LEGACY_NAME);
  await publish(handlers, 'home');
  await assert.rejects(() => restore(handlers), /injected failure/);
  assert.ok(fsImpl.existsSync(PRE_INGRESS_SNAPSHOT), 'the record survives');
  assert.ok(state.services['svc:smith-home'], 'the socket service stays up until the restore has worked');
  assert.match(await restore(handlers), /restored svc:bitcoin; removed svc:smith-home/);
  assert.deepEqual(state.services, original);
  assert.equal(fsImpl.existsSync(PRE_INGRESS_SNAPSHOT), false);
});

test('a rollback stopped before its drain still drains when run again', async () => {
  let fail = true;
  const failOn = (args) => {
    if (fail && args === `serve drain ${LEGACY_NAME}`) { fail = false; return true; }
    return false;
  };
  const { state, handlers } = host({ failOn });
  await retire(handlers, LEGACY_NAME);
  await assert.rejects(() => restore(handlers), /injected failure/);
  assert.equal(state.services[LEGACY_NAME].advertised, true, 'publishing advertised it');
  await restore(handlers);
  assert.equal(state.services[LEGACY_NAME].advertised, false);
});

test('an interrupted restore from an older snapshot finishes every endpoint and the drain when run again', async () => {
  let fail = true;
  const failOn = (args) => {
    if (fail && args.includes('--tcp=5432')) { fail = false; return true; }
    return false;
  };
  const { [LEGACY_NAME]: gone, ...kept } = NUMENOR();
  const snapshot = { version: '0.0.1', services: { [LEGACY_NAME]: { endpoints: CAPTURED[LEGACY_NAME].endpoints, advertised: false } } };
  const { fsImpl, state, handlers } = host({ services: kept, snapshot, failOn });
  await assert.rejects(() => restore(handlers), /injected failure/);
  assert.ok(state.services[LEGACY_NAME], 'the first endpoint was restored');
  assert.ok(fsImpl.existsSync(PRE_INGRESS_SNAPSHOT));
  assert.match(await restore(handlers), /restored svc:bitcoin/);
  assert.deepEqual(state.services[LEGACY_NAME].ports, gone.ports, 'nothing is abandoned');
  assert.equal(state.services[LEGACY_NAME].advertised, false, 'it was drained in the snapshot');
  assert.equal(fsImpl.existsSync(PRE_INGRESS_SNAPSHOT), false);
});

test('an older snapshot with an HTTP socket upstream restores behind HTTPS, and the rollback finishes', async () => {
  const snapshot = { version: '0.0.1', services: { 'svc:old': { endpoints: { 'tcp:8082': 'http://unix:/run/legacy-app.sock' } } } };
  const { fsImpl, state, handlers } = host({ services: {}, snapshot });
  assert.match(await restore(handlers), /restored svc:old; removed no socket services; svc:old :8082 came back on HTTPS/);
  assert.deepEqual(state.services['svc:old'].ports, { 8082: { frontend: 'https', handlers: { '/': 'unix:/run/legacy-app.sock' } } });
  assert.equal(fsImpl.existsSync(PRE_INGRESS_SNAPSHOT), false);
});

test('a snapshot from an older Home Base: restores what is gone behind HTTPS and leaves what is present', async () => {
  const snapshot = { version: '0.0.1', services: {
    [LEGACY_NAME]: CAPTURED[LEGACY_NAME],
    [FOREIGN_NAME]: { endpoints: { 'tcp:443': 'http://localhost:1111' } }, // Changed by its owner since: not rolled back.
    'svc:home': { endpoints: { 'tcp:3080': 'http://127.0.0.1:3080' } },
    'svc:smith-pulse': { endpoints: { 'tcp:443': 'https://unix:/run/sovereign-serve/pulse.sock' } },
  } };
  const { [LEGACY_NAME]: gone, ...kept } = NUMENOR();
  const { fsImpl, state, handlers } = host({ services: kept, snapshot });
  const lightning = JSON.stringify(state.services[FOREIGN_NAME]);
  await publish(handlers, 'home');
  const message = await restore(handlers);
  assert.match(message, /restored svc:bitcoin, svc:home; removed svc:smith-home/);
  assert.match(message, /svc:home :3080 came back on HTTPS because the older record doesn't name a frontend/, 'a guess is reported, never passed off as exact');
  assert.equal(JSON.stringify(state.services[FOREIGN_NAME]), lightning, 'a present service is not rolled back to its old export');
  assert.equal(state.services['svc:home'].ports[3080].frontend, 'https', 'never guessed as plain HTTP');
  assert.deepEqual(state.services[LEGACY_NAME].ports, gone.ports);
  assert.equal(state.services['svc:smith-pulse'], undefined, 'a socket service has nothing behind it after the rollback');
  assert.equal(fsImpl.existsSync(PRE_INGRESS_SNAPSHOT), false);
  // A retire on such a host keeps the older entries and adds its own.
  const again = host({ services: NUMENOR(), snapshot: { version: '0.0.1', services: { 'svc:home': { endpoints: { 'tcp:3080': 'http://127.0.0.1:3080' } } } } });
  await retire(again.handlers, LEGACY_NAME);
  assert.deepEqual(Object.keys(JSON.parse(again.fsImpl.readFileSync(PRE_INGRESS_SNAPSHOT)).services).sort(), [LEGACY_NAME, 'svc:home']);
});

test('end to end on one host: cutover, publish, rollback', async () => {
  const fsImpl = createFakeFs({ '/var/lib/homebase-executor': { kind: 'dir', mode: 0o700 }, '/etc/tmpfiles.d': { kind: 'dir' }, '/etc/nginx/sites-enabled': { kind: 'dir' }, '/etc/nginx/sites-available': { kind: 'dir' } });
  const { state, run } = fakeTailscale({ fsImpl });
  const original = JSON.parse(JSON.stringify(state.services));
  const tmpfilesRun = async (input) => {
    if (input.binary === '/usr/bin/systemd-tmpfiles') fsImpl.mkdirSync('/run/sovereign-serve', { mode: 0o700 });
    return run(input);
  };
  const handlers = { ...createBaseHandlers({ fsImpl, run: tmpfilesRun, probeListening: async () => true }), ...createServeHandlers({ fsImpl, run: tmpfilesRun }) };
  const execute = async (plan) => { validateOperationPolicy(plan); for (const operation of plan.operations) await handlers[operation.type](operation); };
  await execute(buildIngressCutoverPlan({ instance: 'smith', domain: DOMAIN, legacyService: LEGACY_NAME }));
  for (const serviceKey of ['homebase', 'home']) await execute(buildServicePublishPlan({ serviceKey }));
  assert.deepEqual(Object.keys(state.services).sort(), [FOREIGN_NAME, 'svc:smith-home', 'svc:smith-homebase']);
  await execute(buildIngressRollbackPlan({ installations: {} }));
  assert.deepEqual(state.services, original);
  assert.doesNotMatch(fsImpl.readFileSync('/etc/nginx/sites-available/sovereign-home'), /sovereign-ingress: sockets/);
  assert.ok(state.node.TCP[3080], 'node-level entries are kept');
});
