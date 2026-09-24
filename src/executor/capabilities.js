const { hello } = require('./client');
const { PROTOCOL_VERSION } = require('../../executor/protocol');

async function getExecutorCapabilities(socketPath, options) {
  const response = await hello(socketPath, options);
  return response.capabilities || null;
}

function isProtocolCompatible(capabilities) {
  return Boolean(capabilities && capabilities.protocolVersions?.includes(PROTOCOL_VERSION) && capabilities.actions?.includes('install'));
}

function canExecuteMutations(capabilities) {
  return isProtocolCompatible(capabilities) && capabilities.mutationsEnabled === true;
}

module.exports = { getExecutorCapabilities, isProtocolCompatible, canExecuteMutations };
