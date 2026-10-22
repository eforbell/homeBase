// Root certificates known to be unsafe to trust, by SHA-256 fingerprint of the DER certificate. Kept by
// hand like security-floors.js, and only from a published removal (a CA-bundle release that dropped the
// root because of an incident), never a guess. Routine removals (expiry, ordinary program changes) are
// not listed: they are not evidence that trusting the root is unsafe. REVIEWED_AT ships with every report.
const REVIEWED_AT = '2026-10-22';

const DISTRUSTED_ROOTS = Object.freeze([
  Object.freeze({
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

function normalizeFingerprint(value) {
  return String(value || '').replace(/:/g, '').toLowerCase();
}

// Fingerprints in `fingerprints` that are on the distrusted list, with what is known about each.
function distrustedIn(fingerprints, roots = DISTRUSTED_ROOTS) {
  const present = new Set([...fingerprints].map(normalizeFingerprint));
  return roots.filter((root) => present.has(root.sha256));
}

module.exports = { REVIEWED_AT, DISTRUSTED_ROOTS, normalizeFingerprint, distrustedIn };
