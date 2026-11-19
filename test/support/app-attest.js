// A fake Apple for the app-instance tests: its own App Attestation and receipt roots (pinned only by the tests
// that pass them in), and a device that attests keys and asserts with them, the way the household's iPhone app
// does (sovereignAuth docs/native-handoff.md). Trimmed from sovereignAuth's test/support/appattest.js, which
// also gets each part wrong on purpose; the checks themselves are sovereignAuth's and tested there.
const crypto = require('crypto');
const x509 = require('@peculiar/x509');

x509.cryptoProvider.set(crypto.webcrypto);

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const DAY = 24 * 60 * 60 * 1000;
const OID = {
  nonce: '1.2.840.113635.100.8.2',
  receiptSigner: '1.2.840.113635.100.12.15',
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  sha256: '2.16.840.1.101.3.4.2.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
};
const AAGUID = { production: Buffer.from('appattest\0\0\0\0\0\0\0', 'latin1'), development: Buffer.from('appattestdevelop', 'latin1') };

const sha256 = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts.map((part) => Buffer.from(part)))).digest();
const u32 = (value) => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };

// The little CBOR an attestation object needs: maps, arrays, byte and text strings, small integers.
function cbor(value) {
  const head = (major, length) => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  };
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Number.isInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
  throw new Error(`no CBOR for ${typeof value}`);
}

// DER, as much as a receipt needs.
function length(n) {
  if (n < 128) return Buffer.from([n]);
  const out = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) out.unshift(x & 255);
  return Buffer.from([0x80 | out.length, ...out]);
}
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts.map((part) => Buffer.from(part))); return Buffer.concat([Buffer.from([tag]), length(body.length), body]); };
const int = (n) => tlv(0x02, Buffer.from([n]));
function oid(text) {
  const arcs = text.split('.').map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const group = [arc & 0x7f];
    for (let x = Math.floor(arc / 128); x > 0; x = Math.floor(x / 128)) group.unshift((x & 0x7f) | 0x80);
    out.push(...group);
  }
  return tlv(0x06, Buffer.from(out));
}

// The children of a DER element's content, as [start, end] ranges.
function children(buf, start = 0) {
  let i = start + 1;
  let n = buf[i++];
  if (n & 0x80) { const count = n & 0x7f; n = 0; for (let k = 0; k < count; k++) n = n * 256 + buf[i++]; }
  const out = [];
  for (let at = i; at < i + n;) {
    let j = at + 1;
    let m = buf[j++];
    if (m & 0x80) { const count = m & 0x7f; m = 0; for (let k = 0; k < count; k++) m = m * 256 + buf[j++]; }
    out.push([at, j + m]);
    at = j + m;
  }
  return out;
}

// issuerAndSerialNumber for a certificate: SEQUENCE { issuer Name, serialNumber INTEGER }.
function issuerAndSerial(der) {
  const [tbs] = children(der);
  const fields = children(der, tbs[0]);
  const [serial, , issuer] = der[fields[0][0]] === 0xa0 ? fields.slice(1) : fields;
  return tlv(0x30, der.subarray(...issuer), der.subarray(...serial));
}

async function certificate({ name, issuer = null, ca = true, keys = null, extensions = [] }) {
  keys ||= await crypto.webcrypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const fields = {
    serialNumber: crypto.randomBytes(8).toString('hex').replace(/^[89a-f]/, '1'),
    subject: `CN=${name}`,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 365 * DAY),
    signingAlgorithm: ECDSA,
    extensions: [new x509.BasicConstraintsExtension(ca, undefined, true), ...extensions.map(([id, value]) => new x509.Extension(id, false, value))],
  };
  const cert = issuer
    ? await x509.X509CertificateGenerator.create({ ...fields, issuer: issuer.cert.subject, publicKey: keys.publicKey, signingKey: issuer.keys.privateKey })
    : await x509.X509CertificateGenerator.createSelfSigned({ ...fields, name: fields.subject, keys });
  const der = Buffer.from(cert.rawData);
  return {
    cert,
    keys,
    der,
    key: crypto.KeyObject.from(keys.privateKey),
    pin: () => ({ name, fingerprint: new crypto.X509Certificate(der).fingerprint256, pem: cert.toString('pem') }),
  };
}

// A receipt as Apple makes one: CMS SignedData over a SET of { type, version, value } fields, with no signed
// attributes.
function receipt({ fields, signer, chain }) {
  const payload = tlv(0x31, ...Object.entries(fields).map(([type, value]) => tlv(0x30, int(Number(type)), int(1), tlv(0x04, value))));
  const algorithm = (id) => tlv(0x30, oid(id), Buffer.from([0x05, 0x00]));
  const signerInfo = tlv(0x30, int(1), issuerAndSerial(signer.der), algorithm(OID.sha256), tlv(0x30, oid(OID.ecdsaSha256)), tlv(0x04, crypto.sign('sha256', payload, signer.key)));
  return tlv(0x30, oid(OID.signedData), tlv(0xa0, tlv(0x30,
    int(1), tlv(0x31, algorithm(OID.sha256)),
    tlv(0x30, oid(OID.data), tlv(0xa0, tlv(0x04, payload))),
    tlv(0xa0, ...chain.map((c) => c.der)),
    tlv(0x31, signerInfo))));
}

// createFakeApple({ appId }) -> { roots, attest({ clientData, environment }), assert(device, { clientData }) }.
// roots is in sovereignAuth's appattest-roots.json format, for verifyAttestation's roots option.
async function createFakeApple({ appId }) {
  const root = await certificate({ name: 'Fake App Attestation Root' });
  const intermediate = await certificate({ name: 'Fake App Attestation CA', issuer: root });
  const receiptRoot = await certificate({ name: 'Fake Root CA - G3' });
  const receiptIntermediate = await certificate({ name: 'Fake Application Integration CA', issuer: receiptRoot });
  const receiptSigner = await certificate({ name: 'Fake Receipt Signing', issuer: receiptIntermediate, ca: false, extensions: [[OID.receiptSigner, Buffer.from([0x05, 0x00])]] });

  // A new device key, attested over clientData (what the app passes the SHA-256 of to attestKey).
  async function attest({ clientData, environment = 'production', created = new Date() }) {
    const keys = await crypto.webcrypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
    const jwk = await crypto.webcrypto.subtle.exportKey('jwk', keys.publicKey);
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    const keyId = sha256(point);
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const authData = Buffer.concat([sha256(appId), Buffer.from([0x40]), u32(0), AAGUID[environment], Buffer.from([0, 32]), keyId, cose]);
    const hash = sha256(clientData);
    const nonce = sha256(authData, hash);
    const leaf = await certificate({ name: 'Fake credential', issuer: intermediate, ca: false, keys, extensions: [[OID.nonce, tlv(0x30, tlv(0xa1, tlv(0x04, nonce)))]] });
    const fields = {
      2: Buffer.from(appId),
      3: leaf.der,
      4: hash,
      5: crypto.randomBytes(16),
      6: Buffer.from('ATTEST'),
      12: Buffer.from(created.toISOString()),
      21: Buffer.from(new Date(created.getTime() + 90 * DAY).toISOString()),
    };
    const attestation = cbor(new Map([
      ['fmt', 'apple-appattest'],
      ['attStmt', new Map([['x5c', [leaf.der, intermediate.der]], ['receipt', receipt({ fields, signer: receiptSigner, chain: [receiptSigner, receiptIntermediate, receiptRoot] })]])],
      ['authData', authData],
    ]));
    return {
      attestation: attestation.toString('base64'),
      keyId: keyId.toString('base64'),
      device: { key: crypto.KeyObject.from(keys.privateKey), counter: 0 },
    };
  }

  // An assertion over clientData; the device's counter rises unless counter says otherwise.
  function assert(device, { clientData, counter = device.counter + 1 }) {
    device.counter = counter;
    const authData = Buffer.concat([sha256(appId), Buffer.from([0x40]), u32(counter)]);
    const signature = crypto.sign('sha256', sha256(authData, sha256(clientData)), device.key);
    return cbor(new Map([['signature', signature], ['authenticatorData', authData]])).toString('base64');
  }

  return { roots: { attestation: [root.pin()], receipt: [receiptRoot.pin()] }, attest, assert };
}

module.exports = { createFakeApple };
