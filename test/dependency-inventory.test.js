const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseNpmLock, parseRequirementsLock, parseDistInfoNames, normalizePythonName } = require('../src/operations/lockfiles');
const { createDependencyInventoryReader } = require('../executor/dependency-inventory');
const { createFakeFs } = require('./fixtures/fake-fs');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'lockfiles', name), 'utf8');
const SOVEREIGN = { uid: 990, gid: 990 };

test('npm lockfiles become production [name, version] pairs', () => {
  const { packages, unpinned } = parseNpmLock(fixture('family-dinner.package-lock.json'));
  assert.deepEqual(unpinned, []);
  assert.ok(packages.some(([name, version]) => name === 'express' && version === '4.22.1'));
  assert.ok(packages.every(([name, version]) => typeof name === 'string' && name && /^[0-9]/.test(version)));
  assert.deepEqual(packages, [...packages].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1))), 'stable order');

  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '1.0.0' },
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b/node_modules/a': { version: '2.0.0' },
      'node_modules/c/node_modules/a': { version: '2.0.0' },
      'node_modules/dev-only': { version: '1.0.0', dev: true },
      'node_modules/maybe': { version: '1.0.0', devOptional: true },
      'node_modules/@img/sharp-darwin-arm64': { version: '0.33.5', optional: true, os: ['darwin'] },
      'node_modules/@img/sharp-linux-x64': { version: '0.33.5', optional: true, os: ['linux'] },
      'node_modules/not-windows': { version: '1.0.0', os: ['!win32'] },
      'node_modules/linked': { link: true, resolved: 'packages/linked' },
      'node_modules/aliased': { name: 'real-name', version: '3.0.0' },
    },
  });
  assert.deepEqual(parseNpmLock(lock).packages, [
    ['@img/sharp-linux-x64', '0.33.5'], ['a', '1.0.0'], ['a', '2.0.0'], ['maybe', '1.0.0'], ['not-windows', '1.0.0'], ['real-name', '3.0.0'],
  ]);
});

test('lockfile v1 nested dependencies are read too, and malformed lockfiles are refused', () => {
  const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } }, d: { version: '1.0.0', dev: true } } });
  assert.deepEqual(parseNpmLock(v1).packages, [['a', '1.0.0'], ['b', '2.0.0']]);
  assert.throws(() => parseNpmLock('{not json'), /not valid JSON/);
  assert.throws(() => parseNpmLock('{"lockfileVersion":3}'), /lists no packages/);
});

test('requirements locks keep exact pins and report everything else as unpinned', () => {
  const helm = parseRequirementsLock(fixture('helm.requirements.lock'));
  assert.equal(helm.packages.length, 80);
  assert.deepEqual(helm.unpinned, []);
  assert.ok(helm.packages.some(([name, version]) => name === 'aiohttp' && version === '3.14.1'));

  const text = [
    '# comment',
    '--index-url https://pypi.org/simple',
    '-e .',
    'Jinja2==3.1.6 \\',
    '    --hash=sha256:aaaa \\',
    '    --hash=sha256:bbbb',
    'requests[socks]==2.32.4 ; python_version >= "3.9"  # inline comment',
    'zope.interface===7.2',
    'pandas>=2.0',
    'yfinance',
    'pkg @ https://example.com/pkg.tar.gz',
  ].join('\n');
  const parsed = parseRequirementsLock(text);
  assert.deepEqual(parsed.packages, [['jinja2', '3.1.6'], ['requests', '2.32.4'], ['zope-interface', '7.2']]);
  assert.deepEqual(parsed.unpinned, ['pandas', 'pkg', 'yfinance']);
});

test('virtualenv dist-info names become installed versions', () => {
  assert.deepEqual(parseDistInfoNames(['pandas-2.2.3.dist-info', 'pandas', 'python_dotenv-1.1.0.dist-info', 'zope.interface-7.2.dist-info', '__pycache__', 'pip-25.0.dist-info']).packages,
    [['pandas', '2.2.3'], ['pip', '25.0'], ['python-dotenv', '1.1.0'], ['zope-interface', '7.2']]);
  assert.equal(normalizePythonName('Python_Dotenv'), 'python-dotenv');
});

function reader(files) {
  return createDependencyInventoryReader({
    fsImpl: createFakeFs(files),
    lookupUser: (name) => (name === 'sovereign' ? SOVEREIGN : null),
    asUser: (user, fn) => { assert.equal(user, SOVEREIGN, 'checkout reads run as sovereign'); return fn(); },
    now: () => Date.parse('2026-10-22T12:00:00Z'),
  });
}
const dir = { kind: 'dir', uid: 990 };

test('the executor inventories a node app from its package-lock.json', () => {
  const result = reader({ '/opt/sovereign-home/apps/familyDinner': dir, '/opt/sovereign-home/apps/familyDinner/package-lock.json': fixture('family-dinner.package-lock.json') })({ appId: 'family-dinner' });
  assert.equal(result.ecosystem, 'npm');
  assert.equal(result.source, 'package-lock.json');
  assert.equal(result.pinned, true);
  assert.ok(result.packages.length > 50);
  assert.ok(JSON.stringify(result).length < 64 * 1024, 'fits one executor protocol line');
});

test('a pinned python app is read from its requirements lock', () => {
  const result = reader({ '/opt/sovereign-home/apps/helm': dir, '/opt/sovereign-home/apps/helm/requirements.lock': fixture('helm.requirements.lock') })({ appId: 'helm' });
  assert.deepEqual([result.ecosystem, result.source, result.pinned, result.packages.length], ['PyPI', 'requirements.lock', true, 80]);
});

test('an app with no lockfile is inventoried from its virtualenv and marked unpinned', () => {
  const site = '/opt/sovereign-home/apps/bitcoinAccounting/.venv/lib/python3.12/site-packages';
  const result = reader({
    '/opt/sovereign-home/apps/bitcoinAccounting': dir,
    '/opt/sovereign-home/apps/bitcoinAccounting/.venv/lib/python3.12': dir,
    [site]: dir,
    [`${site}/pandas-2.2.3.dist-info`]: dir,
    [`${site}/requests-2.32.4.dist-info`]: dir,
    [`${site}/pandas`]: dir,
  })({ appId: 'bitcoin-accounting' });
  assert.deepEqual([result.source, result.pinned], ['installed virtualenv', false]);
  assert.deepEqual(result.packages, [['pandas', '2.2.3'], ['requests', '2.32.4']]);
  assert.match(result.note, /reinstall may resolve different ones/);

  const noVenv = reader({ '/opt/sovereign-home/apps/bitcoinAccounting': dir })({ appId: 'bitcoin-accounting' });
  assert.deepEqual([noVenv.source, noVenv.pinned, noVenv.packages], [null, false, []]);
});

test('missing lockfiles, planted symlinks, missing checkouts, and unmanaged apps are handled', () => {
  const missing = reader({ '/opt/sovereign-home/apps/familyDinner': dir })({ appId: 'family-dinner' });
  assert.deepEqual([missing.source, missing.pinned], [null, false]);
  assert.match(missing.note, /No readable package-lock\.json/);

  const planted = reader({ '/opt/sovereign-home/apps/familyDinner': dir, '/opt/sovereign-home/apps/familyDinner/package-lock.json': { kind: 'link', target: '/etc/shadow' } })({ appId: 'family-dinner' });
  assert.equal(planted.source, null, 'a symlinked lockfile is never followed');

  assert.throws(() => reader({})({ appId: 'family-dinner' }), (error) => error.code === 'NOT_INSTALLED');
  assert.throws(() => reader({})({ appId: 'not-an-app' }), (error) => error.code === 'POLICY_DENIED');
  assert.throws(() => reader({ '/opt/sovereign-home/apps/familyDinner': dir, '/opt/sovereign-home/apps/familyDinner/package-lock.json': '{oops' })({ appId: 'family-dinner' }), (error) => error.code === 'OPERATION_FAILED');
});
