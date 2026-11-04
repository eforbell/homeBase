// A software authenticator for the passkey tests: it answers the options Home Base sends the way a browser
// passes an authenticator's answer on, with whatever flags and attestation a test needs. Hardware keys attest
// with the fixture chain in test/fixtures/attestation (a root pinned only in these tests, valid until 2126).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'attestation');

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const u32 = (value) => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };

// The little CBOR WebAuthn needs: maps, byte and text strings, and small integers.
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

function cosePublicKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
}

// The fixture chain: { roots } to pin, and the leaf (certificate and key) a hardware key attests with.
function attestationFixture() {
  const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  const rootPem = read('root.pem');
  const root = new crypto.X509Certificate(rootPem);
  const leaf = new crypto.X509Certificate(read('leaf.pem'));
  return {
    roots: [{ name: 'Home Base Test Root', fingerprint: root.fingerprint256, pem: rootPem.trim() }],
    x5c: [leaf.raw],
    key: crypto.createPrivateKey(read('leaf-key.pem')),
  };
}

// synced: backup-eligible and backed up (a synced passkey); hardware: single-device with packed attestation.
function createAuthenticator({ kind = 'synced', attestation = kind === 'hardware' ? attestationFixture() : null } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rawId = crypto.randomBytes(16);
  const id = b64(rawId);
  const aaguid = kind === 'hardware' ? Buffer.alloc(16, 7) : Buffer.alloc(16);
  const synced = kind === 'synced';
  let counter = 0;

  const flags = (extra = 0) => FLAGS.UP | FLAGS.UV | (synced ? FLAGS.BE | FLAGS.BS : 0) | extra;
  const clientData = (type, challenge, origin, extra = {}) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }));

  function register(options, { origin, rpID = options.rp.id, extra } = {}) {
    const clientDataJSON = clientData('webauthn.create', options.challenge, origin, extra);
    const authData = Buffer.concat([sha256(rpID), Buffer.from([flags(FLAGS.AT)]), u32(0), aaguid, Buffer.from([0, rawId.length]), rawId, cosePublicKey(publicKey)]);
    let fmt = 'none';
    let attStmt = new Map();
    if (attestation && options.attestation === 'direct') {
      fmt = 'packed';
      const sig = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), attestation.key);
      attStmt = new Map([['alg', -7], ['sig', sig], ['x5c', attestation.x5c]]);
    }
    const attestationObject = cbor(new Map([['fmt', fmt], ['attStmt', attStmt], ['authData', authData]]));
    return {
      id, rawId: id, type: 'public-key',
      response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ['usb'] },
      clientExtensionResults: {},
    };
  }

  function authenticate(options, { origin, rpID = options.rpId, extra, userHandle } = {}) {
    counter += 1;
    const clientDataJSON = clientData('webauthn.get', options.challenge, origin, extra);
    const authenticatorData = Buffer.concat([sha256(rpID), Buffer.from([flags()]), u32(counter)]);
    const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), privateKey);
    const response = { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature: b64(signature) };
    if (userHandle !== undefined) response.userHandle = userHandle;
    return { id, rawId: id, type: 'public-key', response, clientExtensionResults: {} };
  }

  return { id, register, authenticate };
}

module.exports = { attestationFixture, createAuthenticator };
