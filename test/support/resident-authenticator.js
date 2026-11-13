// A stateful physical-key model for resident-credential tests. The signing fixture makes a new key/ID
// per registration; this wrapper models what remains available on that physical authenticator.
const { createAuthenticator } = require('./authenticator');

function createResidentAuthenticator({ resident = true, ...authenticatorOptions } = {}) {
  const held = new Map();
  let lastId;

  function register(options, settings = {}) {
    const rpID = settings.rpID ?? options.rp.id;
    const userHandle = Buffer.from(options.user.id, 'base64url').toString('base64url');
    if ((options.excludeCredentials || []).some(({ id }) => held.get(id)?.rpID === rpID)) {
      throw new DOMException('This authenticator already holds an excluded credential.', 'InvalidStateError');
    }
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
