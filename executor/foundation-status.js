const fs = require('fs');
const path = require('path');
const { runApproved } = require('./spawn');
const { INSTALLABLE_APPS } = require('./actions');
const { getAppById } = require('../src/catalog');
const { appLayout } = require('../src/operations/app-layout');
const { REVIEWED_AT, parseVersion, nodeLifecycle, pythonLifecycle } = require('../src/operations/runtime-lifecycle');

// Read-only answers to "is this host behind on runtime and OS patches?" (docs/patch-visibility-plan.md,
// stream A). Like host-status it takes no caller input: every command, path, and unit is fixed here.
// Nothing here refreshes apt lists or touches the network; freshness is reported instead.
const ENV = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' };
// Short: the web service caches for minutes; this only absorbs a burst, so a Refresh sees new state.
const CACHE_MS = 10 * 1000;
const APT_LISTS = '/var/lib/apt/lists';
const APT_UPDATE_STAMP = '/var/lib/apt/periodic/update-success-stamp';
const REBOOT_REQUIRED = '/var/run/reboot-required';
const REBOOT_REQUIRED_PKGS = '/var/run/reboot-required.pkgs';
const LISTS_STALE_DAYS = 7;
const PACKAGES = ['nodejs', 'python3', 'unattended-upgrades'];
const HOMEBASE_UNITS = ['homebase.service', 'homebase-executor.service'];
const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 10;
// The unattended-upgrades pattern for NodeSource's repository (its Release file says Origin: . nodistro).
const NODESOURCE_ORIGIN_PATTERN = 'Unattended-Upgrade::Origins-Pattern:: "origin=. nodistro";';

// Long-running units only: timer services are oneshot and start fresh on every run.
function managedUnits() {
  const units = [...HOMEBASE_UNITS];
  for (const appId of INSTALLABLE_APPS) {
    const layout = appLayout(getAppById(appId));
    units.push(layout.service.unit, ...layout.sidecars.map((sidecar) => sidecar.unit));
  }
  return units;
}

// dpkg-query exits non-zero when any name is unknown but still reports the known ones on stdout.
function parseDpkgPackages(stdout) {
  const packages = {};
  for (const line of String(stdout || '').split('\n')) {
    const [name, version, status] = line.split('\t');
    if (name && /^[hi]i$/.test(String(status || '').trim())) packages[name] = String(version || '').trim();
  }
  return packages;
}

// "Inst libssl3 [3.0.2-0ubuntu1.10] (3.0.2-0ubuntu1.12 Ubuntu:22.04/jammy-updates, Ubuntu:22.04/jammy-security [amd64])"
function parseAptSimulation(stdout) {
  const upgrades = [];
  for (const line of String(stdout || '').split('\n')) {
    const match = /^Inst (\S+) (?:\[([^\]]+)\] )?\((\S+) ([^[)]*)/.exec(line);
    if (!match) continue;
    const origins = match[4].trim();
    upgrades.push({ name: match[1], from: match[2] || null, to: match[3], security: /-security\b|Debian-Security/i.test(origins) });
  }
  return upgrades;
}

function parseAptConfig(stdout) {
  let periodic = null;
  const origins = [];
  for (const line of String(stdout || '').split('\n')) {
    const periodicMatch = /^APT::Periodic::Unattended-Upgrade "([^"]*)";$/.exec(line.trim());
    if (periodicMatch) periodic = periodicMatch[1];
    const originMatch = /^Unattended-Upgrade::(?:Origins-Pattern|Allowed-Origins):: "([^"]*)";$/.exec(line.trim());
    if (originMatch && originMatch[1]) origins.push(originMatch[1]);
  }
  return { enabled: periodic != null && periodic !== '0' && periodic !== '', origins };
}

// systemctl show prints one blank-line-separated block of KEY=value lines per unit.
function parseUnitPids(stdout) {
  const units = [];
  for (const block of String(stdout || '').split(/\n\s*\n/)) {
    const fields = Object.fromEntries(block.split('\n').map((line) => line.split('=')).filter((parts) => parts.length >= 2).map(([key, ...rest]) => [key.trim(), rest.join('=').trim()]));
    const pid = Number.parseInt(fields.MainPID, 10);
    if (fields.Id && Number.isInteger(pid) && pid > 0) units.push({ unit: fields.Id, pid });
  }
  return units;
}

// Files a process still maps after apt replaced them: the binary itself and shared libraries.
function replacedFiles(exe, maps) {
  const replaced = new Set();
  const exePath = String(exe || '');
  if (exePath.endsWith(' (deleted)')) replaced.add(exePath.slice(0, -' (deleted)'.length));
  for (const line of String(maps || '').split('\n')) {
    if (!line.endsWith(' (deleted)')) continue;
    const start = line.indexOf('/');
    if (start < 0) continue;
    const file = line.slice(start, -' (deleted)'.length);
    // Deleted temp files, memfds, and shared memory are normal; only replaced code matters here.
    if (/^\/(dev|run|tmp|memfd:|SYSV)/.test(file)) continue;
    if (/\.so(\.|$)/.test(path.basename(file)) || /\/(node|python3(\.[0-9]+)?)$/.test(file)) replaced.add(file);
  }
  return [...replaced];
}

function check(level, summary, details = {}) {
  return { ok: level === 'ok', level, summary, ...details };
}

function daysSince(ms, now) {
  return Math.floor((now - ms) / DAY_MS);
}

function createFoundationStatusCollector({ run = runApproved, fsImpl = fs, now = () => Date.now(), units = managedUnits } = {}) {
  let cached = null;
  return async function collectFoundationStatus() {
    if (cached && now() - cached.at < CACHE_MS) return cached.value;
    const at = now();
    const checks = {};

    let packages = {};
    try {
      let stdout = '';
      try {
        stdout = (await run({ binary: '/usr/bin/dpkg-query', args: ['-W', '-f=${Package}\t${Version}\t${db:Status-Abbrev}\n', ...PACKAGES], uid: 0, gid: 0, timeoutMs: 10000, env: ENV })).stdout;
      } catch (error) {
        if (error.code !== 'OPERATION_FAILED') throw error;
        stdout = error.output?.stdout || '';
      }
      packages = parseDpkgPackages(stdout);
    } catch { packages = null; }

    // Node.js: the packaged version (what a restart would run) and its release line's support window.
    const nodeFromNodeSource = Boolean(packages?.nodejs && /nodesource/i.test(packages.nodejs));
    const nodeVersion = parseVersion(packages?.nodejs)?.text || parseVersion(process.versions.node)?.text || null;
    const node = nodeLifecycle(nodeVersion, at);
    const nodeOrigin = !packages?.nodejs ? 'unpackaged' : nodeFromNodeSource ? 'nodesource' : 'distribution';
    checks['node-runtime'] = check(node.level, !nodeVersion ? 'Could not read the Node.js version.'
      : node.level === 'unknown' ? `Node.js ${nodeVersion}: the ${node.line}.x line is not in the lifecycle table reviewed ${REVIEWED_AT}.`
        : node.level === 'fail' ? `Node.js ${nodeVersion}: the ${node.line}.x line reached end of life on ${node.eol}; move to a supported line.`
          : `Node.js ${nodeVersion} (${nodeOrigin}): the ${node.line}.x line is supported until ${node.eol} (${node.daysLeft} days).`,
    {
      version: nodeVersion, origin: nodeOrigin, line: node.line, eol: node.eol, daysLeft: node.daysLeft,
      hint: node.level === 'fail' || node.level === 'warn' ? `Move to a supported line${node.level === 'warn' ? ` before ${node.eol}` : ''}: point /etc/apt/sources.list.d/nodesource.list at a newer node_<major>.x, apt-get install nodejs, then restart Home Base and every app.`
        : node.level === 'unknown' && nodeVersion ? 'Check this line\'s support window and update src/operations/runtime-lifecycle.js.' : '',
    });

    // Python: upstream end of life is a signal, not a verdict; distributions keep backporting fixes.
    const pythonVersion = parseVersion(packages?.python3)?.text || null;
    if (!pythonVersion) {
      checks['python-runtime'] = check(packages ? 'ok' : 'unknown', packages ? 'Python 3 is not installed (no Python apps on this host).' : 'Could not read installed packages.', { version: null });
    } else {
      const python = pythonLifecycle(pythonVersion, at);
      checks['python-runtime'] = check(python.level, python.level === 'unknown' ? `Python ${pythonVersion}: ${python.line} is not in the lifecycle table reviewed ${REVIEWED_AT}.`
        : python.level === 'fail' ? `Python ${pythonVersion}: ${python.line} passed upstream end of life on ${python.eol}; only distribution backports fix it now.`
          : `Python ${pythonVersion}: ${python.line} is supported upstream until ${python.eol} (${python.daysLeft} days).`,
      {
        version: pythonVersion, line: python.line, eol: python.eol, daysLeft: python.daysLeft,
        hint: python.level === 'fail' || python.level === 'warn' ? 'Python apps use the distribution\'s python3; a newer Ubuntu or Debian release brings a supported line. Until then, keep security updates current.' : '',
      });
    }

    // Package-list freshness: pending updates are only as current as the last apt-get update. apt dates
    // Release files by the server's Last-Modified, so Ubuntu's update-success stamp (touched on every
    // successful update) is the better signal where it exists; the newest of them counts.
    let listsAt = null;
    try {
      const stamps = fsImpl.readdirSync(APT_LISTS).filter((name) => /_(In)?Release$/.test(name)).map((name) => path.join(APT_LISTS, name));
      if (fsImpl.existsSync(APT_UPDATE_STAMP)) stamps.push(APT_UPDATE_STAMP);
      for (const stamp of stamps) {
        const { mtimeMs } = fsImpl.statSync(stamp);
        if (Number.isFinite(mtimeMs) && (listsAt == null || mtimeMs > listsAt)) listsAt = mtimeMs;
      }
    } catch { listsAt = null; }
    const listsAge = listsAt == null ? null : daysSince(listsAt, at);
    checks['apt-lists'] = listsAt == null
      ? check('unknown', 'No apt package lists found; pending updates cannot be known until apt-get update runs.', { refreshedAt: null, ageDays: null, hint: 'sudo apt-get update' })
      : check(listsAge > LISTS_STALE_DAYS ? 'warn' : 'ok', `Package lists refreshed ${listsAge === 0 ? 'today' : `${listsAge} day${listsAge === 1 ? '' : 's'} ago`}${listsAge > LISTS_STALE_DAYS ? '; pending updates below may be incomplete' : ''}.`,
        { refreshedAt: new Date(listsAt).toISOString(), ageDays: listsAge, hint: listsAge > LISTS_STALE_DAYS ? 'sudo apt-get update' : '' });

    // Pending upgrades, by simulation (apt-get -s takes no lock and changes nothing).
    try {
      const result = await run({ binary: '/usr/bin/apt-get', args: ['-s', '-o', 'Debug::NoLocking=1', 'dist-upgrade'], uid: 0, gid: 0, timeoutMs: 60000, env: ENV, outputLimit: 4 * 1024 * 1024 });
      const upgrades = parseAptSimulation(result.stdout);
      const security = upgrades.filter((upgrade) => upgrade.security);
      const runtimes = upgrades.filter((upgrade) => /^(nodejs|python3(\.[0-9]+)?(-minimal)?|libpython3.*|openssl|libssl.*)$/.test(upgrade.name));
      const level = security.length ? 'fail' : upgrades.length ? 'warn' : 'ok';
      const summary = !upgrades.length ? 'No pending package updates.'
        : `${upgrades.length} pending package update${upgrades.length === 1 ? '' : 's'}, ${security.length} from security pockets${runtimes.length ? `; includes ${runtimes.map((upgrade) => upgrade.name).join(', ')}` : ''}.`;
      checks['pending-updates'] = check(level, summary, {
        total: upgrades.length,
        security: security.length,
        runtimes: runtimes.map(({ name, from, to }) => ({ name, from, to })),
        packages: upgrades.slice(0, LIST_LIMIT * 5).map(({ name, from, to, security: isSecurity }) => ({ name, from, to, security: isSecurity })),
        hint: upgrades.length ? 'sudo apt-get update && sudo apt-get upgrade' : '',
      });
    } catch (error) {
      checks['pending-updates'] = check('unknown', `Could not simulate an upgrade: ${String(error.output?.stderr || error.message || '').trim().slice(-200)}`, { total: null, security: null });
    }

    // Automatic updates: whether unattended-upgrades runs, and whether it covers NodeSource's origin
    // (Ubuntu and Debian allow only their own security pockets by default).
    try {
      if (packages && !packages['unattended-upgrades']) {
        checks['automatic-updates'] = check('warn', 'unattended-upgrades is not installed; security updates wait for a manual apt upgrade.', { installed: false, enabled: false, coversNodeSource: false, hint: 'sudo apt-get install unattended-upgrades' });
      } else {
        const config = parseAptConfig((await run({ binary: '/usr/bin/apt-config', args: ['dump'], uid: 0, gid: 0, timeoutMs: 10000, env: ENV, outputLimit: 1024 * 1024 })).stdout);
        const coversNodeSource = config.origins.some((origin) => /nodistro|nodesource/i.test(origin));
        const level = !config.enabled || (nodeFromNodeSource && !coversNodeSource) ? 'warn' : 'ok';
        const summary = !config.enabled ? 'unattended-upgrades is installed but not enabled (APT::Periodic::Unattended-Upgrade).'
          : nodeFromNodeSource && !coversNodeSource ? 'unattended-upgrades is enabled but does not include the NodeSource origin, so Node.js updates stay manual.'
            : 'unattended-upgrades is enabled.';
        const hint = !config.enabled ? 'sudo dpkg-reconfigure -plow unattended-upgrades'
          : nodeFromNodeSource && !coversNodeSource ? `Add ${NODESOURCE_ORIGIN_PATTERN} to /etc/apt/apt.conf.d/52nodesource-unattended` : '';
        checks['automatic-updates'] = check(level, summary, { installed: true, enabled: config.enabled, coversNodeSource, origins: config.origins.slice(0, LIST_LIMIT), hint });
      }
    } catch {
      checks['automatic-updates'] = check('unknown', 'Could not read the apt configuration.', { installed: Boolean(packages?.['unattended-upgrades']), enabled: null, coversNodeSource: null });
    }

    // Kernel and core-library updates that only take effect after a reboot.
    if (fsImpl.existsSync(REBOOT_REQUIRED)) {
      let pkgs = [];
      try { pkgs = String(fsImpl.readFileSync(REBOOT_REQUIRED_PKGS, 'utf8')).split('\n').map((line) => line.trim()).filter(Boolean); } catch { pkgs = []; }
      checks['reboot-required'] = check('warn', `A reboot is required to finish installed updates${pkgs.length ? ` (${pkgs.slice(0, LIST_LIMIT).join(', ')})` : ''}.`, { required: true, packages: pkgs.slice(0, LIST_LIMIT), hint: 'Reboot the host in a maintenance window.' });
    } else {
      checks['reboot-required'] = check('ok', 'No reboot pending.', { required: false, packages: [] });
    }

    // Units still running a binary or library that apt has since replaced: patched on disk, not live.
    try {
      const unitNames = units();
      const shown = await run({ binary: '/usr/bin/systemctl', args: ['show', '--property=Id', '--property=MainPID', '--', ...unitNames], uid: 0, gid: 0, timeoutMs: 10000, env: ENV, outputLimit: 1024 * 1024 });
      const stale = [];
      let inspected = 0;
      for (const { unit, pid } of parseUnitPids(shown.stdout)) {
        let exe;
        let maps;
        try {
          exe = fsImpl.readlinkSync(`/proc/${pid}/exe`);
          maps = fsImpl.readFileSync(`/proc/${pid}/maps`, 'utf8');
        } catch { continue; }
        inspected += 1;
        const files = replacedFiles(exe, maps);
        if (files.length) stale.push({ unit, pid, replaced: files.slice(0, LIST_LIMIT) });
      }
      checks['stale-processes'] = stale.length
        ? check('warn', `${stale.length} running unit${stale.length === 1 ? '' : 's'} still use${stale.length === 1 ? 's' : ''} files that updates replaced; restart ${stale.map((entry) => entry.unit).join(', ')} to load the fixes.`, { inspected, stale, hint: `sudo systemctl restart ${stale.map((entry) => entry.unit).join(' ')}` })
        : check('ok', `All ${inspected} running Home Base and app units use current binaries and libraries.`, { inspected, stale });
    } catch {
      checks['stale-processes'] = check('unknown', 'Could not inspect running units.', { inspected: 0, stale: [] });
    }

    const value = { checks, lifecycleReviewedAt: REVIEWED_AT, collectedAt: new Date(at).toISOString() };
    cached = { at, value };
    return value;
  };
}

module.exports = { createFoundationStatusCollector, managedUnits, parseAptSimulation, parseAptConfig, parseUnitPids, replacedFiles };
