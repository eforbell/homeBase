// Upstream end-of-life dates for the runtimes Home Base and its apps run on. Reviewed by hand: a major
// missing from the table is reported as unknown rather than assumed supported, and REVIEWED_AT ships
// with every report so a stale table is visible. Sources: the Node.js release schedule
// (github.com/nodejs/release) and the Python release cycle (devguide.python.org/versions).
const REVIEWED_AT = '2026-10-22';

const NODE_EOL = Object.freeze({
  18: '2025-04-30',
  20: '2026-04-30',
  22: '2027-04-30',
  24: '2028-04-30',
  26: '2029-04-30',
});

const PYTHON_EOL = Object.freeze({
  '3.10': '2026-10-31',
  '3.11': '2027-10-31',
  '3.12': '2028-10-31',
  '3.13': '2029-10-31',
  '3.14': '2030-10-31',
});

const WARN_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// Leading x.y.z of a version string: "v24.10.0", "24.10.0-1nodesource1", "3.12.3-0ubuntu2.1".
function parseVersion(value) {
  const match = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(String(value || '').trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: `${match[1]}.${match[2]}.${match[3]}` } : null;
}

// level: ok, warn (within WARN_DAYS of end of life), fail (past it), or unknown (not in the table).
function lifecycleFor(eolDate, now) {
  if (!eolDate) return { level: 'unknown', eol: null, daysLeft: null };
  const daysLeft = Math.floor((Date.parse(`${eolDate}T00:00:00Z`) - now) / DAY_MS);
  return { level: daysLeft < 0 ? 'fail' : daysLeft <= WARN_DAYS ? 'warn' : 'ok', eol: eolDate, daysLeft };
}

function nodeLifecycle(version, now = Date.now()) {
  const parsed = parseVersion(version);
  if (!parsed) return { level: 'unknown', eol: null, daysLeft: null, line: null };
  return { ...lifecycleFor(NODE_EOL[parsed.major], now), line: String(parsed.major) };
}

function pythonLifecycle(version, now = Date.now()) {
  const parsed = parseVersion(version);
  if (!parsed) return { level: 'unknown', eol: null, daysLeft: null, line: null };
  const line = `${parsed.major}.${parsed.minor}`;
  return { ...lifecycleFor(PYTHON_EOL[line], now), line };
}

module.exports = { REVIEWED_AT, NODE_EOL, PYTHON_EOL, WARN_DAYS, parseVersion, nodeLifecycle, pythonLifecycle };
