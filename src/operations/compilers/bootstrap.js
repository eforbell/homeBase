const { operation, planEnvelope } = require('./common');

function buildDinnerBootstrapPlan({ generatedAt, catalogRevision } = {}) {
  const operations = [
    operation({ id: 'assert-os', type: 'host.assert-debian-family', title: 'Verify a supported Debian-family host', risk: 'read', timeoutMs: 5000 }),
    operation({ id: 'install-packages', type: 'package.ensure', title: 'Install Family Dinner host packages', timeoutMs: 600000, dependsOn: ['assert-os'], preconditions: ['supported-os'], packages: ['git', 'ca-certificates', 'ssl-cert', 'nginx', 'postgresql', 'postgresql-client', 'nodejs', 'npm'], updateCache: true }),
    operation({ id: 'ensure-sovereign', type: 'identity.ensure-user', title: 'Ensure the sovereign runtime identity', dependsOn: ['install-packages'], user: 'sovereign' }),
    ...['sovereign-root', 'app-root', 'backup-root', 'config-root', 'nginx-snippets'].map((purpose, index) => operation({ id: `ensure-${purpose}`, type: 'filesystem.ensure-directory', title: `Ensure ${purpose.replaceAll('-', ' ')} directory`, dependsOn: index ? [`ensure-${['sovereign-root', 'app-root', 'backup-root', 'config-root', 'nginx-snippets'][index - 1]}`] : ['ensure-sovereign'], purpose })),
    operation({ id: 'enable-postgresql', type: 'systemd.ensure-service', title: 'Enable PostgreSQL', dependsOn: ['ensure-nginx-snippets'], unit: 'postgresql.service', action: 'enable-and-restart' }),
    operation({ id: 'enable-nginx', type: 'systemd.ensure-service', title: 'Enable nginx', dependsOn: ['enable-postgresql'], unit: 'nginx.service', action: 'enable-and-restart' }),
    operation({ id: 'validate-nginx', type: 'nginx.validate-and-reload', title: 'Validate nginx configuration', dependsOn: ['enable-nginx'] }),
  ];
  return planEnvelope({ kind: 'host-bootstrap', target: 'local-host', policyProfile: 'host-bootstrap-v1', operations, generatedAt, catalogRevision });
}

module.exports = { buildDinnerBootstrapPlan };
