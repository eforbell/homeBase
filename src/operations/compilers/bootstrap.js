const { operation, planEnvelope } = require('./common');

function buildHostBootstrapPlan({ generatedAt, catalogRevision } = {}) {
  const directories = ['sovereign-root', 'app-root', 'sovereign-home', 'backup-root', 'config-root', 'nginx-snippets', 'nginx-apps'];
  const operations = [
    operation({ id: 'assert-os', type: 'host.assert-debian-family', title: 'Verify a supported Debian-family host', risk: 'read', timeoutMs: 5000 }),
    operation({ id: 'install-packages', type: 'package.ensure', title: 'Install Sovereign Home host packages', timeoutMs: 600000, dependsOn: ['assert-os'], preconditions: ['supported-os'], packages: ['git', 'ca-certificates', 'openssh-client', 'ssl-cert', 'nginx', 'postgresql', 'postgresql-client', 'nodejs', 'npm'], updateCache: true }),
    operation({ id: 'ensure-sovereign', type: 'identity.ensure-user', title: 'Ensure the sovereign runtime identity', dependsOn: ['install-packages'], user: 'sovereign' }),
    ...directories.map((purpose, index) => operation({ id: `ensure-${purpose}`, type: 'filesystem.ensure-directory', title: `Ensure ${purpose.replaceAll('-', ' ')} directory`, dependsOn: index ? [`ensure-${directories[index - 1]}`] : ['ensure-sovereign'], purpose })),
    operation({ id: 'enable-postgresql', type: 'systemd.ensure-service', title: 'Enable PostgreSQL', dependsOn: [`ensure-${directories.at(-1)}`], unit: 'postgresql.service', action: 'enable-and-restart' }),
    operation({ id: 'install-gateway', type: 'nginx.ensure-gateway', title: 'Install the managed nginx gateway site', dependsOn: ['enable-postgresql'] }),
    operation({ id: 'enable-nginx', type: 'systemd.ensure-service', title: 'Enable nginx', dependsOn: ['install-gateway'], unit: 'nginx.service', action: 'enable-and-restart' }),
    operation({ id: 'validate-nginx', type: 'nginx.validate-and-reload', title: 'Validate nginx configuration', dependsOn: ['enable-nginx'] }),
  ];
  return planEnvelope({ kind: 'host-bootstrap', target: 'local-host', policyProfile: 'host-bootstrap-v1', operations, generatedAt, catalogRevision });
}

module.exports = { buildHostBootstrapPlan };
