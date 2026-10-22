// Minimum versions below which a package is known to be unsafe, kept by hand like runtime-lifecycle.js.
// They are checked offline against what each app has installed and what its lockfile would reinstall, so
// an incident is flagged even while the opt-in advisory lookup is off or has not caught up. Add an entry
// when an incident needs action on every host; REVIEWED_AT ships with every report.
const REVIEWED_AT = '2026-10-22';
const EMSIGN = 'https://discuss.python.org/t/information-for-python-users-regarding-emudhra-emsign-ca-certificate-security-incident/109576';

const FLOORS = Object.freeze([
  Object.freeze({
    ecosystem: 'PyPI', name: 'certifi', minVersion: '2026.10.19', since: '2026-10-20', reference: EMSIGN,
    reason: 'eMudhra/emSign CA incident: earlier CA bundles trust intermediates with compromised keys.',
  }),
  Object.freeze({
    ecosystem: 'PyPI', name: 'pip', minVersion: '26.2.2', since: '2026-10-20', reference: EMSIGN,
    reason: 'eMudhra/emSign CA incident: earlier pip always trusts its own bundled CA list, so updating the host store does not fix it.',
    // A distribution build (Debian/Ubuntu python3-pip-whl) is patched to use the host CA store instead,
    // so the host's ca-certificates decides; the finding is kept as a note, not an alarm.
    mitigatedBySystemStore: true,
  }),
]);

// Numeric dotted comparison (PEP 440 release segments; certifi's are dates). A version with no leading
// number cannot be compared and is treated as below the floor, so it is looked at rather than passed.
function compareVersions(a, b) {
  const parse = (value) => (/^v?([0-9]+(?:\.[0-9]+)*)/.exec(String(value || '')) || [])[1];
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  const x = left.split('.').map(Number);
  const y = right.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] || 0) - (y[i] || 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

// findings: one per (package, where) below its floor. where is 'installed' (running now) or 'lockfile'
// (a reinstall would bring it back). mitigated explains why a finding is only a note.
function evaluateFloors({ ecosystem, installed = [], locked = [], pipUsesSystemStore = false, floors = FLOORS }) {
  const findings = [];
  for (const floor of floors.filter((entry) => entry.ecosystem === ecosystem)) {
    for (const [where, packages] of [['installed', installed], ['lockfile', locked]]) {
      for (const [name, version] of packages) {
        if (name !== floor.name) continue;
        const comparison = compareVersions(version, floor.minVersion);
        if (comparison !== null && comparison >= 0) continue;
        const mitigated = floor.mitigatedBySystemStore && pipUsesSystemStore && where === 'installed'
          ? 'This pip is a distribution build that uses the host CA store; it is fixed when the host\'s ca-certificates drops the affected CA.'
          : null;
        findings.push({ name, version, minVersion: floor.minVersion, where, reason: floor.reason, reference: floor.reference, ...(mitigated ? { mitigated } : {}) });
      }
    }
  }
  return findings;
}

module.exports = { REVIEWED_AT, FLOORS, compareVersions, evaluateFloors };
