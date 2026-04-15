const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const DOMAIN_PATTERN = /^[a-z0-9.-]{1,253}$/i;
const ALLOWED_GIT_TRANSPORTS = new Set(['https', 'ssh', 'ssh-key']);

function mergeHomeBaseConfig(baseConfig, override = {}) {
  return {
    ...baseConfig,
    defaultHostname: override.hostname || baseConfig.defaultHostname || 'homebase',
    defaultDomain: override.domain || baseConfig.defaultDomain || 'tailnet',
    gitTransport: override.gitTransport || baseConfig.gitTransport || 'https',
    gitSshKeyPath: override.gitSshKeyPath != null ? override.gitSshKeyPath : (baseConfig.gitSshKeyPath || ''),
  };
}

function toClientHomeBaseConfig(config, override = {}) {
  const effective = mergeHomeBaseConfig(config, override);
  const hostname = effective.defaultHostname || 'homebase';
  const domain = effective.defaultDomain || 'tailnet';
  return {
    hostname,
    domain,
    gitTransport: effective.gitTransport || 'https',
    gitSshKeyPath: effective.gitSshKeyPath || '',
    serviceUser: config.serviceUser,
    baseInstallDir: config.baseInstallDir,
    baseBackupDir: config.baseBackupDir,
    port: config.port,
    hostnameIsPlaceholder: hostname.toLowerCase() === 'homebase',
    updatedAt: override.updatedAt || null,
  };
}

function validateHostname(hostname) {
  const value = String(hostname || '').trim();
  if (!value) return 'hostname is required';
  if (!HOSTNAME_PATTERN.test(value)) {
    return 'hostname must contain only letters, numbers, and dashes (RFC-1123 label format)';
  }
  return null;
}

function validateDomain(domain) {
  const value = String(domain || '').trim();
  if (!value) return 'domain is required';
  if (!DOMAIN_PATTERN.test(value) || value.includes('..') || value.startsWith('.') || value.endsWith('.')) {
    return 'domain must contain only letters, numbers, dots, and dashes';
  }
  return null;
}

function validateHomeBaseConfigPatch(payload, currentConfig) {
  const patch = payload && typeof payload === 'object' ? payload : {};
  const allowedFields = ['hostname', 'domain', 'gitTransport', 'gitSshKeyPath'];
  const unknownFields = Object.keys(patch).filter((field) => !allowedFields.includes(field));
  if (unknownFields.length) {
    return { error: `Unknown field(s): ${unknownFields.join(', ')}` };
  }
  if (Object.keys(patch).length === 0) {
    return { error: 'At least one writable field is required' };
  }

  const candidate = {
    hostname: patch.hostname != null ? String(patch.hostname).trim() : currentConfig.hostname,
    domain: patch.domain != null ? String(patch.domain).trim() : currentConfig.domain,
    gitTransport: patch.gitTransport != null ? String(patch.gitTransport).trim() : currentConfig.gitTransport,
    gitSshKeyPath: patch.gitSshKeyPath != null ? String(patch.gitSshKeyPath).trim() : (currentConfig.gitSshKeyPath || ''),
  };

  const hostnameError = validateHostname(candidate.hostname);
  if (hostnameError) return { error: hostnameError };
  const domainError = validateDomain(candidate.domain);
  if (domainError) return { error: domainError };

  if (!ALLOWED_GIT_TRANSPORTS.has(candidate.gitTransport)) {
    return { error: 'gitTransport must be one of: https, ssh, ssh-key' };
  }
  if (candidate.gitSshKeyPath && !candidate.gitSshKeyPath.startsWith('/')) {
    return { error: 'gitSshKeyPath must be an absolute path when provided' };
  }
  if (candidate.gitTransport === 'ssh-key' && !candidate.gitSshKeyPath) {
    return { error: 'gitSshKeyPath is required when gitTransport=ssh-key' };
  }

  return { value: candidate };
}

module.exports = {
  ALLOWED_GIT_TRANSPORTS,
  mergeHomeBaseConfig,
  toClientHomeBaseConfig,
  validateHomeBaseConfigPatch,
};
