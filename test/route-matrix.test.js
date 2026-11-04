// Feature-10 SID-006: the route matrix (src/route-matrix.js). It covers every route the handlers serve and
// nothing else, and with the household directory on, every administrator route refuses anyone but the
// unlocked administrator before its handler runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { MATRIX, routeFor } = require('../src/route-matrix');
const { HOMEBASE, KID, PARENT, PASSPHRASE, activeHousehold, browser } = require('./support/household');
const { createAuthenticator } = require('./support/authenticator');

const ROOT = path.join(__dirname, '..');
const HANDLERS = ['src/app.js', 'src/ingress-routes.js', 'src/identity/directory-routes.js'];

// A path a source regex accepts: each group filled with the first sample it takes, an optional group both
// ways.
function samplesOf(source) {
  const body = source.replace(/^\^/, '').replace(/\$$/, '');
  const whole = new RegExp(`^${body}$`);
  const fills = ['1', 'm_1', 'abc', 'svc'];
  let variants = [body];
  for (;;) {
    const next = variants[0].match(/\((?:[^()\\]|\\.)*\)\??|\[\^\/\]\+|\\d\+/);
    if (!next) break;
    const [group] = next;
    const inner = group.startsWith('(') ? group.replace(/\?$/, '').slice(1, -1) : group;
    const fill = inner.startsWith('\\/') ? inner.replace(/\\\//g, '/') : fills.find((value) => new RegExp(`^${inner}$`).test(value));
    assert.ok(fill !== undefined, `no sample for ${group} in ${source}`);
    variants = variants.flatMap((variant) => (group.endsWith('?') ? [variant.replace(group, fill), variant.replace(group, '')] : [variant.replace(group, fill)]));
  }
  const paths = variants.map((variant) => variant.replace(/\\\//g, '/').replace(/\\\./g, '.'));
  for (const sample of paths) assert.ok(whole.test(sample), `${sample} is not a sample of ${source}`);
  return paths;
}

// Every route a handler answers, read from the source: { method, path, where }.
function handledRoutes() {
  const found = [];
  for (const file of HANDLERS) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const where = `${file}:${index + 1}`;
      const near = lines.slice(index, index + 3).join(' ');
      const blockMethod = () => {
        for (let up = index; up >= Math.max(0, index - 15); up -= 1) {
          const opened = lines[up].match(/if \(method === '([A-Z]+)'\) \{/);
          if (opened) return opened[1];
        }
        return null;
      };
      for (const match of line.matchAll(/(?:method === '([A-Z]+)' && )?(?:pathname|normalizedPath) === '(\/[^']*)'/g)) {
        found.push({ method: match[1] || blockMethod(), path: match[2], where });
      }
      for (const match of line.matchAll(/(?:pathname|normalizedPath)\.match\(\/(.+?)\/\)/g)) {
        const method = near.match(/method === '([A-Z]+)'/)?.[1];
        for (const sample of samplesOf(match[1])) found.push({ method, path: sample, where });
      }
      for (const match of line.matchAll(/\/(\^.+?\$)\/\.test\(normalizedPath\)/g)) {
        for (const sample of samplesOf(match[1])) found.push({ method: blockMethod(), path: sample, where });
      }
    });
  }
  // The passkey service names its routes after its mount.
  const passkeys = fs.readFileSync(path.join(ROOT, 'src/identity/passkey-routes.js'), 'utf8');
  for (const match of passkeys.matchAll(/'(GET|POST) ([a-z/.-]+)'/g)) {
    found.push({ method: match[1], path: `/_sovereign/auth/${match[2]}`, where: 'src/identity/passkey-routes.js' });
  }
  return found.filter((route, index) => found.findIndex((other) => other.method === route.method && other.path === route.path) === index);
}

test('every route a handler serves has a matrix entry, and every entry has a handler', () => {
  const handled = handledRoutes();
  assert.ok(handled.length > 60, `found only ${handled.length} routes; the source scan has stopped seeing them`);
  for (const route of handled) {
    assert.ok(route.method, `${route.where}: no method found for ${route.path}`);
    const entry = routeFor(route.method, route.path);
    assert.ok(entry && entry.path !== '<static file>', `${route.method} ${route.path} (${route.where}) has no route-matrix entry: add it to src/route-matrix.js`);
  }
  for (const entry of MATRIX) {
    assert.ok(handled.some((route) => route.method === entry.method && entry.pattern.test(route.path)), `matrix entry ${entry.method} ${entry.path} has no handler`);
  }
});

test('every entry is classified: public, member self-service or administrator, with its policy and authority', () => {
  const policies = require('sovereign-auth').POLICY.policies;
  for (const entry of MATRIX) {
    if (entry.class === 'public') {
      assert.equal(entry.policy, null, `${entry.method} ${entry.path}`);
      continue;
    }
    assert.ok(Object.hasOwn(policies, entry.policy), `${entry.method} ${entry.path}: no policy ${entry.policy}`);
    assert.ok(['session', 'route'].includes(entry.authority));
    // Member self-service decides for itself, by the caller's stable user ID.
    if (entry.class === 'self') assert.equal(entry.authority, 'route', `${entry.method} ${entry.path}`);
  }
  // Nothing public writes, except locking your own browser.
  assert.deepEqual(MATRIX.filter((entry) => entry.class === 'public' && entry.method !== 'GET').map((entry) => entry.path), ['/api/admin/lock']);
});

test('a request no entry covers is refused before any handler', () => {
  assert.equal(routeFor('GET', '/api/nope'), null);
  assert.equal(routeFor('DELETE', '/api/state'), null);
  assert.equal(routeFor('POST', '/api/state'), null);
  assert.equal(routeFor('GET', '/_sovereign/identity'), null);
  assert.equal(routeFor('GET', '/api/theme.js'), null, 'nothing under /api/ is a static file');
  assert.equal(routeFor('GET', '/theme.js').class, 'public');
  assert.equal(routeFor('GET', '/_sovereign/fonts/inter.woff2').class, 'public');
  assert.equal(routeFor('HEAD', '/api/state').path, '/api/state');
});

// A concrete path for an entry.
const sampleFor = (entry) => entry.path.replace(':id', /^\/(api\/)?jobs/.test(entry.path) ? '1' : entry.path.startsWith('/api/directory/members') ? 'm_1' : 'sample');

test('directory on: every administrator route refuses a member and the locked administrator before its handler', async (t) => {
  const { app, base, parent, snapshot } = await activeHousehold(t);
  app.directory.lookup('1002', { login: 'kid@example.com', name: 'Kid' });
  const memberId = (await parent.post('/api/directory/members', { userId: '1002', role: 'kid' })).body.memberId;
  const { code } = (await parent.post(`/api/directory/members/${memberId}/grant`)).body;
  const kid = browser(base, KID);
  const tablet = createAuthenticator();
  assert.equal((await kid.enroll(tablet, { label: 'Tablet', grant: code })).status, 201);
  assert.equal((await kid.check(tablet)).status, 200, 'the kid has checked in: a member at their strongest');
  const locked = browser(base, PARENT);
  const generation = () => snapshot().generation;

  const guarded = MATRIX.filter((entry) => entry.class === 'administrator' && entry.authority === 'session');
  assert.ok(guarded.length > 50);
  const before = generation();
  for (const entry of guarded) {
    const url = sampleFor(entry);
    for (const [who, client] of [['member', kid], ['locked administrator', locked]]) {
      const res = entry.method === 'GET' ? await client.get(url) : await client.post(url, { dryRun: true });
      assert.equal(res.status, 401, `${who}: ${entry.method} ${url} answered ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'ADMIN_UNLOCK_REQUIRED', `${who}: ${entry.method} ${url}`);
    }
  }
  assert.equal(generation(), before, 'nothing changed');

  // The unlocked administrator gets past the matrix on every one (what the handler then says is its own).
  for (const entry of guarded) {
    const url = sampleFor(entry);
    const res = entry.method === 'GET' ? await parent.get(url).catch(() => ({ status: 200, body: {} })) : await parent.post(url, { dryRun: true });
    assert.notEqual(res.body?.code, 'ADMIN_UNLOCK_REQUIRED', `${entry.method} ${url}`);
  }
});

test('directory on: a member reaches the pages, their own passkeys and their own view of the directory', async (t) => {
  const { app, base, parent } = await activeHousehold(t);
  app.directory.lookup('1002', { login: 'kid@example.com', name: 'Kid' });
  await parent.post('/api/directory/members', { userId: '1002', role: 'kid' });
  const kid = browser(base, KID);
  for (const entry of MATRIX.filter((route) => route.class === 'public' && route.method === 'GET')) {
    const res = await fetch(`${base}${sampleFor(entry)}`, { headers: { 'x-forwarded-for': KID, 'x-forwarded-host': HOMEBASE } });
    assert.ok([200, 302].includes(res.status), `${entry.path}: ${res.status}`);
  }
  assert.equal((await kid.get('/_sovereign/auth/status')).status, 200);
  assert.deepEqual(Object.keys((await kid.get('/api/directory')).body).sort(), ['caller', 'state'], 'their own view, not the household');
  assert.equal((await kid.get('/api/admin/status')).body.unlocked, false);
  const unknown = await kid.get('/api/nope');
  assert.equal(unknown.status, 404);
  assert.equal((await parent.post('/api/nope', {})).status, 404, 'unknown to the administrator too');
});

test('directory on: opening admin is the passphrase\'s and the passkey\'s, not the session\'s', async (t) => {
  const { base, parent } = await activeHousehold(t);
  const locked = browser(base, PARENT);
  // The routes that open admin are reachable while locked, and decide for themselves.
  assert.notEqual((await locked.post('/api/directory/recovery', { passphrase: 'wrong passphrase' })).body.code, 'ADMIN_UNLOCK_REQUIRED');
  assert.equal((await locked.post('/api/directory/recovery', { passphrase: 'wrong passphrase' })).status, 403);
  assert.equal((await locked.post('/api/admin/unlock', { passphrase: PASSPHRASE })).status, 409, 'active Home Base opens admin with a passkey, not the passphrase');
  assert.equal((await parent.get('/api/admin/status')).body.unlocked, true);
});
