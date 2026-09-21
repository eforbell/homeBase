const { hello } = require('./client');

async function getExecutorCapabilities(socketPath, options) {
  const response = await hello(socketPath, options);
  return response.capabilities || null;
}

function isCompatible(capabilities) {
  return Boolean(capabilities && capabilities.protocolVersions?.includes(1) && capabilities.mutationsEnabled === true);
}

module.exports = { getExecutorCapabilities, isCompatible };
