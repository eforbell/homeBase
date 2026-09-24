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
