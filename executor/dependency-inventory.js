const fs = require('fs');
const path = require('path');
const { ProtocolError } = require('./protocol-error');
const { INSTALLABLE_APPS } = require('./actions');
const { lookupSystemUser, runAsUser, lstatOrNull, readSmallFileNoFollow } = require('./handlers');
const { getAppById } = require('../src/catalog');
const { appLayout } = require('../src/operations/app-layout');
const { parseNpmLock, parseRequirementsLock, parseDistInfoNames } = require('../src/operations/lockfiles');

// The packages one managed app runs, read from its checkout (docs/patch-visibility-plan.md, stream B).
// Read-only and offline: the executor only reads files, as sovereign, and returns [name, version] pairs.
// Looking them up in an advisory database is the unprivileged web service's job, never root's.
const LOCKFILE_LIMIT = 2 * 1024 * 1024;
const UNPINNED_LIMIT = 50;

function createDependencyInventoryReader({ fsImpl = fs, lookupUser = (name) => lookupSystemUser(name, fsImpl), asUser = runAsUser, now = () => Date.now() } = {}) {
  return function readDependencyInventory({ appId }) {
    if (!INSTALLABLE_APPS.includes(appId)) throw new ProtocolError('POLICY_DENIED', `The executor does not manage ${appId}.`);
    const layout = appLayout(getAppById(appId));
    const { checkout } = layout;
    const sovereign = lookupUser('sovereign');
    if (!sovereign) throw new ProtocolError('POLICY_DENIED', 'The sovereign identity does not exist.');
    const checkoutStat = lstatOrNull(fsImpl, checkout);
    if (!checkoutStat || !checkoutStat.isDirectory() || checkoutStat.isSymbolicLink()) throw new ProtocolError('NOT_INSTALLED', `${layout.app.name} has no checkout at ${checkout}.`);
    // Every read happens as sovereign, which owns the checkout: the kernel, not a path check, keeps a
    // planted symlink from pointing root at another file.
    const read = (relative) => asUser(sovereign, () => readSmallFileNoFollow(fsImpl, path.posix.join(checkout, relative), LOCKFILE_LIMIT));
    const base = { appId, collectedAt: new Date(now()).toISOString() };
    const parsed = (parse, text) => {
      try { return parse(text); } catch (error) { throw new ProtocolError('OPERATION_FAILED', `${layout.app.name}: ${error.message}`); }
    };

    if (layout.runtime.kind === 'node') {
      const text = read('package-lock.json');
      if (text == null) return { ...base, ecosystem: 'npm', source: null, pinned: false, packages: [], unpinned: [], note: 'No readable package-lock.json in the checkout (missing, or not a regular file).' };
      const { packages } = parsed(parseNpmLock, text);
      return { ...base, ecosystem: 'npm', source: 'package-lock.json', pinned: true, packages, unpinned: [] };
    }

    // Python: the requirements lock when the app has one. An editable install that resolves its own
    // dependencies (no --no-deps) is not reproducible from any file, so its venv is inventoried instead.
    const { requirements, editable, editableNoDeps } = layout.runtime.python;
    if (requirements && (!editable || editableNoDeps)) {
      if (requirements.includes('..') || path.posix.isAbsolute(requirements)) throw new ProtocolError('POLICY_DENIED', 'The requirements file must be inside the checkout.');
      const text = read(requirements);
      if (text == null) return { ...base, ecosystem: 'PyPI', source: null, pinned: false, packages: [], unpinned: [], note: `No readable ${requirements} in the checkout (missing, or not a regular file).` };
      const { packages, unpinned } = parsed(parseRequirementsLock, text);
      return { ...base, ecosystem: 'PyPI', source: requirements, pinned: unpinned.length === 0, packages, unpinned: unpinned.slice(0, UNPINNED_LIMIT) };
    }
    const names = asUser(sovereign, () => {
      const lib = path.posix.join(checkout, '.venv', 'lib');
      const libStat = lstatOrNull(fsImpl, lib);
      if (!libStat || !libStat.isDirectory() || libStat.isSymbolicLink()) return null;
      const pythonDir = fsImpl.readdirSync(lib).filter((name) => /^python3\.[0-9]+$/.test(name)).sort().at(-1);
      if (!pythonDir) return null;
      const sitePackages = path.posix.join(lib, pythonDir, 'site-packages');
      const siteStat = lstatOrNull(fsImpl, sitePackages);
      return siteStat && siteStat.isDirectory() && !siteStat.isSymbolicLink() ? fsImpl.readdirSync(sitePackages) : null;
    });
    if (names == null) return { ...base, ecosystem: 'PyPI', source: null, pinned: false, packages: [], unpinned: [], note: 'No virtualenv to inventory yet.' };
    const { packages } = parseDistInfoNames(names);
    return {
      ...base, ecosystem: 'PyPI', source: 'installed virtualenv', pinned: false, packages, unpinned: [],
      note: 'No lockfile: these are the versions installed today, and a reinstall may resolve different ones.',
    };
  };
}

module.exports = { createDependencyInventoryReader };
