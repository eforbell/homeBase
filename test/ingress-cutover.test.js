const test = require('node:test');
const assert = require('node:assert/strict');
const { createBaseHandlers, NGINX_GATEWAY_CONTENT, INGRESS_STATE_PATH } = require('../executor/handlers');
const { createFakeFs } = require('./fixtures/fake-fs');
const { users } = require('./fixtures/users');
const { buildIngressCutoverPlan, buildIngressRollbackPlan } = require('../src/operations/compilers/ingress');
const { buildAppInstallPlan } = require('../src/operations/compilers/install');
const { validateOperationPolicy } = require('../src/operations/policy');

const SITE = '/etc/nginx/sites-available/sovereign-home';
const { RELOAD_TOKEN_SNIPPET } = require('../src/operations/ingress-layout');
const DOMAIN = 'example-tailnet.ts.net';
const FRESH_NGINX = '# configuration file /etc/nginx/nginx.conf:\nhttp {\n  include /etc/nginx/sites-enabled/*;\n}\n';
const OPERATOR_NGINX = `${FRESH_NGINX}# configuration file /etc/nginx/sites-enabled/mine:\nserver {\n  listen 443 ssl;\n  include /etc/nginx/sovereign-home.d/*.conf;\n}\n`;

function base(type, fields = {}) {
  return { id: 'op', type, title: 't', risk: 'write', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], ...fields };
}

// systemd-tmpfiles creates the socket directory the way the tmpfiles.d entry says; nginx -T prints `dump`.
// answers: whether Home Base answers its health probe on its socket. loadsGateway: whether nginx -T shows the
// gateway on disk, as it does when the configuration includes it. gateway(socket, tokenOnDisk): what the workers
// answer on a service socket; by default, the token written for the last reload, as when nginx accepted it.
// homeBaseService: what `serve get-config --service=svc:smith-homebase` shows. reaches: whether nginx reaches Home Base through its service socket.
const PUBLISHED_HOMEBASE = { version: '0.0.1', endpoints: { 'tcp:443': 'https://unix:/run/sovereign-serve/homebase.sock' } };
function harness(files = {}, { dump = FRESH_NGINX, socketDirMode = 0o700, lookupUser, asUser, answers = true, reaches = true, loadsGateway = true, gateway = async (_socket, onDisk) => onDisk, homeBaseService = PUBLISHED_HOMEBASE } = {}) {
  // Present on every host: the executor's state directory (its job journal lives there) and tmpfiles.d.
  const fsImpl = createFakeFs({ '/var/lib/homebase-executor': { kind: 'dir', mode: 0o700 }, '/etc/tmpfiles.d': { kind: 'dir' }, '/etc/nginx/sites-enabled': { kind: 'dir' }, '/etc/nginx/sites-available': { kind: 'dir' }, ...files });
  const calls = [];
  const run = async (input) => {
    calls.push(input);
    if (input.binary === '/usr/bin/systemd-tmpfiles' && !fsImpl.existsSync('/run/sovereign-serve')) fsImpl.mkdirSync('/run/sovereign-serve', { mode: socketDirMode });
    if (input.binary === '/usr/sbin/nginx') {
      const site = loadsGateway && fsImpl.existsSync(SITE) ? `# configuration file /etc/nginx/sites-enabled/sovereign-home:\n${fsImpl.readFileSync(SITE)}\n` : '';
      return { stdout: `${dump}${site}`, stderr: '' };
    }
    if (input.binary === '/usr/bin/tailscale' && input.args[1] === 'get-config') return { stdout: JSON.stringify(homeBaseService) };
    return { stdout: '' };
  };
  const probeHomeBase = async (socket, options) => {
    calls.push({ probe: socket, ...options });
    return socket.startsWith('/run/sovereign-serve/') ? reaches : answers;
  };
  return { fsImpl, calls, handlers: createBaseHandlers({ fsImpl, run, sleep: async () => {}, probeHomeBase, probeGateway: async (socket) => gateway(socket, /"(.+)"/.exec(fsImpl.readFileSync(RELOAD_TOKEN_SNIPPET))?.[1]), ...(lookupUser ? { lookupUser } : {}), ...(asUser ? { asUser } : {}) }) };
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

test('SID-006: a cutover moves Home Base onto its socket only once it listens there, and refreshes keep it', async () => {
  const { fsImpl, handlers } = harness();
  const homeBaseUpstreams = () => fsImpl.readFileSync(SITE).match(/proxy_pass http:\/\/(?:unix:\/run\/homebase-identity\/homebase\.sock|127\.0\.0\.1:3080);/g);
  const onPort = () => homeBaseUpstreams().every((line) => line.includes('127.0.0.1:3080'));
  // A host cut over before SID-006: its record has no homeBase, so nginx keeps Home Base on the loopback port.
  await handlers['nginx.ensure-socket-gateway'](cutover());
  assert.ok(onPort());
  await handlers['nginx.ensure-gateway'](base('nginx.ensure-gateway'));
  assert.ok(onPort(), 'a refresh never moves Home Base on its own');
  // A Home Base older than the executor never opens its socket: nginx keeps it on the port (no 502).
  assert.match(await handlers['nginx.ensure-socket-gateway'](cutover({ homeBase: 'socket' })), /Home Base on port 3080: it is not listening on its socket yet/);
  assert.ok(onPort());
  assert.equal(JSON.parse(fsImpl.readFileSync(INGRESS_STATE_PATH)).homeBase, undefined);
  // A socket file nobody answers on (a newer Home Base's, left by an older one): nginx keeps the port.
  const stale = harness({ '/run/homebase-identity': { kind: 'dir', mode: 0o750 }, '/run/homebase-identity/homebase.sock': { kind: 'socket' } }, { answers: false });
  await stale.handlers['nginx.ensure-socket-gateway'](cutover());
  assert.match(await stale.handlers['nginx.ensure-socket-gateway'](cutover({ homeBase: 'socket' })), /Home Base on port 3080: it is not listening on its socket yet/);
  assert.doesNotMatch(stale.fsImpl.readFileSync(SITE), /homebase-identity\/homebase\.sock/);
  // Listening: Home Base and its passkey mounts (every strict hostname) move onto its socket.
  const listening = harness({ '/run/homebase-identity': { kind: 'dir', mode: 0o750 }, '/run/homebase-identity/homebase.sock': { kind: 'socket' } });
  await listening.handlers['nginx.ensure-socket-gateway'](cutover());
  assert.match(await listening.handlers['nginx.ensure-socket-gateway'](cutover({ homeBase: 'socket' })), /Home Base on its socket/);
  assert.deepEqual(JSON.parse(listening.fsImpl.readFileSync(INGRESS_STATE_PATH)), { mode: 'sockets', instance: 'smith', domain: DOMAIN, homeBase: 'socket' });
  const upstreams = listening.fsImpl.readFileSync(SITE).match(/proxy_pass http:\/\/(?:unix:\/run\/homebase-identity\/homebase\.sock|127\.0\.0\.1:3080);/g);
  assert.equal(upstreams.length, 6, "homebase's location / plus /_sovereign/auth/ on homebase and the four sensitive apps");
  assert.ok(upstreams.every((line) => line.includes('homebase.sock')));
  await listening.handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload'));
  await listening.handlers['nginx.ensure-gateway'](base('nginx.ensure-gateway'));
  assert.doesNotMatch(listening.fsImpl.readFileSync(SITE), /127\.0\.0\.1:3080/, 'refreshes keep the socket');
  listening.fsImpl.unlinkSync('/run/homebase-identity/homebase.sock');
  assert.match(await listening.handlers['nginx.ensure-socket-gateway'](cutover({ homeBase: 'socket' })), /Home Base on its socket/, 'running the cutover again while Home Base restarts keeps it');
  // A record naming anything else is unreadable, not quietly TCP.
  listening.fsImpl.writeFileSync(INGRESS_STATE_PATH, JSON.stringify({ mode: 'sockets', instance: 'smith', domain: DOMAIN, homeBase: 'tcp' }));
  await assert.rejects(() => listening.handlers['nginx.ensure-gateway'](base('nginx.ensure-gateway')), /is unreadable/);
});

test('SID-006: the applied record says where the gateway nginx last reloaded reaches Home Base, whatever is written since', async () => {
  const { APPLIED_PATH, homeBaseOnSocket } = require('../src/operations/ingress-layout');
  const files = { '/run/homebase-identity': { kind: 'dir', mode: 0o750 }, '/run/homebase-identity/homebase.sock': { kind: 'socket' } };
  const { fsImpl, handlers } = harness(files);
  const applied = () => (fsImpl.existsSync(APPLIED_PATH) ? JSON.parse(fsImpl.readFileSync(APPLIED_PATH)).homeBase : null);
  const onSocket = () => homeBaseOnSocket({ appliedText: fsImpl.existsSync(APPLIED_PATH) ? fsImpl.readFileSync(APPLIED_PATH) : '', siteText: fsImpl.readFileSync(SITE) });
  await handlers['nginx.ensure-socket-gateway'](cutover());
  await handlers['nginx.ensure-socket-gateway'](cutover({ homeBase: 'socket' }));
  assert.equal(applied(), null, 'written, not yet reloaded');
  assert.equal(onSocket(), false);
  await handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload'));
  assert.equal(applied(), 'socket');
  assert.equal(onSocket(), true);
  assert.equal(fsImpl.statSync(APPLIED_PATH).mode & 0o777, 0o644, 'Home Base reads it');
  // An app install rewrites the gateway: nginx still runs the reloaded one until the next reload succeeds.
  await handlers['nginx.ensure-gateway'](base('nginx.ensure-gateway'));
  assert.equal(onSocket(), true);
  const refusing = createBaseHandlers({ fsImpl, sleep: async () => {}, run: async (input) => { if (input.binary === '/usr/sbin/nginx') throw Object.assign(new Error('nginx -t failed'), { code: 'OPERATION_FAILED' }); return { stdout: '' }; } });
  await assert.rejects(() => refusing['nginx.validate-and-reload'](base('nginx.validate-and-reload')), /nginx -t failed/);
  assert.equal(applied(), 'socket', 'a refused reload changes nothing nginx runs');
  // A rollback writes the TCP gateway; once nginx reloads it, Home Base is back on the port.
  await handlers['nginx.restore-tcp-gateway'](base('nginx.restore-tcp-gateway', { risk: 'destructive' }));
  assert.doesNotMatch(fsImpl.readFileSync(SITE), /^# sovereign-ingress: sockets/);
  assert.equal(onSocket(), false, 'the gateway on disk already sends Home Base the port');
  await handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload'));
  assert.equal(applied(), 'tcp');
});

// A host's own nginx.conf: a stream block and a site of its own, and no sites-enabled include (bugBase #154).
const CUSTOM_NGINX = '# configuration file /etc/nginx/nginx.conf:\nstream {\n  server { listen 50002; proxy_pass 127.0.0.1:50001; }\n}\nhttp {\n  # include /etc/nginx/sites-enabled/*;\n  server { listen 8080; }\n}\n';

test('a first cutover leaves Home Base on port 3080, so an administrator can still publish its service (#157)', async () => {
  const { APPLIED_PATH, homeBaseOnSocket } = require('../src/operations/ingress-layout');
  const plan = buildIngressCutoverPlan({ instance: 'smith', domain: DOMAIN, legacyService: 'svc:home' });
  validateOperationPolicy(plan);
  assert.equal(plan.operations[0].homeBase, undefined);
  const files = { '/run/homebase-identity': { kind: 'dir', mode: 0o750 }, '/run/homebase-identity/homebase.sock': { kind: 'socket' } };
  const { fsImpl, handlers } = harness(files);
  assert.match(await handlers['nginx.ensure-socket-gateway'](plan.operations[0]), /Home Base on port 3080/);
  await handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload'));
  assert.equal(JSON.parse(fsImpl.readFileSync(APPLIED_PATH)).homeBase, 'tcp');
  assert.equal(homeBaseOnSocket({ appliedText: fsImpl.readFileSync(APPLIED_PATH), siteText: fsImpl.readFileSync(SITE) }), false, 'the port stays Home Base');
  const moved = buildIngressCutoverPlan({ instance: 'smith', domain: DOMAIN, moveHomeBase: true });
  validateOperationPolicy(moved);
  assert.equal(moved.operations[0].homeBase, 'socket');
});

test('the executor moves Home Base only once its service is published here and nginx reaches it (#157)', async () => {
  const files = { '/run/homebase-identity': { kind: 'dir', mode: 0o750 }, '/run/homebase-identity/homebase.sock': { kind: 'socket' } };
  const move = cutover({ homeBase: 'socket' });
  // Nothing is written before these checks, so each refusal leaves the host as it was.
  const refused = async (options, expected) => {
    const { fsImpl, handlers } = harness(files, options);
    await handlers['nginx.ensure-socket-gateway'](cutover());
    const before = [fsImpl.readFileSync(INGRESS_STATE_PATH), fsImpl.readFileSync(SITE)];
    await assert.rejects(() => handlers['nginx.ensure-socket-gateway'](move), expected);
    assert.deepEqual([fsImpl.readFileSync(INGRESS_STATE_PATH), fsImpl.readFileSync(SITE)], before);
    assert.doesNotMatch(fsImpl.readFileSync(SITE), /homebase-identity\/homebase\.sock/);
  };
  await refused({ homeBaseService: {} }, /svc:smith-homebase isn't published on this host/);
  await refused({ homeBaseService: { endpoints: { 'tcp:443': 'http://127.0.0.1:3080' } } }, /isn't published on this host/);
  await refused({ homeBaseService: { endpoints: { ...PUBLISHED_HOMEBASE.endpoints, 'tcp:80': 'http://x' } } }, /isn't published on this host/);
  await refused({ homeBaseService: { ...PUBLISHED_HOMEBASE, advertised: false } }, /isn't published on this host/);
  await refused({ reaches: false }, /nginx doesn't reach Home Base through svc:smith-homebase's socket/);
  // Not cut over at all: there is no gateway to move behind.
  const fresh = harness(files);
  await assert.rejects(() => fresh.handlers['nginx.ensure-socket-gateway'](move), /before the cutover/);
  assert.equal(fresh.fsImpl.existsSync(INGRESS_STATE_PATH), false);
  // The probe asks the service's own hostname: nginx serves only that on this socket.
  const { handlers, calls } = harness(files);
  await handlers['nginx.ensure-socket-gateway'](cutover());
  assert.match(await handlers['nginx.ensure-socket-gateway'](move), /Home Base on its socket/);
  assert.ok(calls.some((call) => call.probe === '/run/sovereign-serve/homebase.sock' && call.host === `smith-homebase.${DOMAIN}`));
});

test('a move that never reloaded proves nothing: a retry starts it again or goes back to the port', async () => {
  const { APPLIED_PATH } = require('../src/operations/ingress-layout');
  const files = { '/run/homebase-identity': { kind: 'dir', mode: 0o750 }, '/run/homebase-identity/homebase.sock': { kind: 'socket' } };
  const pending = () => ({ ...files, [INGRESS_STATE_PATH]: JSON.stringify({ mode: 'sockets', instance: 'smith', domain: DOMAIN, homeBase: 'socket' }), [APPLIED_PATH]: JSON.stringify({ homeBase: 'tcp' }) });
  const unpublished = { homeBaseService: {} };
  // A plain retry doesn't finish it.
  const retried = harness(pending(), unpublished);
  assert.match(await retried.handlers['nginx.ensure-socket-gateway'](cutover()), /Home Base on port 3080/);
  assert.equal(JSON.parse(retried.fsImpl.readFileSync(INGRESS_STATE_PATH)).homeBase, undefined);
  assert.doesNotMatch(retried.fsImpl.readFileSync(SITE), /homebase-identity\/homebase\.sock/);
  // Asking for the move again takes the checks again.
  const asked = harness(pending(), unpublished);
  await assert.rejects(() => asked.handlers['nginx.ensure-socket-gateway'](cutover({ homeBase: 'socket' })), /isn't published on this host/);
  // A refresh from an app install doesn't finish it either.
  const refreshed = harness(pending(), unpublished);
  await refreshed.handlers['nginx.ensure-gateway'](base('nginx.ensure-gateway'));
  assert.doesNotMatch(refreshed.fsImpl.readFileSync(SITE), /homebase-identity\/homebase\.sock/);
  await refreshed.handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload'));
  assert.equal(JSON.parse(refreshed.fsImpl.readFileSync(APPLIED_PATH)).homeBase, 'tcp', ':3080 stays');
});

test('a host already on its socket stays there without those checks', async () => {
  const { APPLIED_PATH } = require('../src/operations/ingress-layout');
  const files = { '/run/homebase-identity': { kind: 'dir', mode: 0o750 }, '/run/homebase-identity/homebase.sock': { kind: 'socket' }, [APPLIED_PATH]: JSON.stringify({ homeBase: 'socket' }) };
  const onSocket = harness({ ...files, [INGRESS_STATE_PATH]: JSON.stringify({ mode: 'sockets', instance: 'smith', domain: DOMAIN, homeBase: 'socket' }) }, { homeBaseService: {}, reaches: false });
  assert.match(await onSocket.handlers['nginx.ensure-socket-gateway'](cutover({ homeBase: 'socket' })), /Home Base on its socket/);
  assert.match(await onSocket.handlers['nginx.ensure-socket-gateway'](cutover()), /Home Base on its socket/, 'a plain re-run never moves it back');
});

test('a cutover refuses a nginx that would ignore the gateway, before writing anything (#154)', async () => {
  const { fsImpl, calls, handlers } = harness({}, { dump: CUSTOM_NGINX, loadsGateway: false });
  await assert.rejects(() => handlers['nginx.ensure-socket-gateway'](cutover({ homeBase: 'socket' })), (error) => {
    assert.match(error.message, /wouldn't load the socket gateway: nothing in its http block/);
    assert.match(error.message, /include \/etc\/nginx\/sites-enabled\/sovereign-home;/);
    assert.match(error.message, /a stream block too/);
    return true;
  });
  assert.equal(fsImpl.existsSync(INGRESS_STATE_PATH), false);
  assert.equal(fsImpl.existsSync(SITE), false);
  assert.ok(!calls.some((call) => call.binary === '/usr/bin/systemd-tmpfiles'), 'nothing was installed');
});

test('what counts as nginx including the gateway', () => {
  const { includesFile } = require('../src/operations/nginx-config');
  const LINK = '/etc/nginx/sites-enabled/sovereign-home';
  const http = (line) => `# configuration file /etc/nginx/nginx.conf:\nhttp {\n  ${line}\n}\n`;
  for (const yes of ['include /etc/nginx/sites-enabled/*;', 'include /etc/nginx/sites-enabled/sovereign-home;', 'include sites-enabled/*;', 'include ./sites-enabled/*;', 'include "/etc/nginx/sites-enabled/*";', "include '/etc/nginx/sites-enabled/sovereign-home';", 'include /etc/nginx/sites-enabled/sovereign-*;', 'server { listen 80; } include /etc/nginx/sites-enabled/*;']) assert.ok(includesFile(http(yes), LINK), yes);
  for (const no of ['# include /etc/nginx/sites-enabled/*;', 'include /etc/nginx/sites-enabled/*.conf;', 'include /etc/nginx/conf.d/*;', 'include /etc/nginx/sites-enabled/;', 'xinclude /etc/nginx/sites-enabled/*;', '']) assert.ok(!includesFile(http(no), LINK), no);
  assert.ok(includesFile(`${http('')}# configuration file ${LINK}:\nserver {}\n`, LINK), 'already loaded');
  // Where it would make the gateway's server blocks invalid, and block a retry and a rollback too.
  assert.ok(!includesFile(http('server { include /etc/nginx/sites-enabled/*; }'), LINK), 'inside server');
  assert.ok(!includesFile('# configuration file /etc/nginx/nginx.conf:\nstream {\n  include /etc/nginx/sites-enabled/*;\n}\n', LINK), 'inside stream');
  assert.ok(!includesFile('# configuration file /etc/nginx/nginx.conf:\ninclude /etc/nginx/sites-enabled/*;\nhttp {\n}\n', LINK), 'at the top of nginx.conf');
  // A file included from http: its own top level is where its include lands.
  assert.ok(includesFile(`${http('include /etc/nginx/conf.d/*.conf;')}# configuration file /etc/nginx/conf.d/mine.conf:\ninclude /etc/nginx/sites-enabled/*;\n`, LINK));
});

test('a reload that leaves the gateway out is reported and does not retire the port (#154)', async () => {
  const { APPLIED_PATH, homeBaseOnSocket } = require('../src/operations/ingress-layout');
  const files = { '/run/homebase-identity': { kind: 'dir', mode: 0o750 }, '/run/homebase-identity/homebase.sock': { kind: 'socket' } };
  const { fsImpl, handlers } = harness(files, { loadsGateway: false });
  await handlers['nginx.ensure-socket-gateway'](cutover());
  await handlers['nginx.ensure-socket-gateway'](cutover({ homeBase: 'socket' }));
  await assert.rejects(() => handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload')), /nginx reloaded, but its configuration doesn't load the socket gateway/);
  assert.equal(fsImpl.existsSync(APPLIED_PATH), false, 'nothing recorded as applied');
  assert.equal(homeBaseOnSocket({ appliedText: '', siteText: fsImpl.readFileSync(SITE) }), false, 'the port stays Home Base');
});

test('a gateway file nginx loaded in an older version does not count', async () => {
  const { handlers, fsImpl } = harness({}, { loadsGateway: false, dump: `${FRESH_NGINX}# configuration file /etc/nginx/sites-enabled/sovereign-home:\n# sovereign-ingress: sockets\nserver {}\n` });
  await handlers['nginx.ensure-socket-gateway'](cutover());
  await assert.rejects(() => handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload')), /doesn't load the socket gateway/);
  assert.equal(fsImpl.existsSync('/etc/nginx/sovereign-ingress-applied.json'), false);
});

test('every service socket must answer from the gateway on disk, and gets a moment after the reload (#154)', async () => {
  const { APPLIED_PATH } = require('../src/operations/ingress-layout');
  const silent = harness({}, { gateway: async (socket, onDisk) => (socket.endsWith('/home.sock') ? null : onDisk) });
  await silent.handlers['nginx.ensure-socket-gateway'](cutover());
  await assert.rejects(() => silent.handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload')), /nothing is listening on \/run\/sovereign-serve\/home\.sock/);
  assert.equal(silent.fsImpl.existsSync(APPLIED_PATH), false);

  // nginx rejected the reload: the reload reported success and nginx -T shows the new file, but the old workers
  // keep serving. A socket answering isn't enough.
  const stale = harness({}, { gateway: async () => 'an-earlier-generation' });
  await stale.handlers['nginx.ensure-socket-gateway'](cutover());
  await assert.rejects(() => stale.handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload')), /still running its earlier configuration.*rejected the reload/);
  assert.equal(stale.fsImpl.existsSync(APPLIED_PATH), false);

  let probes = 0;
  const slow = harness({}, { gateway: async (_socket, onDisk) => { probes += 1; return probes > 20 ? onDisk : 'an-earlier-generation'; } });
  await slow.handlers['nginx.ensure-socket-gateway'](cutover());
  assert.match(await slow.handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload')), /validated and reloaded/);
  assert.ok(slow.fsImpl.existsSync(APPLIED_PATH));
});

test('a later failed proof on a host already on its socket does not reopen the port', async () => {
  const { APPLIED_PATH } = require('../src/operations/ingress-layout');
  const files = { '/run/homebase-identity': { kind: 'dir', mode: 0o750 }, '/run/homebase-identity/homebase.sock': { kind: 'socket' } };
  let listening = true;
  const { fsImpl, handlers } = harness(files, { gateway: async (_socket, onDisk) => (listening ? onDisk : null) });
  await handlers['nginx.ensure-socket-gateway'](cutover());
  await handlers['nginx.ensure-socket-gateway'](cutover({ homeBase: 'socket' }));
  await handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload'));
  assert.equal(JSON.parse(fsImpl.readFileSync(APPLIED_PATH)).homeBase, 'socket');
  listening = false;
  await assert.rejects(() => handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload')), /nothing is listening/);
  assert.equal(JSON.parse(fsImpl.readFileSync(APPLIED_PATH)).homeBase, 'socket', 'it stays closed');
});

test('the gateway probe asks by the service hostname, and tells apart a token, an old gateway and silence', async () => {
  const http = require('node:http');
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const { probeGatewaySocket } = require('../executor/handlers');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  const socket = path.join(dir, 'x.sock');
  assert.equal(await probeGatewaySocket(socket, 'a.example'), null, 'no file');
  let seen = null;
  const server = http.createServer((req, res) => {
    seen = { url: req.url, forwarded: req.headers['x-forwarded-host'] };
    if (req.headers['x-forwarded-host'] !== 'a.example') { res.writeHead(421); return res.end('no'); }
    res.writeHead(200);
    return res.end('abc123\n');
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  assert.equal(await probeGatewaySocket(socket, 'a.example'), 'abc123');
  assert.deepEqual(seen, { url: '/_sovereign/gateway', forwarded: 'a.example' });
  assert.equal(await probeGatewaySocket(socket, 'other.example'), '', 'answering, but not with a token');
  await new Promise((resolve) => server.close(resolve));
  fs.writeFileSync(socket, '');
  assert.equal(await probeGatewaySocket(socket, 'a.example'), null, 'a stale file');
  fs.rmSync(dir, { recursive: true });
});

test('a gateway from before the token only has to answer, until its next refresh', async () => {
  const { APPLIED_PATH, gatewayReportsReload } = require('../src/operations/ingress-layout');
  const { fsImpl, handlers } = harness({}, { gateway: async () => '' });
  await handlers['nginx.ensure-socket-gateway'](cutover());
  fsImpl.writeFileSync(SITE, fsImpl.readFileSync(SITE).replace(/location = \/_sovereign\/gateway \{[^}]*\}\n/g, ''));
  assert.equal(gatewayReportsReload(fsImpl.readFileSync(SITE)), false);
  await handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload'));
  assert.ok(fsImpl.existsSync(APPLIED_PATH));
  await handlers['nginx.ensure-gateway'](base('nginx.ensure-gateway'));
  assert.equal(gatewayReportsReload(fsImpl.readFileSync(SITE)), true, 'a refresh adds it');
});

test('each reload writes a new token, so a rejected one is caught even when only an app snippet changed', async () => {
  const { APPLIED_PATH } = require('../src/operations/ingress-layout');
  const seen = [];
  let accepted = true;
  let running = null;
  const { fsImpl, handlers } = harness({}, { gateway: async (_socket, onDisk) => { if (accepted) running = onDisk; seen.push(onDisk); return running; } });
  await handlers['nginx.ensure-socket-gateway'](cutover());
  assert.match(fsImpl.readFileSync(RELOAD_TOKEN_SNIPPET), /^return 200 "none";\n$/, 'there from the start: the gateway includes it');
  await handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload'));
  const site = fsImpl.readFileSync(SITE);
  const applied = fsImpl.readFileSync(APPLIED_PATH);
  await handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload'));
  assert.notEqual(seen[0], seen.at(-1), 'a new token for each reload');
  assert.match(seen.at(-1), /^[0-9a-f]{16}$/);
  // Nothing in the gateway file changes (an app snippet would be the change), and nginx rejects the reload.
  accepted = false;
  await assert.rejects(() => handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload')), /still running its earlier configuration/);
  assert.equal(fsImpl.readFileSync(SITE), site);
  assert.equal(fsImpl.readFileSync(APPLIED_PATH), applied, 'the record stays as it was');
});

test('a host that was never cut over gets no token', async () => {
  const { fsImpl, handlers } = harness({ [SITE]: 'server {}\n' });
  await handlers['nginx.validate-and-reload'](base('nginx.validate-and-reload'));
  assert.equal(fsImpl.existsSync(RELOAD_TOKEN_SNIPPET), false);
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
  assert.equal(plan.operations[0].homeBase, undefined, 'a first cutover leaves Home Base on the port (#157)');
  assert.equal(buildIngressCutoverPlan({ instance: 'smith', domain: DOMAIN, moveHomeBase: true }).operations[0].homeBase, 'socket', 'SID-006: the move reaches Home Base on its socket');
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
    '/opt/sovereign-home/apps/familyDinner': { kind: 'dir', uid: 1001 },
  }, { lookupUser: users(), asUser: (_user, fn) => fn() });
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

test('a gateway-wide rewrite keeps each app on the transport its snippet uses; only its own update moves it', async () => {
  const { appLayout } = require('../src/operations/app-layout');
  const { getAppById } = require('../src/catalog');
  const plan = appLayout(getAppById('family-plan'));
  const source = appLayout(getAppById('home-source'));
  assert.equal(plan.listen.kind, 'unix');
  // Family Plan installed before its catalog entry moved to a socket (not updated since); Home Source already moved.
  const { fsImpl, handlers } = harness({
    [plan.nginxSnippet]: `location /plan/ { proxy_pass http://127.0.0.1:${plan.port}/; }\n`,
    [source.nginxSnippet]: `location /source/ { proxy_pass http://unix:${source.listen.socket}:/; }\n`,
  });
  await handlers['nginx.ensure-socket-gateway'](cutover());
  assert.match(fsImpl.readFileSync(plan.nginxSnippet), new RegExp(`proxy_pass http://127\\.0\\.0\\.1:${plan.port}/;`));
  assert.doesNotMatch(fsImpl.readFileSync(plan.nginxSnippet), /unix:/);
  assert.match(fsImpl.readFileSync(plan.nginxSnippet), /sovereign-identity/, 'still rewritten for identity lookups');
  assert.match(fsImpl.readFileSync(source.nginxSnippet), new RegExp(`proxy_pass http://unix:${source.listen.socket.replace(/[./]/g, '\\$&')}:/;`));
});

test('rollback refuses while any app reads identity from headers, by its own .env', async () => {
  // SOVEREIGN_AUTH_MODE is what sovereignAuth reads (SID-007); the name used before the contract settled counts too.
  for (const key of ['SOVEREIGN_AUTH_MODE', 'SOVEREIGN_IDENTITY_MODE']) {
    const fsImpl = createFakeFs({ '/opt/sovereign-home/apps/familyPulse/.env': `${key}=tailnet\n`, '/opt/sovereign-home/apps/familyDinner/.env': 'SOVEREIGN_AUTH_MODE=local\n' });
    const reads = [];
    const handlers = createBaseHandlers({ fsImpl, run: async () => ({ stdout: '' }), lookupUser: () => ({ uid: 1001, gid: 1002 }), asUser: (user, fn) => { reads.push(user.uid); return fn(); } });
    await assert.rejects(() => handlers['nginx.restore-tcp-gateway'](base('nginx.restore-tcp-gateway', { risk: 'destructive' })), /family-pulse still trusts identity headers \(SOVEREIGN_AUTH_MODE=tailnet\)/, key);
    assert.ok(reads.length > 0 && reads.every((uid) => uid === 1001), 'app files are read as sovereign, never as root');
  }
});

test('rollback refuses when it cannot tell who owns an installed app', async () => {
  const fsImpl = createFakeFs({ '/opt/sovereign-home/apps/familyDinner': { kind: 'dir', uid: 1001 }, '/opt/sovereign-home/apps/familyDinner/.env': 'SOVEREIGN_IDENTITY_MODE=local\n' });
  const nobody = createBaseHandlers({ fsImpl, run: async () => ({ stdout: '' }), lookupUser: () => null, asUser: (_user, fn) => fn() });
  await assert.rejects(() => nobody['nginx.restore-tcp-gateway'](base('nginx.restore-tcp-gateway', { risk: 'destructive' })), /family-dinner still trusts identity headers/);
  const known = harness({ '/etc/nginx/sovereign-home.d': { kind: 'dir' }, '/opt/sovereign-home/apps/familyDinner': { kind: 'dir', uid: 1001 }, '/opt/sovereign-home/apps/familyDinner/.env': 'SOVEREIGN_IDENTITY_MODE=local\n' }, { lookupUser: users(), asUser: (_user, fn) => fn() });
  assert.match(await known.handlers['nginx.restore-tcp-gateway'](base('nginx.restore-tcp-gateway', { risk: 'destructive' })), /restored the TCP nginx gateway/);
});

test('rollback reads the identity mode the way dotenv loaders do, and fails closed', async () => {
  const { trustsIdentityHeaders } = require('../executor/handlers');
  // Without parsing: the app trusts unless every appearance of a mode key's name is a line that is exactly KEY=local.
  const { renderEnv } = require('../src/operations/env');
  for (const key of ['SOVEREIGN_AUTH_MODE', 'SOVEREIGN_IDENTITY_MODE']) {
    for (const content of ['', `${key}=local\n`, `A=1\n${key}=local\nB="x y"\n`, `${key}=local`, '# notes\nA = 1\n']) {
      assert.equal(trustsIdentityHeaders(content), false, JSON.stringify(content));
    }
    for (const content of [
      `${key}=tailnet\n`, `${key}=headers`, `${key}=`, `${key}=local\n${key}=tailnet\n`, `A=1\n${key}="tailnet"\n`, `${key}="local"\n`,
      `${key}=tailnet # pilot`, `export ${key}=tailnet`, `${key} = "tailnet"`, `${key}: tailnet`, `${key}=\n"tailnet"`, `${key}\n=tailnet`,
      `${key}=local # default`, `${key}=local#pilot`, `# ${key}=tailnet`, `${key}=local\r\n`, `OTHER_${key}X=1\n`,
      // A file in renderEnv's own form that dotenv reads differently (a trailing backslash, then a line separator).
      renderEnv({ [key]: 'local', A: '\\', B: `#\u2028${key}=tailnet#\u2028x` }),
    ]) {
      assert.equal(trustsIdentityHeaders(content), true, JSON.stringify(content));
    }
  }
  const fsImpl = createFakeFs({ '/opt/sovereign-home/apps/familyPulse/.env': { kind: 'link', target: '/opt/sovereign-home/apps/familyPulse/real.env' }, '/opt/sovereign-home/apps/familyPulse/real.env': 'SOVEREIGN_IDENTITY_MODE=tailnet\n' });
  const handlers = createBaseHandlers({ fsImpl, run: async () => ({ stdout: '' }), lookupUser: () => ({ uid: 1001, gid: 1002 }), asUser: (_user, fn) => fn() });
  await assert.rejects(() => handlers['nginx.restore-tcp-gateway'](base('nginx.restore-tcp-gateway', { risk: 'destructive' })), /family-pulse still trusts identity headers/, 'a symlinked .env counts as trusting');
});
