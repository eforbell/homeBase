const { PROTOCOL_VERSION, MAX_REQUEST_BYTES } = require('./protocol');

const SUPPORTED_OPERATION_TYPES = Object.freeze([
  'host.assert-debian-family', 'package.ensure', 'identity.ensure-user', 'filesystem.ensure-directory',
  'git.sync', 'postgres.ensure-role', 'postgres.ensure-database', 'filesystem.write-managed-file',
  'runtime.run-npm', 'systemd.daemon-reload', 'systemd.ensure-service', 'nginx.ensure-gateway', 'nginx.validate-and-reload', 'http.wait-ready',
]);

function executorCapabilities({ mutationsEnabled = false, gitDeployKey = 'missing' } = {}) {
  return {
    executorVersion: '0.1.0',
    protocolVersions: [PROTOCOL_VERSION],
    policyVersion: 'family-dinner-v1',
    supportedOperationTypes: SUPPORTED_OPERATION_TYPES,
    maximumRequestBytes: MAX_REQUEST_BYTES,
    mutationsEnabled,
    gitDeployKey,
  };
}

module.exports = { SUPPORTED_OPERATION_TYPES, executorCapabilities };
