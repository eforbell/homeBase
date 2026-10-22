// Pure parsers that turn an app's lockfile (or its installed virtualenv) into the packages it runs, as
// [name, version] pairs (docs/patch-visibility-plan.md, stream B). They never resolve anything: a
// dependency without an exact version is reported as unpinned rather than guessed.

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

// npm lists every platform's optional binaries (sharp-darwin-arm64, ...) but installs only the ones
// whose "os" allows this host; Sovereign Home hosts are Linux, so the others are not running here.
function installsOnLinux(entry) {
  if (!Array.isArray(entry.os) || !entry.os.length) return true;
  if (entry.os.includes('linux')) return true;
  return entry.os.every((value) => String(value).startsWith('!')) && !entry.os.includes('!linux');
}

// package-lock.json v2/v3 ("packages", keyed by install path) and v1 ("dependencies", nested). Dev-only
// entries are skipped because installs run `npm ci --omit=dev`; devOptional entries are kept, since npm
// installs them when a production dependency needs them.
function parseNpmLock(text) {
  let lock;
  try { lock = JSON.parse(text); } catch { throw new Error('package-lock.json is not valid JSON.'); }
  if (!lock || typeof lock !== 'object') throw new Error('package-lock.json is not an object.');
  const pairs = [];
  if (lock.packages && typeof lock.packages === 'object') {
    for (const [key, entry] of Object.entries(lock.packages)) {
      // "" is the app itself; links point at another entry that is listed on its own.
      if (!key || !entry || entry.dev === true || entry.link === true || entry.extraneous === true || !installsOnLinux(entry)) continue;
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
  return { packages: dedupe(pairs), unpinned: [] };
}

// A pip requirements file. Exact pins (name==version, with optional extras, markers, and --hash
// options) become packages; anything else naming a package (ranges, bare names, URLs) is unpinned.
// Option lines (-r, -e, --index-url, ...) are ignored.
function parseRequirementsLock(text) {
  const pairs = [];
  const unpinned = [];
  const logical = String(text || '').replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (const raw of logical) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const pin = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([A-Za-z0-9][A-Za-z0-9.!+_-]*)(?=\s|;|$)/.exec(line);
    if (pin) {
      pairs.push([normalizePythonName(pin[1]), pin[2]]);
      continue;
    }
    const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    unpinned.push(name ? normalizePythonName(name[1]) : line.slice(0, 80));
  }
  return { packages: dedupe(pairs), unpinned: [...new Set(unpinned)].sort() };
}

// Installed distributions in a virtualenv's site-packages, from their "<name>-<version>.dist-info"
// directory names (no Python runs). These are what is installed today, not a reproducible pin.
function parseDistInfoNames(names) {
  const pairs = [];
  for (const entry of names || []) {
    const match = /^(.+?)-([0-9][^-]*)\.dist-info$/.exec(String(entry));
    if (match) pairs.push([normalizePythonName(match[1]), match[2]]);
  }
  return { packages: dedupe(pairs), unpinned: [] };
}

module.exports = { normalizePythonName, parseNpmLock, parseRequirementsLock, parseDistInfoNames };
