const { hello } = require('./client');

async function getExecutorCapabilities(socketPath, options) {
  const response = await hello(socketPath, options);
  return response.capabilities || null;
}

function isProtocolCompatible(capabilities) {
  return Boolean(capabilities && capabilities.protocolVersions?.includes(1) && capabilities.policyVersion === 'family-dinner-v1');
}

function canExecuteMutations(capabilities) {
  return isProtocolCompatible(capabilities) && capabilities.mutationsEnabled === true;
}

module.exports = { getExecutorCapabilities, isProtocolCompatible, canExecuteMutations };
