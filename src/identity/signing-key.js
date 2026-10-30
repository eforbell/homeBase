// Feature-10 SID-005: the Ed25519 key that signs assurance cookies and action tokens (sovereignAuth wire
// contract, section 6). Home Base's alone: a file only the Home Base user can read, created once, beside the
// state database and never in the snapshot directory. Its public half goes into the snapshot so apps can
// verify what it signs. Losing the file only ends sessions: a new key is made and everyone checks again.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The kid names the key by its public half, so the same file always gives the same kid.
function describeKey(privateKey) {
  const publicKey = crypto.createPublicKey(privateKey);
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const kid = `k-${crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 16)}`;
  return { kid, privateKey, publicKey, published: { kid, public_key: raw.toString('base64url') } };
}

// create: make the key when there is none (Home Base itself). Without it (root's CLI), a missing key is
// null and nothing is made.
function loadSigningKey(file, { create = false } = {}) {
  let pem;
  try {
    pem = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) return null;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    // Never over an existing file: two starts racing keep whichever wrote first.
    try {
      fs.writeFileSync(file, pem, { mode: 0o600, flag: 'wx' });
    } catch (raced) {
      if (raced.code !== 'EEXIST') throw raced;
      pem = fs.readFileSync(file, 'utf8');
    }
  }
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${file} must be readable by its owner only (mode 600)`);
  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`${file} is not an Ed25519 key`);
  return describeKey(privateKey);
}

module.exports = { loadSigningKey };
