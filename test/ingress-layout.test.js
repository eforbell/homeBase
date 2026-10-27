const test = require('node:test');
const assert = require('node:assert/strict');
const {
  appServiceKey, appSnippetPath, ingressServices, renderAppLocations, renderGatewaySite, renderIdentitySnippet,
  serveTarget, serviceName, validateInstance, IDENTITY_SNIPPET,
} = require('../src/operations/ingress-layout');
const { appLayout } = require('../src/operations/app-layout');
const { catalog, getAppById } = require('../src/catalog');
const { createBaseHandlers } = require('../executor/handlers');
const { createFakeFs } = require('./fixtures/fake-fs');

const SITE = { instance: 'smith', domain: 'example-tailnet.ts.net', apps: catalog };

// Split a rendered site into its server blocks, keyed by the service name in each block's header.
function blocks(site) {
  return Object.fromEntries(site.split(/\n(?=# svc:)/).filter((part) => part.startsWith('# svc:')).map((part) => [part.match(/^# (svc:\S+?):/)[1], part]));
}

test('sensitive apps get their own service; everything else shares home', () => {
  const keys = Object.fromEntries(catalog.map((app) => [app.id, appServiceKey(app)]));
  assert.deepEqual(keys, {
    'family-pulse': 'pulse', 'family-help': 'home', 'family-dinner': 'home', 'family-plan': 'home', 'fast-to-eat': 'home',
    'bitcoin-accounting': 'bitcoin-accounting', helm: 'helm', 'home-source': 'source', 'bug-base': 'home', 'home-ops': 'home', 'home-drop': 'home',
  });
  assert.deepEqual(ingressServices(SITE).map((service) => [service.name, service.socket, service.strict]), [
    ['svc:smith-home', '/run/sovereign-serve/home.sock', false],
    ['svc:smith-homebase', '/run/sovereign-serve/homebase.sock', true],
    ['svc:smith-bitcoin-accounting', '/run/sovereign-serve/bitcoin-accounting.sock', true],
    ['svc:smith-helm', '/run/sovereign-serve/helm.sock', true],
    ['svc:smith-pulse', '/run/sovereign-serve/pulse.sock', true],
    ['svc:smith-source', '/run/sovereign-serve/source.sock', true],
  ]);
  assert.equal(serveTarget('pulse'), 'unix:/run/sovereign-serve/pulse.sock');
  assert.equal(appSnippetPath(getAppById('family-dinner')), '/etc/nginx/sovereign-home.d/home--family-dinner.conf');
});

test('service keys cannot collide with home, homebase, or each other, and instances are single labels', () => {
  const app = (id, mount, dedicated = true) => ({ id, network: { preferredMountPath: mount, dedicatedHostname: dedicated } });
  assert.throws(() => ingressServices({ ...SITE, apps: [app('a', '/homebase/')] }), /reserved for the homebase service/);
  assert.throws(() => ingressServices({ ...SITE, apps: [app('a', '/home/')] }), /reserved/);
  assert.throws(() => ingressServices({ ...SITE, apps: [app('a', '/x--y/')] }), /without '--'/);
  assert.throws(() => ingressServices({ ...SITE, apps: [app('a', '/x/'), app('b', '/x/')] }), /b and a would share the x service/);
  assert.throws(() => ingressServices({ ...SITE, apps: [app('a', '/x/', 'yes')] }), /true or false/);
  assert.throws(() => appLayout({ ...getAppById('helm'), network: { ...getAppById('helm').network, preferredMountPath: '/home/' } }), (error) => error.code === 'POLICY_DENIED' && /helm: mount path \/home\/ is reserved/.test(error.message));
  for (const bad of ['', 'Smith', '1smith', 'smith--x', 'smith-', 'smith.x', 'a'.repeat(25)]) assert.ok(validateInstance(bad), bad);
  assert.equal(validateInstance('smith-family'), null);
  assert.throws(() => serviceName('bad--x', 'home'));
});

test('the gateway listens only on service sockets, never TCP', () => {
  const site = renderGatewaySite(SITE);
  assert.doesNotMatch(site, /listen\s+(\[::\]:)?\d/);
  assert.doesNotMatch(site, /listen\s+[^u]/);
  assert.equal((site.match(/^ {4}listen unix:\/run\/sovereign-serve\/[a-z-]+\.sock;$/gm) || []).length, 6);
  assert.equal((site.match(/absolute_redirect off;/g) || []).length, 6);
});

test('each block includes only its own mounts and answers only for its own hostname', () => {
  const site = blocks(renderGatewaySite(SITE));
  assert.deepEqual(Object.keys(site), ['svc:smith-home', 'svc:smith-homebase', 'svc:smith-bitcoin-accounting', 'svc:smith-helm', 'svc:smith-pulse', 'svc:smith-source']);
  assert.match(site['svc:smith-home'], /include \/etc\/nginx\/sovereign-home\.d\/home--\*\.conf;/);
  assert.match(site['svc:smith-pulse'], /include \/etc\/nginx\/sovereign-home\.d\/pulse--\*\.conf;/);
  for (const [name, block] of Object.entries(site)) {
    const includes = block.match(/include \/etc\/nginx\/sovereign-home\.d\/[^;]+;/g) || [];
    assert.ok(includes.length <= 1, name);
    const host = `${name.slice(4)}.example-tailnet\\.ts\\.net`.replace('.example', '\\.example');
    assert.ok(block.includes(`if ($http_x_forwarded_host !~ "^${host}(:443)?$") {\n        return 421;`), name);
  }
  assert.doesNotMatch(site['svc:smith-homebase'], /sovereign-home\.d/, 'admin serves no app mounts');
  assert.match(site['svc:smith-homebase'], /location \/ \{\n {8}proxy_pass http:\/\/127\.0\.0\.1:3080;/);
  for (const name of ['svc:smith-home', 'svc:smith-pulse']) assert.match(site[name], /location \/ \{\n {8}return 404;/, 'admin routes exist only on homebase');
});

test('passkey pages and the no-framing header exist only on Home Base and sensitive hostnames (D20, D21)', () => {
  const site = blocks(renderGatewaySite(SITE));
  for (const [name, block] of Object.entries(site)) {
    const strict = name !== 'svc:smith-home';
    assert.equal(/location \/_sovereign\/auth\/ \{/.test(block), strict, name);
    assert.equal(block.includes('add_header Content-Security-Policy "frame-ancestors \'none\'" always;'), strict, name);
  }
});

test('the identity lookup is internal, sends only what nginx sets, and names its service', () => {
  const block = blocks(renderGatewaySite(SITE))['svc:smith-pulse'];
  const lookup = block.match(/location = \/_sovereign\/identity \{[^}]+\}/)[0];
  assert.match(lookup, /internal;/);
  assert.match(lookup, /proxy_pass http:\/\/unix:\/run\/homebase-identity\/identity\.sock:\/_sovereign\/identity;/);
  assert.match(lookup, /proxy_pass_request_headers off;/, 'client headers (forged X-Sovereign-*) never reach the lookup');
  assert.match(lookup, /proxy_set_header X-Sovereign-Client-Addr \$http_x_forwarded_for;/);
  assert.match(lookup, /proxy_set_header X-Sovereign-Serve-Login \$http_tailscale_user_login;/);
  assert.match(lookup, /proxy_set_header X-Sovereign-Service svc:smith-pulse;/);
});

test('every proxied location includes the identity snippet, sidecars too', () => {
  const site = renderGatewaySite(SITE);
  const appText = catalog.map((app) => renderAppLocations(appLayout(app))).join('\n');
  for (const text of [site, appText]) {
    const proxied = text.split(/\n(?=\s*location )/).filter((part) => /proxy_pass/.test(part) && !/_sovereign\/identity/.test(part));
    assert.ok(proxied.length > 0);
    for (const location of proxied) assert.ok(location.includes(`include ${IDENTITY_SNIPPET};`), location);
  }
  const bugs = renderAppLocations(appLayout(getAppById('bug-base')));
  assert.match(bugs, /location \/bugs\/mcp\/ \{\n {4}proxy_pass http:\/\/127\.0\.0\.1:\d+\/mcp\/;\n {4}include \/etc\/nginx\/sovereign-identity\.conf;/);
  assert.match(bugs, /location = \/bugs \{\n {4}return 301 \/bugs\/;/);
});

test('the identity snippet overwrites every identity header and takes Host from Serve', () => {
  const snippet = renderIdentitySnippet();
  for (const header of ['X-Sovereign-User-Id', 'X-Sovereign-Login', 'X-Sovereign-Name', 'Tailscale-User-Login', 'Tailscale-User-Name', 'Tailscale-User-Profile-Pic', 'Host', 'X-Forwarded-Host', 'X-Forwarded-For', 'X-Forwarded-Proto']) {
    assert.match(snippet, new RegExp(`^proxy_set_header ${header} `, 'm'), header);
  }
  assert.match(snippet, /^auth_request \/_sovereign\/identity;$/m);
  assert.match(snippet, /^proxy_set_header Tailscale-User-Login "";$/m, 'apps read identity only from X-Sovereign-*');
  assert.match(snippet, /^proxy_set_header Host \$http_x_forwarded_host;$/m);
});

test('writing an app snippet removes the one named before SID-001', async () => {
  const fsImpl = createFakeFs({ '/etc/nginx/sovereign-home.d': { kind: 'dir' }, '/etc/nginx/sovereign-home.d/family-dinner.conf': '# old\n' });
  const handlers = createBaseHandlers({ fsImpl });
  const operation = { id: 'op', type: 'filesystem.write-managed-file', title: 't', risk: 'write', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], purpose: 'nginx-snippet', template: 'app-nginx-v1' };
  await handlers['filesystem.write-managed-file'](operation, { layout: appLayout(getAppById('family-dinner')) });
  assert.equal(fsImpl.existsSync('/etc/nginx/sovereign-home.d/family-dinner.conf'), false);
  assert.match(fsImpl.readFileSync('/etc/nginx/sovereign-home.d/home--family-dinner.conf'), /location \/dinner\//);
});

test('after cutover, Open links and app URLs use each app\'s service hostname (before, the host name)', () => {
  const { currentIngress, projectInstallationsWithCurrentUrls } = require('../src/app');
  const { buildEnvContext } = require('../executor/handlers');
  const config = { instance: 'smith', defaultHostname: 'host', defaultDomain: 'Example-Tailnet.ts.net' };
  const job = (id, kind, extra = {}) => ({ id, kind, status: 'completed', dryRun: false, finishedAt: `2026-10-27T10:0${id}:00Z`, ...extra });
  assert.equal(currentIngress([], config), null);
  assert.equal(currentIngress([job(1, 'ingress-cutover')], { ...config, instance: '' }), null);
  assert.deepEqual(currentIngress([job(1, 'ingress-cutover')], config), { instance: 'smith', domain: 'example-tailnet.ts.net' });
  assert.equal(currentIngress([job(1, 'ingress-cutover'), job(2, 'ingress-rollback')], config), null);
  assert.ok(currentIngress([job(1, 'ingress-cutover'), job(2, 'ingress-rollback'), job(3, 'ingress-cutover')], config));
  assert.equal(currentIngress([job(1, 'ingress-cutover', { status: 'failed' })], config), null);
  const installs = { 'family-dinner': { mountPath: '/dinner/' }, 'family-pulse': { mountPath: '/pulse/' } };
  const ingress = currentIngress([job(1, 'ingress-cutover')], config);
  assert.deepEqual(Object.values(projectInstallationsWithCurrentUrls(installs, config, ingress)).map((entry) => entry.externalUrl), ['https://smith-home.example-tailnet.ts.net/dinner/', 'https://smith-pulse.example-tailnet.ts.net/pulse/']);
  assert.equal(projectInstallationsWithCurrentUrls(installs, config, null)['family-dinner'].externalUrl, 'https://host.Example-Tailnet.ts.net/dinner/');
  const site = { hostname: 'host', domain: 'example-tailnet.ts.net', householdTimezone: 'America/New_York' };
  const pulse = appLayout(getAppById('family-pulse'));
  const ctx = (value) => buildEnvContext({ layout: pulse, site, ingress: value, databaseUrl: 'x', dbPassword: 'x', fsImpl: { existsSync: () => true } });
  assert.equal(ctx(ingress).externalUrl, 'https://smith-pulse.example-tailnet.ts.net/pulse/', 'Plaid redirect and APP_URL follow the service hostname');
  assert.equal(ctx(ingress).sovereignFontSansCssUrlLocal, 'https://smith-pulse.example-tailnet.ts.net/_sovereign/fonts/source-sans-3.css');
  assert.equal(ctx(null).externalUrl, 'https://host.example-tailnet.ts.net/pulse/');
});

test('every hostname serves the shared fonts from its own origin', () => {
  const site = blocks(renderGatewaySite(SITE));
  for (const [name, block] of Object.entries(site)) assert.match(block, /location \/_sovereign\/fonts\/ \{\n {8}alias \/opt\/sovereign-home\/assets\/fonts\/;/, name);
});
