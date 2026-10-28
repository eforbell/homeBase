const fs = require('fs');
const path = require('path');
const { ProtocolError } = require('./protocol-error');
const { INSTALLABLE_APPS } = require('./actions');
const { lookupSystemUser, runAsUser, lstatOrNull, readSmallFileNoFollow } = require('./handlers');
const { resolveAppIdentity } = require('./identity');
const { getAppById } = require('../src/catalog');
const { appLayout } = require('../src/operations/app-layout');
const { parseNpmLock, parseRequirementsLock, parseDistInfoNames, lockDrift } = require('../src/operations/lockfiles');
const { evaluateFloors, REVIEWED_AT: FLOORS_REVIEWED_AT } = require('../src/operations/security-floors');

// The packages one managed app runs, read from its checkout (docs/patch-visibility-plan.md, stream B).
// Read-only and offline: the executor only reads files, as the app's user, and returns [name, version] pairs.
// Looking them up in an advisory database is the unprivileged web service's job, never root's.
const LOCKFILE_LIMIT = 2 * 1024 * 1024;
const LIST_LIMIT = 50;
// Debian and Ubuntu patch pip's bundled certifi (python3-pip-whl) to return the host bundle instead of
// its own: a module-level DEBIAN_CA_CERTS_PATH = '/etc/ssl/certs/ca-certificates.crt', and a final
// top-level where() returning it, which overrides the version-specific definitions above it. Only that
// structure counts; the path in a comment or an unused string does not. This classifies the build; it
// is not a defense against the app's user, which owns the venv and could make where() return anything.
const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
function returnsSystemBundle(source) {
  const lines = String(source || '').split(/\r?\n/);
  const assigned = new Set();
  for (const line of lines) {
    const match = /^([A-Z_][A-Z0-9_]*)\s*=\s*(['"])(.*?)\2\s*(#.*)?$/.exec(line);
    if (match && match[3] === SYSTEM_CA_BUNDLE) assigned.add(match[1]);
  }
  // The last top-level where() is the one Python binds; its first statement must return the bundle.
  const last = lines.map((line, index) => (/^def where\(\)/.test(line) ? index : -1)).filter((index) => index >= 0).at(-1);
  if (last === undefined) return false;
  const body = lines.slice(last + 1).find((line) => line.trim() && !line.trim().startsWith('#'));
  const returned = /^\s+return\s+(?:(['"])(.*?)\1|([A-Za-z_][A-Za-z0-9_]*))\s*(#.*)?$/.exec(body || '');
  if (!returned) return false;
  return returned[2] === SYSTEM_CA_BUNDLE || assigned.has(returned[3]);
}

function isDirectory(stat) {
  return Boolean(stat && stat.isDirectory() && !stat.isSymbolicLink());
}

function createDependencyInventoryReader({ fsImpl = fs, lookupUser = (name) => lookupSystemUser(name, fsImpl), asUser = runAsUser, now = () => Date.now() } = {}) {
  return function readDependencyInventory({ appId }) {
    if (!INSTALLABLE_APPS.includes(appId)) throw new ProtocolError('POLICY_DENIED', `The executor does not manage ${appId}.`);
    const layout = appLayout(getAppById(appId));
    const { checkout } = layout;
    if (!isDirectory(lstatOrNull(fsImpl, checkout))) throw new ProtocolError('NOT_INSTALLED', `${layout.app.name} has no checkout at ${checkout}.`);
    // Every read happens as the app's user, which owns the checkout: the kernel, not a path check, keeps a
    // planted symlink from pointing root at another file.
    const owner = resolveAppIdentity(layout, { fsImpl, lookupUser });
    const read = (relative) => asUser(owner, () => readSmallFileNoFollow(fsImpl, path.posix.join(checkout, relative), LOCKFILE_LIMIT));
    const base = { appId, collectedAt: new Date(now()).toISOString(), floorsReviewedAt: FLOORS_REVIEWED_AT };
    const parsed = (parse, ...args) => {
      try { return parse(...args); } catch (error) { throw new ProtocolError('OPERATION_FAILED', `${layout.app.name}: ${error.message}`); }
    };
    const unreadable = (name) => `No readable ${name} in the checkout (missing, or not a regular file).`;

    if (layout.runtime.kind === 'node') {
      const text = read('package-lock.json');
      const empty = { packages: [], unpinned: [], drift: [], floorFindings: [], errors: [] };
      if (text == null) return { ...base, ecosystem: 'npm', source: null, inventorySource: null, pinned: false, ...empty, note: unreadable('package-lock.json') };
      const { packages } = parsed(parseNpmLock, text);
      return { ...base, ecosystem: 'npm', source: 'package-lock.json', inventorySource: 'lockfile', pinned: packages.length > 0, ...empty, packages, floorFindings: evaluateFloors({ ecosystem: 'npm', installed: packages }) };
    }

    // Python. The virtualenv is what runs, so it is always inventoried when it exists; the lockfile (when
    // the app installs from one) says what a reinstall would bring back, and drift between them is
    // reported on its own. An editable install that resolves its own dependencies (no --no-deps) has no
    // lockfile that describes it.
    const { requirements, editable, editableNoDeps } = layout.runtime.python;
    let lock = null;
    if (requirements && (!editable || editableNoDeps)) {
      if (requirements.includes('..') || path.posix.isAbsolute(requirements)) throw new ProtocolError('POLICY_DENIED', 'The requirements file must be inside the checkout.');
      const text = read(requirements);
      lock = { file: requirements, text };
      if (text != null) {
        // The parser hands over canonical checkout-relative paths; refuse anything else regardless.
        const readInclude = (relative) => (path.posix.isAbsolute(relative) || relative === '..' || relative.startsWith('../') ? null : read(relative));
        lock.result = parsed(parseRequirementsLock, text, { readInclude, file: requirements });
      }
    }
    const venv = asUser(owner, () => {
      const lib = path.posix.join(checkout, '.venv', 'lib');
      if (!isDirectory(lstatOrNull(fsImpl, lib))) return null;
      const pythonDir = fsImpl.readdirSync(lib).filter((name) => /^python3\.[0-9]+$/.test(name)).sort().at(-1);
      if (!pythonDir) return null;
      const sitePackages = path.posix.join(lib, pythonDir, 'site-packages');
      if (!isDirectory(lstatOrNull(fsImpl, sitePackages))) return null;
      const certifiCore = readSmallFileNoFollow(fsImpl, path.posix.join(sitePackages, 'pip', '_vendor', 'certifi', 'core.py'), 64 * 1024);
      return { names: fsImpl.readdirSync(sitePackages), pipUsesSystemStore: returnsSystemBundle(certifiCore) };
    });
    const installed = venv ? parseDistInfoNames(venv.names).packages : null;
    const locked = lock?.result?.packages || [];
    const lockErrors = lock?.result?.errors || [];
    const unpinned = lock?.result?.unpinned || [];
    const drift = installed && lock?.result ? lockDrift(locked, installed) : [];
    const floorFindings = evaluateFloors({ ecosystem: 'PyPI', installed: installed || [], locked, pipUsesSystemStore: Boolean(venv?.pipUsesSystemStore) });
    const pinned = Boolean(lock?.result) && locked.length > 0 && unpinned.length === 0 && lockErrors.length === 0;

    const notes = [];
    if (lock && lock.text == null) notes.push(unreadable(lock.file));
    if (!lock) notes.push('No lockfile: these are the versions installed today, and a reinstall may resolve different ones.');
    if (lockErrors.length) notes.push(`${lock.file} could not be fully read: ${lockErrors.slice(0, 3).join('; ')}.`);
    if (!installed) notes.push(lock?.result ? 'No virtualenv: nothing is installed to check; the packages shown are what the lockfile would install.' : 'No virtualenv to inventory yet.');
    if (drift.length) notes.push(`${drift.length} locked package${drift.length === 1 ? ' is' : 's are'} installed at a different version than ${lock.file} says; reinstall the app to match it.`);

    return {
      ...base,
      ecosystem: 'PyPI',
      source: lock?.result ? lock.file : null,
      inventorySource: installed ? 'virtualenv' : (lock?.result ? 'lockfile' : null),
      pinned,
      packages: installed || locked,
      unpinned: unpinned.slice(0, LIST_LIMIT),
      drift: drift.slice(0, LIST_LIMIT),
      // Lists are capped to keep the response small; totals are counted before the cap.
      driftTotal: drift.length,
      unpinnedTotal: unpinned.length,
      errorTotal: lockErrors.length,
      floorFindings,
      errors: lockErrors.slice(0, LIST_LIMIT),
      pipUsesSystemStore: venv ? venv.pipUsesSystemStore : null,
      venvMissing: !installed,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  };
}

module.exports = { createDependencyInventoryReader, returnsSystemBundle };
