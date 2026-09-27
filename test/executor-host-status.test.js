const test = require('node:test');
const assert = require('node:assert/strict');
const { createHostStatusCollector } = require('../executor/host-status');
const { GIT_DEPLOY_KEY_PATH } = require('../executor/handlers');
const { createFakeFs } = require('./fixtures/fake-fs');

const GATEWAY = {
  '/etc/nginx/sites-available/sovereign-home': 'server {}',
  '/etc/nginx/sites-enabled/sovereign-home': { kind: 'link', target: '/etc/nginx/sites-available/sovereign-home' },
};

test('host status runs only fixed read-only probes and reports a healthy host', async () => {
  const calls = [];
  const collect = createHostStatusCollector({
    fsImpl: createFakeFs({ ...GATEWAY, [GIT_DEPLOY_KEY_PATH]: { kind: 'file', content: 'k', mode: 0o600, uid: 0 } }),
    run: async (input) => { calls.push(input); return { stdout: '', stderr: 'nginx: configuration file /etc/nginx/nginx.conf test is successful' }; },
  });
  const { checks } = await collect();
  assert.deepEqual(calls.map((call) => [call.binary, call.args]), [['/usr/sbin/nginx', ['-t']]]);
  assert.equal(checks['nginx-config'].ok, true);
  assert.match(checks['nginx-config'].summary, /test is successful/);
  assert.equal(checks['nginx-gateway'].ok, true);
  assert.deepEqual(checks['git-deploy-key'], { ok: true, status: 'present' });
});

test('host status reports nginx failures, a still-enabled default site, and caches briefly', async () => {
  let clock = 0;
  let runs = 0;
  const collect = createHostStatusCollector({
    now: () => clock,
    fsImpl: createFakeFs({ ...GATEWAY, '/etc/nginx/sites-enabled/default': { kind: 'link', target: '/etc/nginx/sites-available/default' } }),
    run: async () => { runs += 1; throw Object.assign(new Error('exit 1'), { output: { stderr: 'nginx: [emerg] unknown directive "proxy_passs"' } }); },
  });
  const { checks } = await collect();
  assert.equal(checks['nginx-config'].ok, false);
  assert.match(checks['nginx-config'].summary, /proxy_passs/);
  assert.equal(checks['nginx-gateway'].ok, false);
  assert.match(checks['nginx-gateway'].summary, /default site/);
  assert.equal(checks['git-deploy-key'].status, 'missing');
  await collect();
  assert.equal(runs, 1, 'a burst of requests reuses one nginx -t');
  clock = 6000;
  await collect();
  assert.equal(runs, 2);
});

test('host status explains a missing nginx instead of a raw spawn error', async () => {
  const collect = createHostStatusCollector({ fsImpl: createFakeFs(), run: async () => { throw Object.assign(new Error('spawn /usr/sbin/nginx ENOENT'), { code: 'ENOENT' }); } });
  const { checks } = await collect();
  assert.equal(checks['nginx-config'].summary, 'nginx is not installed yet; run host bootstrap.');
});

test('an adopted host whose own server block includes the app snippets counts as a working gateway', async () => {
  const fs = require('fs');
  const path = require('path');
  const erebor = fs.readFileSync(path.join(__dirname, 'fixtures', 'nginx', 'erebor-shaped-ok.nginx-T'), 'utf8');
  const split = fs.readFileSync(path.join(__dirname, 'fixtures', 'nginx', 'erebor-shaped-split.nginx-T'), 'utf8');
  const status = (dump) => createHostStatusCollector({
    fsImpl: createFakeFs(),
    run: async (input) => ({ stdout: input.args[0] === '-T' ? dump : '', stderr: 'nginx: configuration file /etc/nginx/nginx.conf test is successful\n' }),
  })();
  const ok = (await status(erebor)).checks['nginx-gateway'];
  assert.equal(ok.ok, true);
  assert.match(ok.summary, /host's own server block \(\/etc\/nginx\/sites-enabled\/erebor\.forbell\.com\)/);
  assert.equal('managedSiteMissing' in ok, false);
  // The split layout has a block with the executor include too, so apps are still reachable there.
  assert.equal((await status(split)).checks['nginx-gateway'].ok, true);
  const bare = (await status('# configuration file /etc/nginx/nginx.conf:\nhttp {\n  server {\n    listen 80;\n  }\n}\n')).checks['nginx-gateway'];
  assert.deepEqual([bare.ok, bare.summary], [false, 'The managed nginx gateway site is not enabled.']);
});
