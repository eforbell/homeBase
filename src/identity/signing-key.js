// Feature-10 SID-005: the Ed25519 key that signs assurance cookies and action tokens (sovereignAuth wire
// contract, section 6). Home Base's alone: a file only the Home Base user can read, created once, beside the
// state database and never in the snapshot directory. Its public half goes into the snapshot so apps can
// verify what it signs. Losing the file only ends sessions: a new key is made and everyone checks again.
//
// Rotation makes a new key and keeps the previous public halves in a list beside it, published for one
// session window (the longest session a cookie can carry), so nobody's session ends because of a rotation.
// A key that may have been exposed is dropped at once instead: then every session it signed ends.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { POLICY } = require('sovereign-auth');

// The longest session window any policy grants: a retired key outlives every cookie it signed.
const RETIRED_KEEP_SECONDS = Math.max(...Object.values(POLICY.policies).filter((policy) => policy.level === 'session').map((policy) => policy.window_seconds));

// The kid names the key by its public half, so the same file always gives the same kid.
function describeKey(privateKey) {
  const publicKey = crypto.createPublicKey(privateKey);
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const kid = `k-${crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 16)}`;
  return { kid, privateKey, publicKey, published: { kid, public_key: raw.toString('base64url') } };
}

function ownerOnly(file) {
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${file} must be readable by its owner only (mode 600)`);
  return stat;
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
  const stat = ownerOnly(file);
  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`${file} is not an Ed25519 key`);
  return { ...describeKey(privateKey), createdAt: stat.mtime.toISOString() };
}

// The list of retired public keys beside the key file: [{ kid, public_key, retired_at }].
const retiredFile = (file) => path.join(path.dirname(file), `${path.basename(file, path.extname(file))}-retired.json`);

function readRetired(file) {
  const list = retiredFile(file);
  let text;
  try {
    text = fs.readFileSync(list, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  ownerOnly(list);
  const data = JSON.parse(text);
  if (!Array.isArray(data?.keys)) throw new Error(`${list} has no keys list`);
  return data.keys.filter((entry) => typeof entry?.kid === 'string' && typeof entry.public_key === 'string' && !Number.isNaN(Date.parse(entry.retired_at)));
}

// Written beside its target, flushed, then renamed into place and the directory flushed: a reader (or a
// restart after a power cut) sees the old file or the new one, and a rotation reported done stays done.
function writeDurably(target, content) {
  const temporary = `${target}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, target);
  const dir = fs.openSync(path.dirname(target), 'r');
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}

function writeRetired(file, keys) {
  writeDurably(retiredFile(file), `${JSON.stringify({ format: 1, keys }, null, 2)}\n`);
}

// The retired keys still within their window, never the current one: a rotation interrupted between its
// two writes lists the key that stayed current as retired too.
function retiredKeys(file, current, now) {
  const cutoff = now() - RETIRED_KEEP_SECONDS * 1000;
  const seen = new Set([current?.kid]);
  return readRetired(file).filter((entry) => Date.parse(entry.retired_at) > cutoff && !seen.has(entry.kid) && seen.add(entry.kid));
}

function publicKeyOf(entry) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: entry.public_key }, format: 'jwk' });
}

// What the snapshot lists: the current key first, then the retired ones still in their window. Root's CLI
// reads this too (without create), so a reset publishes the same keys Home Base does.
function publishedKeys(file, { now = Date.now } = {}) {
  const current = loadSigningKey(file);
  return [...(current ? [current.published] : []), ...retiredKeys(file, current, now).map(({ kid, public_key: key }) => ({ kid, public_key: key }))];
}

// Home Base's keys while it runs: current() signs, verifying() is every key a token may verify against, and
// rotate() replaces the current key. Everything is read again from the files after a rotation.
function createKeyring(file, { now = Date.now } = {}) {
  let current = loadSigningKey(file, { create: true });

  function verifying() {
    return new Map([[current.kid, current.publicKey], ...retiredKeys(file, current, now).map((entry) => [entry.kid, publicKeyOf(entry)])]);
  }

  // exposed: the current key (and every earlier one) may be known to someone else, so none of them is kept.
  function rotate({ exposed = false } = {}) {
    const previous = current;
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    try {
      // The list first: if the key never lands, the old key is still current and still verifies.
      writeRetired(file, exposed ? [] : [{ ...previous.published, retired_at: new Date(now()).toISOString() }, ...retiredKeys(file, previous, now)]);
      writeDurably(file, privateKey.export({ format: 'pem', type: 'pkcs8' }));
    } finally {
      // Whatever the files now say, failed or not: Home Base signs with the key the snapshot publishes.
      current = loadSigningKey(file);
    }
    return { kid: current.kid, retired: exposed ? [] : [previous.kid], dropped: exposed };
  }

  return {
    current: () => current,
    verifying,
    published: () => publishedKeys(file, { now }),
    describe: () => ({ kid: current.kid, createdAt: current.createdAt, previous: retiredKeys(file, current, now).map(({ kid, retired_at: retiredAt }) => ({ kid, retiredAt })) }),
    rotate,
  };
}

module.exports = { RETIRED_KEEP_SECONDS, createKeyring, loadSigningKey, publishedKeys };
