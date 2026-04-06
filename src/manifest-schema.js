const manifestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://sovereignhome.app/schemas/managed-app-manifest.schema.json',
  title: 'Sovereign Home Managed App Manifest',
  type: 'object',
  required: ['id', 'name', 'repository', 'runtime', 'network', 'database', 'service', 'config'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    purpose: { type: 'string' },
    repository: {
      type: 'object',
      required: ['url', 'defaultRef'],
      properties: {
        url: { type: 'string' },
        defaultRef: { type: 'string' },
      },
    },
    runtime: {
      type: 'object',
      required: ['kind', 'installCommand', 'startCommand'],
      properties: {
        kind: { enum: ['node', 'python'] },
        installCommand: { type: 'string' },
        startCommand: { type: 'string' },
      },
    },
    network: {
      type: 'object',
      required: ['preferredMountPath', 'preferredPort', 'health'],
      properties: {
        preferredMountPath: { type: 'string' },
        preferredPort: { type: 'number' },
        upstreamBind: { type: 'string' },
      },
    },
    database: {
      type: 'object',
      required: ['engine', 'bootstrap'],
      properties: {
        engine: { type: 'string' },
        bootstrap: { type: 'string' },
        databaseName: { type: 'string' },
        databaseUser: { type: 'string' },
      },
    },
    service: {
      type: 'object',
      required: ['name', 'description'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
      },
    },
    config: {
      type: 'object',
      required: ['env'],
      properties: {
        env: { type: 'object' },
      },
    },
  },
};

function validateManifestEntry(entry) {
  const errors = [];

  function expectString(value, path) {
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${path} must be a non-empty string`);
    }
  }

  function expectObject(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path} must be an object`);
      return false;
    }
    return true;
  }

  if (!expectObject(entry, 'entry')) return errors;
  expectString(entry.id, 'id');
  expectString(entry.name, 'name');
  if (expectObject(entry.repository, 'repository')) {
    expectString(entry.repository.url, 'repository.url');
    expectString(entry.repository.defaultRef, 'repository.defaultRef');
    if (entry.repository.sshUrl != null) {
      expectString(entry.repository.sshUrl, 'repository.sshUrl');
    }
  }
  if (expectObject(entry.runtime, 'runtime')) {
    expectString(entry.runtime.kind, 'runtime.kind');
    expectString(entry.runtime.installCommand, 'runtime.installCommand');
    expectString(entry.runtime.startCommand, 'runtime.startCommand');
  }
  if (expectObject(entry.network, 'network')) {
    expectString(entry.network.preferredMountPath, 'network.preferredMountPath');
    if (typeof entry.network.preferredPort !== 'number') {
      errors.push('network.preferredPort must be a number');
    }
    if (!expectObject(entry.network.health, 'network.health')) {
      // already recorded
    } else {
      expectString(entry.network.health.type, 'network.health.type');
      expectString(entry.network.health.livenessPath, 'network.health.livenessPath');
      expectString(entry.network.health.readinessPath, 'network.health.readinessPath');
    }
  }
  if (expectObject(entry.database, 'database')) {
    expectString(entry.database.engine, 'database.engine');
    expectString(entry.database.bootstrap, 'database.bootstrap');
  }
  if (expectObject(entry.service, 'service')) {
    expectString(entry.service.name, 'service.name');
    expectString(entry.service.description, 'service.description');
  }
  if (expectObject(entry.config, 'config')) {
    if (!expectObject(entry.config.env, 'config.env')) {
      // already recorded
    }
  }

  return errors;
}

module.exports = {
  manifestSchema,
  validateManifestEntry,
};
