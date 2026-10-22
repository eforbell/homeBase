// Root certificates known to be unsafe to trust, by SHA-256 fingerprint of the DER certificate. Kept by
// hand like security-floors.js, and only from a published removal (a CA-bundle release that dropped the
// root because of an incident), never a guess. Routine removals (expiry, ordinary program changes) are
// not listed: they are not evidence that trusting the root is unsafe. REVIEWED_AT ships with every report.
const crypto = require('crypto');

// The host's TLS trust: what system OpenSSL, curl, apt, the distribution pip, and Node.js with
// --use-system-ca trust. Readable by every user, so the web service reads it as well as the executor.
const HOST_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';

const REVIEWED_AT = '2026-10-22';

function normalizeFingerprint(value) {
  return String(value || '').replace(/:/g, '').toLowerCase();
}

// Entries are normalized when the table loads, so one written in upper case or with colons still
// matches; anything that is then not a SHA-256 is a typo that would silently never match, so it throws.
const entry = (root) => {
  const sha256 = normalizeFingerprint(root.sha256);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`distrusted root ${root.subject}: sha256 is not a SHA-256 fingerprint`);
  return Object.freeze({ ...root, sha256 });
};

const DISTRUSTED_ROOTS = Object.freeze([
  entry({
    sha256: '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
    subject: 'CN=emSign ECC Root CA - G3, O=eMudhra Technologies Limited, OU=emSign PKI, C=IN',
    incident: 'eMudhra/emSign CA incident',
    since: '2026-10-20',
    // certifi 2026.10.19 removed exactly this emSign root (diffed against 2026.5.20, both verified against
    // PyPI digests) and kept emSign Root CA - G1, Root CA - C1, and ECC Root CA - C3 as unaffected.
    source: 'Removed in certifi 2026.10.19',
    reference: 'https://discuss.python.org/t/information-for-python-users-regarding-emudhra-emsign-ca-certificate-security-incident/109576',
  }),
]);

// Fingerprints in `fingerprints` that are on the distrusted list, with what is known about each.
function distrustedIn(fingerprints, roots = DISTRUSTED_ROOTS) {
  const present = new Set([...fingerprints].map(normalizeFingerprint));
  return roots.filter((root) => present.has(normalizeFingerprint(root.sha256)));
}

// One CA store, as SHA-256 fingerprints of its certificates (no commands: Node's X509Certificate).
// invalid counts blocks that could not be parsed, including a BEGIN with no END (a truncated file):
// a root this cannot read may be one on the list, and TLS libraries differ on what they skip, so a
// store with any is not reported clean.
function assessCertificates(pems) {
  const fingerprints = [];
  let invalid = 0;
  for (const pem of pems) {
    try { fingerprints.push(new crypto.X509Certificate(pem).fingerprint256); } catch { invalid += 1; }
  }
  return { certificates: fingerprints.length, invalid, distrusted: distrustedIn(fingerprints) };
}
function assessPemBundle(text) {
  const source = String(text || '');
  const blocks = source.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  const begins = (source.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
  const store = assessCertificates(blocks);
  return { ...store, invalid: store.invalid + Math.max(0, begins - blocks.length) };
}

// What a store's assessment says about trusting it: distrusted (a listed root is present, whatever else
// is wrong), unknown (unreadable, empty, or with blocks that could not be parsed), or verified: none of
// the listed roots, as of REVIEWED_AT. Not a claim that every root in it is sound.
function storeTrust(store) {
  if (!store) return 'unknown';
  if (store.distrusted?.length) return 'distrusted';
  if (store.unreadable || !store.certificates || store.invalid) return 'unknown';
  return 'verified';
}

module.exports = { HOST_CA_BUNDLE, REVIEWED_AT, DISTRUSTED_ROOTS, normalizeFingerprint, distrustedIn, assessCertificates, assessPemBundle, storeTrust };
