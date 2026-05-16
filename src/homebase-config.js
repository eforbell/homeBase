const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const DOMAIN_PATTERN = /^[a-z0-9.-]{1,253}$/i;
const ALLOWED_GIT_TRANSPORTS = new Set(['https', 'ssh', 'ssh-key']);
const TAILSCALE_MANAGED_SERVICE_ID_PATTERN = /^svc:[a-z0-9](?:[a-z0-9-_.]{0,61}[a-z0-9])?$/i;
const TIMEZONE_PATTERN = /^[A-Za-z_]+\/[A-Za-z_\/-]+$/;

function mergeHomeBaseConfig(baseConfig, override = {}) {
  return {
    ...baseConfig,
    defaultHostname: override.hostname || baseConfig.defaultHostname || 'homebase',
    defaultDomain: override.domain || baseConfig.defaultDomain || 'tailnet',
    gitTransport: override.gitTransport || baseConfig.gitTransport || 'https',
    gitSshKeyPath: override.gitSshKeyPath != null ? override.gitSshKeyPath : (baseConfig.gitSshKeyPath || ''),
    healthAlertsEnabled: override.healthAlertsEnabled != null ? Boolean(override.healthAlertsEnabled) : Boolean(baseConfig.healthAlertsEnabled),
    healthAlertsWebhookUrl: override.healthAlertsWebhookUrl != null ? String(override.healthAlertsWebhookUrl) : String(baseConfig.healthAlertsWebhookUrl || ''),
    tailscaleManagedServiceId: override.tailscaleManagedServiceId || baseConfig.tailscaleManagedServiceId || 'svc:home',
    householdTimezone: override.householdTimezone || baseConfig.householdTimezone || 'America/New_York',
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
    healthAlertsEnabled: Boolean(effective.healthAlertsEnabled),
    healthAlertsWebhookUrl: effective.healthAlertsWebhookUrl || '',
    tailscaleManagedServiceId: effective.tailscaleManagedServiceId || 'svc:home',
    householdTimezone: effective.householdTimezone || 'America/New_York',
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
  const allowedFields = ['hostname', 'domain', 'gitTransport', 'gitSshKeyPath', 'healthAlertsEnabled', 'healthAlertsWebhookUrl', 'tailscaleManagedServiceId', 'householdTimezone'];
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
    healthAlertsEnabled: patch.healthAlertsEnabled != null ? Boolean(patch.healthAlertsEnabled) : Boolean(currentConfig.healthAlertsEnabled),
    healthAlertsWebhookUrl: patch.healthAlertsWebhookUrl != null ? String(patch.healthAlertsWebhookUrl).trim() : String(currentConfig.healthAlertsWebhookUrl || ''),
    tailscaleManagedServiceId: patch.tailscaleManagedServiceId != null ? String(patch.tailscaleManagedServiceId).trim() : String(currentConfig.tailscaleManagedServiceId || 'svc:home'),
    householdTimezone: patch.householdTimezone != null ? String(patch.householdTimezone).trim() : String(currentConfig.householdTimezone || 'America/New_York'),
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
  if (candidate.healthAlertsWebhookUrl) {
    try {
      const parsed = new URL(candidate.healthAlertsWebhookUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { error: 'healthAlertsWebhookUrl must use http or https' };
      }
    } catch (_error) {
      return { error: 'healthAlertsWebhookUrl must be a valid absolute URL when provided' };
    }
  }
  if (candidate.healthAlertsEnabled && !candidate.healthAlertsWebhookUrl) {
    return { error: 'healthAlertsWebhookUrl is required when healthAlertsEnabled=true' };
  }

  if (!TAILSCALE_MANAGED_SERVICE_ID_PATTERN.test(candidate.tailscaleManagedServiceId)) {
    return { error: 'tailscaleManagedServiceId must look like svc:<name> using letters, numbers, dashes, underscores, or dots' };
  }

  if (!TIMEZONE_PATTERN.test(candidate.householdTimezone)) {
    return { error: 'householdTimezone must be a valid IANA timezone (e.g. America/New_York)' };
  }

  return { value: candidate };
}

module.exports = {
  ALLOWED_GIT_TRANSPORTS,
  mergeHomeBaseConfig,
  toClientHomeBaseConfig,
  validateHomeBaseConfigPatch,
};
