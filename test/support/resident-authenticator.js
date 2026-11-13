// A stateful physical-key model for resident-credential tests. The signing fixture makes a new key/ID
// per registration; this wrapper models what remains available on that physical authenticator.
// Mirrored in homeBase and sovereignAuth. id is the latest registration, undefined before any registration.
const crypto = require('node:crypto');
const { createAuthenticator } = require('./authenticator');

function createResidentAuthenticator({ resident = true, ...authenticatorOptions } = {}) {
  authenticatorOptions.aaguid ??= crypto.randomBytes(16);
  const held = new Map();
  let lastId;

  function register(options, settings = {}) {
    const rpID = options.rp.id; // Hash-forging settings belong to the signer, not physical storage.
    const encoded = options.user?.id;
    const bytes = typeof encoded === 'string' ? Buffer.from(encoded, 'base64url') : Buffer.alloc(0);
    if (!bytes.length || bytes.length > 64 || bytes.toString('base64url') !== encoded) {
      throw new TypeError('user.id must be a canonical base64url handle of 1-64 bytes.');
    }
    const userHandle = bytes.toString('base64url');
    if ((options.excludeCredentials || []).some(({ id }) => held.get(id)?.rpID === rpID)) {
      throw new DOMException('This authenticator already holds an excluded credential.', 'InvalidStateError');
    }
    // Fixture convention, not a claim about a browser's eventual error for an incapable key.
    if (!resident && options.authenticatorSelection?.residentKey === 'required') {
      throw new DOMException('This authenticator does not support resident credentials.', 'NotSupportedError');
    }
    const signer = createAuthenticator(authenticatorOptions);
    const response = signer.register(options, settings);
    if (resident) {
      for (const [id, credential] of held) {
        if (credential.resident && credential.rpID === rpID && credential.userHandle === userHandle) held.delete(id);
      }
    }
    held.set(response.id, { signer, rpID, userHandle, resident });
    lastId = response.id;
    return response;
  }

  function authenticate(options, settings = {}) {
    const allowed = options.allowCredentials || [];
    const selected = allowed.length
      ? allowed.find(({ id }) => held.get(id)?.rpID === options.rpId)?.id
      : [...held].find(([, credential]) => credential.resident && credential.rpID === options.rpId)?.[0];
    if (!selected) throw new DOMException('No offered credential is held for this RP ID.', 'NotAllowedError');
    const credential = held.get(selected);
    const userHandle = Object.hasOwn(settings, 'userHandle') ? settings.userHandle : credential.resident ? credential.userHandle : undefined;
    return credential.signer.authenticate(options, { ...settings, userHandle });
  }

  return { get id() { return lastId; }, register, authenticate, hasCredential: (id) => held.has(id) };
}

module.exports = { createResidentAuthenticator };
