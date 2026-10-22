const test = require('node:test');
const assert = require('node:assert/strict');
const { createFoundationStatusCollector, managedUnits, parseAptSimulation, parseAptConfig, parseListSource, parseUnitPids, replacedFiles } = require('../executor/foundation-status');
const { isApprovedBinary } = require('../executor/spawn');
const { nodeLifecycle, pythonLifecycle, parseVersion, REVIEWED_AT } = require('../src/operations/runtime-lifecycle');
const { createFakeFs } = require('./fixtures/fake-fs');
const fs = require('fs');
const path = require('path');

const cert = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'certs', `${name}.pem`), 'utf8');
const G1 = cert('emsign-root-ca-g1');
const G3 = cert('emsign-ecc-root-ca-g3');

const NOW = Date.parse('2026-10-22T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const DPKG = 'nodejs\t24.10.0-1nodesource1\tii \npython3\t3.12.3-0ubuntu2.1\tii \nunattended-upgrades\t2.9.1+nmu4ubuntu1\tii \n';
const APT_SIM = [
  'NOTE: This is only a simulation!',
  'Inst libssl3t64 [3.0.13-0ubuntu3.5] (3.0.13-0ubuntu3.6 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
  'Inst nodejs [24.10.0-1nodesource1] (24.11.0-1nodesource1 . nodistro:nodistro [amd64])',
  'Inst tzdata [2025b-0ubuntu0.24.04] (2025c-0ubuntu0.24.04 Ubuntu:24.04/noble-updates [all])',
  'Conf libssl3t64 (3.0.13-0ubuntu3.6 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
].join('\n');
const APT_CONFIG = [
  'APT::Periodic::Update-Package-Lists "1";',
  'APT::Periodic::Unattended-Upgrade "1";',
  'Unattended-Upgrade::Allowed-Origins "";',
  'Unattended-Upgrade::Allowed-Origins:: "${distro_id}:${distro_codename}";',
  'Unattended-Upgrade::Allowed-Origins:: "${distro_id}:${distro_codename}-security";',
].join('\n');
const SYSTEMCTL = 'Id=homebase.service\nMainPID=101\n\nId=homebase-executor.service\nMainPID=102\n\nId=family-dinner.service\nMainPID=0\n';
const MAPS_CURRENT = '55d0 r-xp 00000000 08:01 11 /usr/bin/node\n7f00 r-xp 00000000 08:01 12 /usr/lib/x86_64-linux-gnu/libssl.so.3\n';
const MAPS_STALE = '55d0 r-xp 00000000 08:01 11 /usr/bin/node (deleted)\n7f00 r-xp 00000000 08:01 12 /usr/lib/x86_64-linux-gnu/libssl.so.3 (deleted)\n7f10 rw-s 00000000 00:01 13 /memfd:v8 (deleted)\n';

function stubRun(outputs, calls = []) {
  return async (input) => {
    calls.push(input);
    const key = input.binary.split('/').pop();
    const output = outputs[key];
    if (output instanceof Error) throw output;
    return { stdout: output ?? '', stderr: '' };
  };
}

function hostFs(extra = {}) {
  return createFakeFs({
    '/var/lib/apt/lists/archive.ubuntu.com_ubuntu_dists_noble_InRelease': { kind: 'file', content: '', mtimeMs: NOW - 2 * DAY },
    '/var/lib/apt/lists/archive.ubuntu.com_ubuntu_dists_noble_main_binary-amd64_Packages': { kind: 'file', content: '', mtimeMs: NOW - 40 * DAY },
    '/var/lib/apt/periodic/update-success-stamp': { kind: 'file', content: '', mtimeMs: NOW },
    '/etc/ssl/certs/ca-certificates.crt': G1,
    '/proc/101/exe': { kind: 'link', target: '/usr/bin/node' },
    '/proc/101/maps': MAPS_CURRENT,
    '/proc/102/exe': { kind: 'link', target: '/usr/bin/node (deleted)' },
    '/proc/102/maps': MAPS_STALE,
    ...extra,
  });
}

test('foundation status runs only fixed, approved, read-only commands', async () => {
  const calls = [];
  const collect = createFoundationStatusCollector({
    now: () => NOW,
    fsImpl: hostFs(),
    run: stubRun({ 'dpkg-query': DPKG, 'apt-get': APT_SIM, 'apt-config': APT_CONFIG, systemctl: SYSTEMCTL }, calls),
  });
  await collect();
  assert.deepEqual(calls.map((call) => call.binary), ['/usr/bin/dpkg-query', '/usr/bin/apt-get', '/usr/bin/apt-config', '/usr/bin/systemctl']);
  for (const call of calls) {
    assert.equal(call.uid, 0);
    assert.ok(isApprovedBinary(call.binary, call.uid, call.gid), `${call.binary} is on the executor allowlist`);
  }
  const apt = calls.find((call) => call.binary === '/usr/bin/apt-get');
  assert.deepEqual(apt.args, ['-s', '-o', 'Debug::NoLocking=1', 'dist-upgrade'], 'a simulation only; never update, upgrade, or install');
  assert.deepEqual(calls.find((call) => call.binary === '/usr/bin/apt-config').args, ['dump']);
  assert.deepEqual(calls.find((call) => call.binary === '/usr/bin/systemctl').args.slice(0, 4), ['show', '--property=Id', '--property=MainPID', '--']);
});

test('foundation status reports runtimes, pending security updates, and NodeSource outside automatic updates', async () => {
  const { checks, lifecycleReviewedAt } = await createFoundationStatusCollector({
    now: () => NOW,
    fsImpl: hostFs(),
    run: stubRun({ 'dpkg-query': DPKG, 'apt-get': APT_SIM, 'apt-config': APT_CONFIG, systemctl: SYSTEMCTL }),
  })();
  assert.equal(lifecycleReviewedAt, REVIEWED_AT);
  assert.equal(checks['node-runtime'].level, 'ok');
  assert.equal(checks['node-runtime'].version, '24.10.0');
  assert.equal(checks['node-runtime'].origin, 'nodesource');
  assert.equal(checks['node-runtime'].eol, '2028-04-30');
  assert.equal(checks['python-runtime'].version, '3.12.3');
  assert.equal(checks['python-runtime'].level, 'ok');

  assert.equal(checks['pending-updates'].level, 'fail');
  assert.equal(checks['pending-updates'].total, 3);
  assert.equal(checks['pending-updates'].security, 1);
  assert.deepEqual(checks['pending-updates'].runtimes.map((entry) => entry.name), ['libssl3t64', 'nodejs']);

  assert.equal(checks['apt-lists'].level, 'ok');
  assert.equal(checks['apt-lists'].ageDays, 0, 'the update-success stamp counts, not only Release files');

  assert.equal(checks['automatic-updates'].level, 'warn');
  assert.equal(checks['automatic-updates'].enabled, true);
  assert.equal(checks['automatic-updates'].coversNodeSource, false);
  assert.match(checks['automatic-updates'].summary, /NodeSource/);
  assert.match(checks['automatic-updates'].hint, /origin=\. nodistro/);

  assert.equal(checks['reboot-required'].level, 'ok');

  assert.equal(checks['stale-processes'].level, 'warn');
  assert.equal(checks['stale-processes'].inspected, 2, 'units without a main process are skipped');
  assert.deepEqual(checks['stale-processes'].stale, [{ unit: 'homebase-executor.service', pid: 102, replaced: ['/usr/bin/node', '/usr/lib/x86_64-linux-gnu/libssl.so.3'] }]);
  assert.match(checks['stale-processes'].summary, /restart homebase-executor\.service/);
  assert.equal(checks['stale-processes'].hint, 'sudo systemctl restart homebase-executor.service');
});

test('a patched, current host is all ok', async () => {
  const fsImpl = hostFs({ '/proc/102/exe': { kind: 'link', target: '/usr/bin/node' }, '/proc/102/maps': MAPS_CURRENT });
  const { checks } = await createFoundationStatusCollector({
    now: () => NOW,
    fsImpl,
    // Not the test runner's own Node.js: its built-in roots vary by release (v26.5.0 still has G3).
    nodeRoots: () => [G1],
    run: stubRun({ 'dpkg-query': DPKG, 'apt-get': 'NOTE: This is only a simulation!\n', 'apt-config': `${APT_CONFIG}\nUnattended-Upgrade::Origins-Pattern:: "origin=. nodistro";`, systemctl: SYSTEMCTL }),
  })();
  for (const [name, entry] of Object.entries(checks)) {
    assert.equal(entry.level, 'ok', `${name}: ${entry.summary}`);
    assert.ok(!entry.hint, `${name} has no next step when it is ok`);
  }
  assert.equal(checks['automatic-updates'].coversNodeSource, true);
});

test('stale lists, a pending reboot, a missing unattended-upgrades, and an end-of-life Node.js are flagged', async () => {
  const fsImpl = hostFs({
    '/var/lib/apt/lists/archive.ubuntu.com_ubuntu_dists_noble_InRelease': { kind: 'file', content: '', mtimeMs: NOW - 30 * DAY },
    '/var/lib/apt/periodic/update-success-stamp': { kind: 'file', content: '', mtimeMs: NOW - 30 * DAY },
    '/var/run/reboot-required': '*** System restart required ***\n',
    '/var/run/reboot-required.pkgs': 'linux-image-6.8.0-90-generic\nlibc6\n',
  });
  const calls = [];
  const { checks } = await createFoundationStatusCollector({
    now: () => NOW,
    fsImpl,
    run: stubRun({ 'dpkg-query': 'nodejs\t20.19.0-1nodesource1\tii \npython3\t3.10.12-1~22.04\tii \n', 'apt-get': '', systemctl: '' }, calls),
  })();
  assert.equal(checks['apt-lists'].level, 'warn');
  assert.equal(checks['apt-lists'].ageDays, 30);
  assert.equal(checks['reboot-required'].level, 'warn');
  assert.deepEqual(checks['reboot-required'].packages, ['linux-image-6.8.0-90-generic', 'libc6']);
  assert.equal(checks['automatic-updates'].level, 'warn');
  assert.equal(checks['automatic-updates'].installed, false);
  assert.ok(!calls.some((call) => call.binary === '/usr/bin/apt-config'), 'no config read when the package is absent');
  assert.equal(checks['node-runtime'].level, 'fail');
  assert.match(checks['node-runtime'].summary, /end of life on 2026-04-30/);
  assert.equal(checks['python-runtime'].level, 'warn', 'Python 3.10 upstream end of life is days away');
});

test('probe failures degrade to unknown instead of failing the whole report', async () => {
  const broken = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  const { checks } = await createFoundationStatusCollector({
    now: () => NOW,
    fsImpl: createFakeFs(),
    run: stubRun({ 'dpkg-query': broken, 'apt-get': broken, 'apt-config': broken, systemctl: broken }),
  })();
  assert.equal(checks['pending-updates'].level, 'unknown');
  assert.equal(checks['apt-lists'].level, 'unknown');
  assert.equal(checks['automatic-updates'].level, 'unknown');
  assert.equal(checks['stale-processes'].level, 'unknown');
  assert.equal(checks['python-runtime'].level, 'unknown');
  // A failed package probe proves nothing about the host's Node.js: unknown, not the executor's version.
  assert.equal(checks['node-runtime'].level, 'unknown');
  assert.equal(checks['node-runtime'].version, null);
});

test('only a Node.js that dpkg reports absent falls back to the running version', async () => {
  const { checks } = await createFoundationStatusCollector({ now: () => NOW, fsImpl: hostFs(), run: stubRun({ 'dpkg-query': 'python3\t3.12.3-0ubuntu2.1\tii \n', 'apt-get': '', 'apt-config': APT_CONFIG, systemctl: SYSTEMCTL }) })();
  assert.equal(checks['node-runtime'].origin, 'unpackaged');
  assert.equal(checks['node-runtime'].version, process.versions.node);
});

test('units whose processes cannot be read are unknown, never a false "current"', async () => {
  const denied = (target) => Object.assign(new Error(`EACCES: ${target}`), { code: 'EACCES' });
  const deny = (fsImpl, pids) => {
    const { readlinkSync } = fsImpl;
    fsImpl.readlinkSync = (target) => { if (pids.some((pid) => target === `/proc/${pid}/exe`)) throw denied(target); return readlinkSync(target); };
    return fsImpl;
  };
  const collect = (fsImpl) => createFoundationStatusCollector({ now: () => NOW, fsImpl, run: stubRun({ 'dpkg-query': DPKG, 'apt-get': '', 'apt-config': APT_CONFIG, systemctl: SYSTEMCTL }) })();
  const currentFs = () => hostFs({ '/proc/102/exe': { kind: 'link', target: '/usr/bin/node' }, '/proc/102/maps': MAPS_CURRENT });

  const none = (await collect(deny(currentFs(), [101, 102]))).checks['stale-processes'];
  assert.equal(none.level, 'unknown', 'zero inspected units is not evidence of freshness');
  assert.equal(none.inspected, 0);
  assert.deepEqual(none.unreadable, ['homebase.service', 'homebase-executor.service']);

  const some = (await collect(deny(currentFs(), [101]))).checks['stale-processes'];
  assert.equal(some.level, 'unknown', 'one unreadable unit keeps the check from passing');
  assert.match(some.summary, /homebase\.service/);

  const mixed = (await collect(deny(hostFs(), [101]))).checks['stale-processes'];
  assert.equal(mixed.level, 'warn', 'a confirmed stale unit still warns');
  assert.match(mixed.summary, /1 more could not be inspected/);

  const exited = currentFs();
  exited.entries.delete('/proc/101/exe');
  exited.entries.delete('/proc/101/maps');
  const gone = (await collect(exited)).checks['stale-processes'];
  assert.equal(gone.level, 'ok', 'a process that exited since systemctl answered is skipped');
  assert.equal(gone.inspected, 1);
});

test('a stale security or NodeSource list is flagged even when other lists are fresh', async () => {
  const lists = (extra) => hostFs({
    '/var/lib/apt/lists/archive.ubuntu.com_ubuntu_dists_noble_InRelease': { kind: 'file', content: '', mtimeMs: Date.parse('2024-04-25T15:11:21Z') },
    '/var/lib/apt/lists/archive.ubuntu.com_ubuntu_dists_noble-updates_InRelease': { kind: 'file', content: '', mtimeMs: NOW },
    '/var/lib/apt/lists/security.ubuntu.com_ubuntu_dists_noble-security_InRelease': { kind: 'file', content: '', mtimeMs: NOW - DAY },
    '/var/lib/apt/lists/deb.nodesource.com_node%5f24.x_dists_nodistro_InRelease': { kind: 'file', content: '', mtimeMs: NOW - 3 * DAY },
    ...extra,
  });
  const collect = (fsImpl) => createFoundationStatusCollector({ now: () => NOW, fsImpl, run: stubRun({ 'dpkg-query': DPKG, 'apt-get': '', 'apt-config': APT_CONFIG, systemctl: SYSTEMCTL }) })();

  const fresh = (await collect(lists())).checks['apt-lists'];
  assert.equal(fresh.level, 'ok', 'the frozen release pocket is old by design and not judged');
  assert.equal(fresh.sources.length, 4);

  const security = (await collect(lists({ '/var/lib/apt/lists/security.ubuntu.com_ubuntu_dists_noble-security_InRelease': { kind: 'file', content: '', mtimeMs: NOW - 12 * DAY } }))).checks['apt-lists'];
  assert.equal(security.level, 'warn');
  assert.deepEqual(security.staleSources, [{ host: 'security.ubuntu.com', suite: 'noble-security', ageDays: 12 }]);
  assert.match(security.summary, /security\.ubuntu\.com noble-security \(12 days\) is out of date/);

  const nodesource = (await collect(lists({ '/var/lib/apt/lists/deb.nodesource.com_node%5f24.x_dists_nodistro_InRelease': { kind: 'file', content: '', mtimeMs: NOW - 50 * DAY } }))).checks['apt-lists'];
  assert.equal(nodesource.level, 'warn');
  assert.deepEqual(nodesource.staleSources.map((source) => source.host), ['deb.nodesource.com']);
});

test('dpkg-query output is still used when it exits non-zero for an unknown package', async () => {
  const partial = Object.assign(new Error('exit 1'), { code: 'OPERATION_FAILED', output: { stdout: 'nodejs\t22.20.0-1nodesource1\tii \n' } });
  const { checks } = await createFoundationStatusCollector({ now: () => NOW, fsImpl: hostFs(), run: stubRun({ 'dpkg-query': partial, 'apt-get': '', systemctl: '' }) })();
  assert.equal(checks['node-runtime'].version, '22.20.0');
  assert.equal(checks['python-runtime'].level, 'ok');
  assert.match(checks['python-runtime'].summary, /not installed/);
});

test('results are cached briefly so the Status page does not re-run the apt simulation', async () => {
  let clock = NOW;
  const calls = [];
  const collect = createFoundationStatusCollector({ now: () => clock, fsImpl: hostFs(), run: stubRun({ 'dpkg-query': DPKG, 'apt-get': '', 'apt-config': APT_CONFIG, systemctl: '' }, calls) });
  await collect();
  await collect();
  assert.equal(calls.filter((call) => call.binary === '/usr/bin/apt-get').length, 1);
  clock += 11 * 1000;
  await collect();
  assert.equal(calls.filter((call) => call.binary === '/usr/bin/apt-get').length, 2);
});

test('parsers handle real apt, apt-config, systemctl, and /proc shapes', () => {
  assert.deepEqual(parseAptSimulation('Inst libc6 [2.36-9+deb12u9] (2.36-9+deb12u10 Debian-Security:12/stable-security [amd64]) []'), [{ name: 'libc6', from: '2.36-9+deb12u9', to: '2.36-9+deb12u10', security: true }]);
  assert.deepEqual(parseAptSimulation('Inst newpkg (1.0-1 Debian:12.12/stable [all])'), [{ name: 'newpkg', from: null, to: '1.0-1', security: false }]);
  assert.deepEqual(parseAptConfig('APT::Periodic::Unattended-Upgrade "0";'), { enabled: false, origins: [] });
  assert.deepEqual(parseListSource('deb.nodesource.com_node%5f24.x_dists_nodistro_InRelease'), { host: 'deb.nodesource.com', suite: 'nodistro', kind: 'nodesource' });
  assert.deepEqual(parseListSource('security.ubuntu.com_ubuntu_dists_noble-security_InRelease'), { host: 'security.ubuntu.com', suite: 'noble-security', kind: 'security' });
  assert.deepEqual(parseListSource('deb.debian.org_debian-security_dists_bookworm-security_InRelease'), { host: 'deb.debian.org', suite: 'bookworm-security', kind: 'security' });
  assert.deepEqual(parseListSource('archive.ubuntu.com_ubuntu_dists_noble_InRelease'), { host: 'archive.ubuntu.com', suite: 'noble', kind: 'other' });
  assert.equal(parseListSource('archive.ubuntu.com_ubuntu_dists_noble_main_binary-amd64_Packages'), null);
  assert.deepEqual(parseUnitPids('MainPID=7\nId=a.service\n\nId=b.service\nMainPID=0'), [{ unit: 'a.service', pid: 7 }]);
  assert.deepEqual(replacedFiles('/usr/bin/python3.12', '7f r-xp 0 08:01 9 /tmp/ffi1234 (deleted)\n7f r-xp 0 08:01 9 /usr/lib/python3.12/lib-dynload/_ssl.cpython-312-x86_64-linux-gnu.so (deleted)\n'), ['/usr/lib/python3.12/lib-dynload/_ssl.cpython-312-x86_64-linux-gnu.so']);
});

test('every managed long-running unit is inspected, and only units, never timers', () => {
  const units = managedUnits();
  assert.deepEqual(units.slice(0, 2), ['homebase.service', 'homebase-executor.service']);
  assert.ok(units.includes('family-dinner.service'));
  assert.ok(units.every((unit) => /^[a-z][a-z0-9-]*\.service$/.test(unit)));
  assert.equal(new Set(units).size, units.length);
});

test('runtime lifecycle table classifies support windows', () => {
  assert.equal(parseVersion('v24.10.0').text, '24.10.0');
  assert.equal(parseVersion('3.12.3-0ubuntu2.1').text, '3.12.3');
  assert.equal(parseVersion('garbage'), null);
  assert.deepEqual(nodeLifecycle('22.20.0', Date.parse('2027-03-01T00:00:00Z')).level, 'warn');
  assert.deepEqual(nodeLifecycle('22.20.0', NOW).level, 'ok');
  assert.deepEqual(nodeLifecycle('18.20.0', NOW).level, 'fail');
  assert.deepEqual(nodeLifecycle('30.1.0', NOW).level, 'unknown', 'majors missing from the table are unknown, not supported');
  assert.deepEqual(pythonLifecycle('3.11.2', NOW).eol, '2027-10-31');
});

test('trust stores flag a distrusted root in the host bundle or Node.js built-ins, by fingerprint', async () => {
  const collect = (bundle, nodeRoots) => createFoundationStatusCollector({
    now: () => NOW,
    fsImpl: hostFs(bundle === undefined ? {} : { '/etc/ssl/certs/ca-certificates.crt': bundle }),
    run: stubRun({ 'dpkg-query': DPKG, 'apt-get': '', 'apt-config': APT_CONFIG, systemctl: SYSTEMCTL }),
    nodeRoots: () => nodeRoots,
    nodeVersion: 'v24.22.1',
  })();

  const clean = (await collect(`${G1}\n`, [G1])).checks['trust-stores'];
  assert.equal(clean.level, 'ok', 'an unaffected emSign root (G1) is not flagged');
  assert.deepEqual(clean.stores.map(({ store, certificates }) => [store, certificates]), [['host', 1], ['node', 1]]);
  assert.match(clean.summary, /No CA store here trusts a distrusted root/);

  const host = (await collect(`${G1}\n${G3}\n`, [G1])).checks['trust-stores'];
  assert.equal(host.level, 'fail');
  assert.match(host.summary, /^The host CA store still trusts emSign ECC Root CA - G3 \(eMudhra\/emSign CA incident\)/);
  assert.equal(host.stores[0].distrusted[0].sha256, '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b');
  assert.match(host.hint, /ca-certificates/);
  assert.doesNotMatch(host.hint, /Node\.js/);

  const node = (await collect(`${G1}\n`, [G1, G3])).checks['trust-stores'];
  assert.equal(node.level, 'fail');
  assert.match(node.summary, /Node\.js v24\.22\.1's built-in roots still include emSign ECC Root CA - G3/);
  assert.match(node.hint, /Upgrade Node\.js/);

  const missing = (await collect(undefined, [G1]));
  const fsMissing = createFoundationStatusCollector({ now: () => NOW, fsImpl: createFakeFs({}), run: stubRun({ 'dpkg-query': DPKG, 'apt-get': '', 'apt-config': APT_CONFIG, systemctl: '' }), nodeRoots: () => [G1] });
  assert.equal(missing.checks['trust-stores'].level, 'ok');
  assert.equal((await fsMissing()).checks['trust-stores'].level, 'unknown', 'an unreadable host bundle is unknown, never ok');
});
