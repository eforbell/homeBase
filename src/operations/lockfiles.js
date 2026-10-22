// Pure parsers that turn an app's lockfile (or its installed virtualenv) into the packages it runs, as
// [name, version] pairs (docs/patch-visibility-plan.md, stream B). They never resolve anything: a
// dependency without an exact version is reported as unpinned rather than guessed, and anything the
// parser cannot account for (an unreadable include, an unknown option) is unpinned too, never green.

// PEP 503 normalization, so "Jinja2", "jinja2", and "jinja_2" match the same advisory records.
function normalizePythonName(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

function dedupe(pairs) {
  const seen = new Set();
  const out = [];
  for (const [name, version] of pairs) {
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([name, version]);
  }
  return out.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)));
}

// npm's os/cpu/libc fields: a value list, or negations ("!win32"). npm installs an entry only when every
// field it sets allows this host, so the lockfile alone over-reports another platform's binaries.
const HOST_PLATFORM = Object.freeze({ os: 'linux', cpu: process.arch, libc: 'glibc' });
function allowsHost(values, hostValue) {
  if (!Array.isArray(values) || !values.length) return true;
  if (values.includes(hostValue)) return true;
  return values.every((value) => String(value).startsWith('!')) && !values.includes(`!${hostValue}`);
}
function installsHere(entry, host) {
  return allowsHost(entry.os, host.os) && allowsHost(entry.cpu, host.cpu) && allowsHost(entry.libc, host.libc);
}

// package-lock.json v2/v3 ("packages", keyed by install path) and v1 ("dependencies", nested). Dev-only
// entries are skipped because installs run `npm ci --omit=dev`; devOptional entries are kept, since npm
// installs them when a production dependency needs them. `host` defaults to this machine (Sovereign
// Home hosts are glibc Linux: Ubuntu and Debian).
function parseNpmLock(text, { host = HOST_PLATFORM } = {}) {
  let lock;
  try { lock = JSON.parse(text); } catch { throw new Error('package-lock.json is not valid JSON.'); }
  if (!lock || typeof lock !== 'object') throw new Error('package-lock.json is not an object.');
  const pairs = [];
  if (lock.packages && typeof lock.packages === 'object') {
    for (const [key, entry] of Object.entries(lock.packages)) {
      // "" is the app itself; links point at another entry that is listed on its own.
      if (!key || !entry || entry.dev === true || entry.link === true || entry.extraneous === true || !installsHere(entry, host)) continue;
      const name = entry.name || key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (name && typeof entry.version === 'string' && entry.version) pairs.push([name, entry.version]);
    }
  } else if (lock.dependencies && typeof lock.dependencies === 'object') {
    const walk = (dependencies) => {
      for (const [name, entry] of Object.entries(dependencies || {})) {
        if (!entry || entry.dev === true) continue;
        if (typeof entry.version === 'string' && entry.version) pairs.push([name, entry.version]);
        walk(entry.dependencies);
      }
    };
    walk(lock.dependencies);
  } else {
    throw new Error('package-lock.json lists no packages.');
  }
  return { packages: dedupe(pairs), unpinned: [], includes: [], errors: [] };
}

// pip options that change where or how packages are fetched, but not which ones: safe to skip.
const PIP_IGNORED_OPTIONS = /^(--index-url|-i|--extra-index-url|--no-index|--find-links|-f|--trusted-host|--pre|--prefer-binary|--only-binary|--no-binary|--require-hashes|--use-feature|--hash|--config-settings|--global-option)(\s|=|$)/;
const PIP_INCLUDE = /^(?:-r|--requirement)(?:\s+|=)(\S+)$/;
const PIP_CONSTRAINT = /^(?:-c|--constraint)(?:\s+|=)(\S+)$/;
const PIP_EDITABLE = /^(?:-e|--editable)(?:\s+|=)(\S+)$/;
const INCLUDE_LIMITS = Object.freeze({ depth: 5, files: 20 });

// A pip requirements file. Exact pins (name==version, with optional extras, markers, and --hash
// options) become packages; ranges, bare names, and URLs are unpinned. `-r` includes are followed
// through readInclude(path, fromFile) (the caller confines paths to the app checkout), bounded in depth
// and count; an include that cannot be read, or an option this parser does not know, is recorded in
// errors and unpinned so the file can never be reported as fully pinned by accident. Constraint files
// (-c) only narrow versions and add nothing. An editable local path (-e .) is the app itself.
function parseRequirementsLock(text, { readInclude = null, file = 'requirements.txt', limits = INCLUDE_LIMITS } = {}) {
  const pairs = [];
  const unpinned = [];
  const includes = [];
  const errors = [];
  const seenFiles = new Set([file]);
  const visit = (content, currentFile, depth) => {
    const logical = String(content || '').replace(/\\\r?\n/g, ' ').split(/\r?\n/);
    for (const raw of logical) {
      const line = raw.replace(/(^|\s)#.*$/, '').trim();
      if (!line) continue;
      if (line.startsWith('-')) {
        const include = PIP_INCLUDE.exec(line);
        if (include) {
          const target = include[1];
          if (depth >= limits.depth || seenFiles.size >= limits.files) {
            errors.push(`${currentFile}: include limit reached at ${target}`);
            unpinned.push(`-r ${target}`);
            continue;
          }
          if (seenFiles.has(target)) continue;
          seenFiles.add(target);
          const included = typeof readInclude === 'function' ? readInclude(target, currentFile) : null;
          if (included == null) {
            errors.push(`${currentFile}: could not read included ${target}`);
            unpinned.push(`-r ${target}`);
            continue;
          }
          includes.push(target);
          visit(included, target, depth + 1);
          continue;
        }
        if (PIP_CONSTRAINT.test(line) || PIP_IGNORED_OPTIONS.test(line)) continue;
        const editable = PIP_EDITABLE.exec(line);
        if (editable) {
          // A local path is the app (or a vendored copy) checked in beside the lockfile; a VCS or URL
          // editable installs whatever that ref resolves to today.
          if (/^(\.|\/|file:)/.test(editable[1]) && !/^(git|hg|svn|bzr)\+/.test(editable[1])) continue;
          const egg = /#egg=([A-Za-z0-9._-]+)/.exec(editable[1]);
          unpinned.push(egg ? normalizePythonName(egg[1]) : editable[1].slice(0, 80));
          continue;
        }
        errors.push(`${currentFile}: unrecognized option ${line.split(/\s+/)[0]}`);
        unpinned.push(line.slice(0, 80));
        continue;
      }
      const pin = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([A-Za-z0-9][A-Za-z0-9.!+_-]*)(?=\s|;|$)/.exec(line);
      if (pin) {
        pairs.push([normalizePythonName(pin[1]), pin[2]]);
        continue;
      }
      const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
      unpinned.push(name ? normalizePythonName(name[1]) : line.slice(0, 80));
    }
  };
  visit(text, file, 0);
  return { packages: dedupe(pairs), unpinned: [...new Set(unpinned)].sort(), includes, errors };
}

// Installed distributions in a virtualenv's site-packages, from their "<name>-<version>.dist-info"
// directory names (no Python runs). This is what the app actually runs.
function parseDistInfoNames(names) {
  const pairs = [];
  for (const entry of names || []) {
    const match = /^(.+?)-([0-9][^-]*)\.dist-info$/.exec(String(entry));
    if (match) pairs.push([normalizePythonName(match[1]), match[2]]);
  }
  return { packages: dedupe(pairs), unpinned: [], includes: [], errors: [] };
}

// Where a lockfile and an installed environment disagree: a locked package installed at another version,
// or not installed at all. Packages installed but not locked (pip itself, setuptools) are not drift.
function lockDrift(locked, installed) {
  const installedByName = new Map();
  for (const [name, version] of installed) {
    if (!installedByName.has(name)) installedByName.set(name, []);
    installedByName.get(name).push(version);
  }
  const drift = [];
  for (const [name, version] of locked) {
    const versions = installedByName.get(name) || [];
    if (!versions.includes(version)) drift.push({ name, locked: version, installed: versions[0] || null });
  }
  return drift;
}

module.exports = { HOST_PLATFORM, normalizePythonName, parseNpmLock, parseRequirementsLock, parseDistInfoNames, lockDrift };
