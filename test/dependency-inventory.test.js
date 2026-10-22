const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseNpmLock, parseRequirementsLock, parseDistInfoNames, normalizePythonName, lockDrift } = require('../src/operations/lockfiles');
const { compareVersions, evaluateFloors, FLOORS } = require('../src/operations/security-floors');
const { createDependencyInventoryReader, returnsSystemBundle } = require('../executor/dependency-inventory');
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
  assert.deepEqual([result.ecosystem, result.source, result.inventorySource, result.pinned, result.packages.length], ['PyPI', 'requirements.lock', 'lockfile', true, 80]);
  assert.match(result.note, /No virtualenv: nothing is installed to check/);
  assert.equal(result.venvMissing, true, 'a lockfile alone is a prospective reinstall, not what runs (review #6 round 2, finding 3)');
  // The real helm lock pins certifi 2026.5.20, below the emSign floor: a reinstall would bring it back.
  assert.deepEqual(result.floorFindings.map(({ name, version, where }) => [name, version, where]), [['certifi', '2026.5.20', 'lockfile']]);
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
  assert.deepEqual([result.source, result.inventorySource, result.pinned], [null, 'virtualenv', false]);
  assert.deepEqual(result.packages, [['pandas', '2.2.3'], ['requests', '2.32.4']]);
  assert.match(result.note, /reinstall may resolve different ones/);

  const noVenv = reader({ '/opt/sovereign-home/apps/bitcoinAccounting': dir })({ appId: 'bitcoin-accounting' });
  assert.deepEqual([noVenv.source, noVenv.inventorySource, noVenv.pinned, noVenv.packages], [null, null, false, []]);
});

test('missing lockfiles, planted symlinks, missing checkouts, and unmanaged apps are handled', () => {
  const missing = reader({ '/opt/sovereign-home/apps/familyDinner': dir })({ appId: 'family-dinner' });
  assert.deepEqual([missing.source, missing.inventorySource, missing.pinned], [null, null, false]);
  assert.match(missing.note, /No readable package-lock\.json/);

  const planted = reader({ '/opt/sovereign-home/apps/familyDinner': dir, '/opt/sovereign-home/apps/familyDinner/package-lock.json': { kind: 'link', target: '/etc/shadow' } })({ appId: 'family-dinner' });
  assert.equal(planted.source, null, 'a symlinked lockfile is never followed');

  assert.throws(() => reader({})({ appId: 'family-dinner' }), (error) => error.code === 'NOT_INSTALLED');
  assert.throws(() => reader({})({ appId: 'not-an-app' }), (error) => error.code === 'POLICY_DENIED');
  assert.throws(() => reader({ '/opt/sovereign-home/apps/familyDinner': dir, '/opt/sovereign-home/apps/familyDinner/package-lock.json': '{oops' })({ appId: 'family-dinner' }), (error) => error.code === 'OPERATION_FAILED');
});

const HELM = '/opt/sovereign-home/apps/helm';
const HELM_SITE = `${HELM}/.venv/lib/python3.12/site-packages`;
const venvFiles = (names, extra = {}) => ({
  [`${HELM}/.venv/lib/python3.12`]: dir,
  [HELM_SITE]: dir,
  ...Object.fromEntries(names.map((name) => [`${HELM_SITE}/${name}`, dir])),
  ...extra,
});

test('a locked python app reports what its virtualenv runs, and drift from the lockfile (review #6, finding 1)', () => {
  const result = reader({
    [HELM]: dir,
    [`${HELM}/requirements.lock`]: 'certifi==2026.10.19\nrequests==2.32.4\n',
    ...venvFiles(['certifi-2026.5.20.dist-info', 'pip-24.0.dist-info', 'requests-2.32.4.dist-info']),
  })({ appId: 'helm' });
  assert.equal(result.inventorySource, 'virtualenv');
  assert.deepEqual(result.packages, [['certifi', '2026.5.20'], ['pip', '24.0'], ['requests', '2.32.4']], 'the installed certifi, not the locked one');
  assert.deepEqual(result.drift, [{ name: 'certifi', locked: '2026.10.19', installed: '2026.5.20' }]);
  assert.equal(result.driftTotal, 1);

  const many = reader({ [HELM]: dir, [`${HELM}/requirements.lock`]: Array.from({ length: 70 }, (_, i) => `pkg${i}==1.0`).join('\n'), ...venvFiles(['pip-24.0.dist-info']) })({ appId: 'helm' });
  assert.equal(many.drift.length, 50, 'the list is capped');
  assert.equal(many.driftTotal, 70, 'the total is not');
  assert.match(result.note, /1 locked package is installed at a different version/);
  assert.deepEqual(result.floorFindings.map(({ name, version, where, hostStore }) => [name, version, where, Boolean(hostStore)]), [['certifi', '2026.5.20', 'installed', false], ['pip', '24.0', 'installed', false]]);
  assert.equal(result.pipUsesSystemStore, false);
});

test('a distribution pip that uses the host CA store is a note, not an alarm', () => {
  const result = reader({
    [HELM]: dir,
    [`${HELM}/requirements.lock`]: 'certifi==2026.10.19\n',
    ...venvFiles(['certifi-2026.10.19.dist-info', 'pip-24.0.dist-info'], {
      [`${HELM_SITE}/pip/_vendor/certifi/core.py`]: 'def where() -> str:\n    return "/etc/ssl/certs/ca-certificates.crt"\n',
    }),
  })({ appId: 'helm' });
  assert.equal(result.pipUsesSystemStore, true);
  assert.equal(result.floorFindings.length, 1);
  assert.equal(result.floorFindings[0].name, 'pip');
  assert.match(result.floorFindings[0].hostStore, /only as safe as that store/);
  assert.doesNotMatch(result.floorFindings[0].hostStore, /fixed/i, 'never presented as fixed (review #6 round 2, finding 1)');
  assert.equal(result.venvMissing, false);
  assert.deepEqual(result.drift, []);
  assert.equal(result.pinned, true);
});

test('-r includes are followed inside the checkout, and anything unreadable is never pinned (review #6, finding 2)', () => {
  const run = (files) => reader({ [HELM]: dir, ...files })({ appId: 'helm' });
  const included = run({ [`${HELM}/requirements.lock`]: '-r locks/base.lock\n', [`${HELM}/locks/base.lock`]: '-r ./more.lock\naiohttp==3.14.1\n', [`${HELM}/locks/more.lock`]: 'certifi==2026.10.19\n' });
  assert.deepEqual(included.packages, [['aiohttp', '3.14.1'], ['certifi', '2026.10.19']]);
  assert.equal(included.pinned, true);

  const missing = run({ [`${HELM}/requirements.lock`]: '-r base.lock\n' });
  assert.equal(missing.pinned, false, 'a file that is only an unreadable include is not pinned');
  assert.deepEqual(missing.unpinned, ['-r base.lock']);
  assert.match(missing.errors[0], /could not read included base\.lock/);

  const escape = run({ [`${HELM}/requirements.lock`]: '-r ../../../etc/passwd\n--requirement=/etc/shadow\n' });
  assert.equal(escape.pinned, false);
  assert.equal(escape.errors.length, 2, 'paths outside the checkout are refused');

  const planted = run({ [`${HELM}/requirements.lock`]: '-r base.lock\n', [`${HELM}/base.lock`]: { kind: 'link', target: '/etc/shadow' } });
  assert.equal(planted.pinned, false, 'a symlinked include is never followed');
});

test('requirement parser bounds includes, skips cycles and constraints, and refuses unknown options', () => {
  const files = { 'a.txt': '-r b.txt\nx==1', 'b.txt': '-r a.txt\n-c constraints.txt\ny==2' };
  const cyclic = parseRequirementsLock('-r a.txt', { readInclude: (target) => files[target] ?? null, file: 'root.txt' });
  assert.deepEqual(cyclic.packages, [['x', '1'], ['y', '2']]);
  assert.deepEqual(cyclic.errors, []);

  const deep = parseRequirementsLock('-r 1.txt', { readInclude: (target) => `-r ${Number(target.split('.')[0]) + 1}.txt\n`, limits: { depth: 3, files: 20 } });
  assert.match(deep.errors[0], /include limit reached/);

  const unknown = parseRequirementsLock('--some-new-flag\nx==1\n-e git+https://example.com/repo.git#egg=Thing\n-e .\n');
  assert.deepEqual(unknown.unpinned.sort(), ['--some-new-flag', 'thing']);
  assert.match(unknown.errors[0], /unrecognized option --some-new-flag/);
});

test('npm platform filtering applies cpu and libc as well as os (review #6, finding 3)', () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: {
    '': {},
    'node_modules/@img/sharp-linux-arm64': { version: '0.33.5', optional: true, os: ['linux'], cpu: ['arm64'] },
    'node_modules/@img/sharp-linux-x64': { version: '0.33.5', optional: true, os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
    'node_modules/@img/sharp-linuxmusl-x64': { version: '0.33.5', optional: true, os: ['linux'], cpu: ['x64'], libc: ['musl'] },
    'node_modules/not-arm': { version: '1.0.0', cpu: ['!arm'] },
  } });
  const names = (host) => parseNpmLock(lock, { host }).packages.map(([name]) => name);
  assert.deepEqual(names({ os: 'linux', cpu: 'x64', libc: 'glibc' }), ['@img/sharp-linux-x64', 'not-arm']);
  assert.deepEqual(names({ os: 'linux', cpu: 'arm64', libc: 'glibc' }), ['@img/sharp-linux-arm64', 'not-arm']);
});

test('security floors compare dotted versions and cover both installed and locked packages', () => {
  assert.equal(compareVersions('2026.5.20', '2026.10.19'), -1, 'numeric, not string, comparison');
  assert.equal(compareVersions('26.2.2', '26.2.2'), 0);
  assert.equal(compareVersions('26.10', '26.2.2'), 1);
  assert.equal(compareVersions('dev', '1.0'), null);
  assert.ok(FLOORS.every((floor) => floor.reference.startsWith('https://') && floor.since && floor.reason));
  const findings = evaluateFloors({ ecosystem: 'PyPI', installed: [['certifi', '2026.10.19']], locked: [['certifi', '2026.5.20'], ['pip', '26.2.2']] });
  assert.deepEqual(findings.map(({ name, where }) => [name, where]), [['certifi', 'lockfile']]);
  assert.deepEqual(lockDrift([['a', '1'], ['b', '2']], [['a', '1'], ['pip', '24.0']]), [{ name: 'b', locked: '2', installed: null }]);
});

test('only the app itself is a skipped editable; other local editables are unpinned (review #6 round 2, finding 2)', () => {
  const sibling = parseRequirementsLock('certifi==2026.10.19\n-e ../other-app\n-e ./vendored/pkg\n-e file:///opt/x\n-e .\n', { file: 'requirements.lock' });
  assert.deepEqual(sibling.unpinned, ['-e ../other-app', '-e ./vendored/pkg', '-e file:///opt/x']);
  const nested = parseRequirementsLock('-e ..\n-e .\n', { file: 'locks/app.txt' });
  assert.deepEqual(nested.unpinned, ['-e .'], 'from locks/, ".." is the app root and "." is not');

  const app = reader({ [HELM]: dir, [`${HELM}/requirements.lock`]: 'certifi==2026.10.19\n-e ../other-app\n', ...venvFiles(['certifi-2026.10.19.dist-info']) })({ appId: 'helm' });
  assert.equal(app.pinned, false);
});

test('nested includes resolve against the including file, after ../ too (review #6 round 2, finding 4)', () => {
  const result = reader({
    [HELM]: dir,
    [`${HELM}/requirements.lock`]: '-r locks/main.txt\n',
    [`${HELM}/locks/main.txt`]: '-r ../base.txt\naiohttp==3.14.1\n',
    [`${HELM}/base.txt`]: '-r extra.txt\ncertifi==2026.10.19\n',
    [`${HELM}/extra.txt`]: 'requests==2.32.4\n-r locks/main.txt\n',
    ...venvFiles(['aiohttp-3.14.1.dist-info', 'certifi-2026.10.19.dist-info', 'requests-2.32.4.dist-info']),
  })({ appId: 'helm' });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.packages, [['aiohttp', '3.14.1'], ['certifi', '2026.10.19'], ['requests', '2.32.4']]);
  assert.equal(result.pinned, true, 'the cycle back to locks/main.txt is detected by its canonical path');
  const parsed = parseRequirementsLock('-r locks/main.txt', { file: 'requirements.lock', readInclude: (p) => ({ 'locks/main.txt': '-r ../base.txt', 'base.txt': '-r extra.txt', 'extra.txt': 'x==1' })[p] ?? null });
  assert.deepEqual(parsed.includes, ['locks/main.txt', 'base.txt', 'extra.txt']);
});

test('only a where() that really returns the host bundle marks pip as a distribution build (review #6 round 3)', () => {
  const ubuntu = fs.readFileSync(path.join(__dirname, 'fixtures', 'pip', 'ubuntu-24.04-pip-24.0-certifi-core.py'), 'utf8');
  assert.equal(returnsSystemBundle(ubuntu), true, 'the real Ubuntu 24.04 python3-pip-whl patch');
  assert.equal(returnsSystemBundle('def where() -> str:\n    return "/etc/ssl/certs/ca-certificates.crt"\n'), true);
  // The reviewer's repro: the path only in a comment, where() still returning the bundled PEM.
  assert.equal(returnsSystemBundle('# uses /etc/ssl/certs/ca-certificates.crt on Debian\n_CACERT_PATH = None\ndef where() -> str:\n    return _CACERT_PATH\n'), false);
  assert.equal(returnsSystemBundle('DEBIAN_CA_CERTS_PATH = "/etc/ssl/certs/ca-certificates.crt"\ndef where() -> str:\n    return DEBIAN_CA_CERTS_PATH\ndef where() -> str:\n    return _CACERT_PATH\n'), false, 'the last definition wins');
  assert.equal(returnsSystemBundle('    def where() -> str:\n        return "/etc/ssl/certs/ca-certificates.crt"\n'), false, 'a nested definition is not the module where()');
  assert.equal(returnsSystemBundle(''), false);
});

test('the distrusted-root table holds only normalized SHA-256 fingerprints and rejects a typo', () => {
  const { DISTRUSTED_ROOTS, distrustedIn, storeTrust, assessPemBundle } = require('../src/operations/distrusted-roots');
  assert.ok(DISTRUSTED_ROOTS.length > 0);
  for (const root of DISTRUSTED_ROOTS) {
    assert.match(root.sha256, /^[0-9a-f]{64}$/, `${root.subject} is a lower-case SHA-256 without colons`);
    assert.match(root.reference, /^https:\/\//);
  }
  const upper = { sha256: DISTRUSTED_ROOTS[0].sha256.toUpperCase().match(/../g).join(':'), subject: 'x' };
  assert.equal(distrustedIn([DISTRUSTED_ROOTS[0].sha256], [upper]).length, 1, 'a table entry written as OpenSSL prints it still matches');
  assert.deepEqual([storeTrust(null), storeTrust({ certificates: 0, invalid: 0, distrusted: [] }), storeTrust({ certificates: 3, invalid: 1, distrusted: [] }), storeTrust({ certificates: 3, invalid: 0, distrusted: [] })], ['unknown', 'unknown', 'unknown', 'verified']);
  assert.deepEqual(assessPemBundle('no certificates here'), { certificates: 0, invalid: 0, distrusted: [] });
});
