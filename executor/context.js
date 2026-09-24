const { PROTOCOL_VERSION, MAX_REQUEST_BYTES } = require('./protocol');
const { ACTIONS, INSTALLABLE_APPS } = require('./actions');

const { PROFILE_TYPES } = require('../src/operations/policy');

// Derived from the policy so the advertised surface can never drift from what is enforced.
const SUPPORTED_OPERATION_TYPES = Object.freeze([...new Set(Object.values(PROFILE_TYPES).flatMap((types) => [...types]))].sort());
const POLICY_PROFILES = Object.freeze(Object.keys(PROFILE_TYPES));

function executorCapabilities({ mutationsEnabled = false, gitDeployKey = 'missing' } = {}) {
  return {
    executorVersion: '0.1.0',
    protocolVersions: [PROTOCOL_VERSION],
    policyProfiles: POLICY_PROFILES,
    actions: Object.keys(ACTIONS),
    installableApps: INSTALLABLE_APPS,
    supportedOperationTypes: SUPPORTED_OPERATION_TYPES,
    maximumRequestBytes: MAX_REQUEST_BYTES,
    mutationsEnabled,
    gitDeployKey,
  };
}

module.exports = { SUPPORTED_OPERATION_TYPES, executorCapabilities };
