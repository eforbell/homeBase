const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  buildBootstrapPlan,
  renderNginxGatewayRepairPython,
} = require('../src/services/bootstrap-planner');

test('bootstrap plan includes Debian host setup essentials', () => {
  const plan = buildBootstrapPlan({ serviceUser: 'sovereign' });
  assert.equal(plan.kind, 'bootstrap');
  assert.ok(plan.steps.some((step) => step.id === 'install-base-packages'));
  assert.ok(plan.steps.some((step) => step.id === 'install-tailscale'));
  assert.ok(plan.steps.some((step) => step.id === 'configure-nginx-gateway'));
  assert.match(plan.script, /sudo apt-get install -y git curl ca-certificates ssl-cert nginx postgresql postgresql-client nodejs python3 python3-venv python3-pip/);
  assert.match(plan.script, /if ! command -v npm >\/dev\/null 2>&1; then sudo apt-get install -y npm; fi/);
  assert.match(plan.script, /include \/etc\/nginx\/snippets\/\*\.conf;/);
  assert.match(plan.script, /listen 443 ssl default_server;/);
  assert.match(plan.script, /listen \[::\]:443 ssl default_server;/);
  assert.match(plan.script, /include snippets\/snakeoil\.conf;/);
  assert.match(plan.script, /ssl-cert/);
  assert.match(plan.script, /sudo nginx -t/);
  assert.match(plan.script, /sudo systemctl reload-or-restart nginx/);
  assert.match(plan.script, /ufw app info OpenSSH/);
  assert.match(plan.script, /ufw allow 22\/tcp/);
  assert.match(plan.script, /tailscaled/);
});

test('bootstrap plan creates service user home dir, .npm cache dir, and .ssh dir', () => {
  const plan = buildBootstrapPlan({ serviceUser: 'sovereign', baseInstallDir: '/opt/sovereign-home/apps' });
  const step = plan.steps.find((s) => s.id === 'ensure-service-user');
  assert.ok(step, 'ensure-service-user step present');
  const cmds = step.run.join('\n');
  assert.match(cmds, /--home-dir \/opt\/sovereign-home/);
  assert.match(cmds, /install -d -m 0755 -o sovereign -g sovereign \/opt\/sovereign-home$/m);
  assert.match(cmds, /install -d -m 0755 -o sovereign -g sovereign \/opt\/sovereign-home\/.npm/);
  assert.match(cmds, /install -d -m 0700 -o sovereign -g sovereign \/opt\/sovereign-home\/.ssh/);
});

test('bootstrap plan derives service user home from baseInstallDir', () => {
  const plan = buildBootstrapPlan({ serviceUser: 'sov', baseInstallDir: '/data/apps/apps' });
  const step = plan.steps.find((s) => s.id === 'ensure-service-user');
  const cmds = step.run.join('\n');
  assert.match(cmds, /--home-dir \/data\/apps/);
  assert.match(cmds, /\/data\/apps\/.npm/);
  assert.match(cmds, /\/data\/apps\/.ssh/);
});

test('nginx gateway repair activates Ubuntu default ssl lines in place', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-nginx-default-'));
  const defaultSite = path.join(tempDir, 'default');
  fs.writeFileSync(defaultSite, `server {
        listen 80 default_server;
        listen [::]:80 default_server;

        # SSL configuration
        #
        # listen 443 ssl default_server;
        # listen [::]:443 ssl default_server;
        #
        # include snippets/snakeoil.conf;

        root /var/www/html;
        index index.html index.htm index.nginx-debian.html;

        server_name _;

        location / {
                try_files $uri $uri/ =404;
        }
}
`);

  const result = spawnSync('python3', ['-c', renderNginxGatewayRepairPython(defaultSite)], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const updated = fs.readFileSync(defaultSite, 'utf8');
  assert.match(updated, /^\s*listen 443 ssl default_server;$/m);
  assert.match(updated, /^\s*listen \[::\]:443 ssl default_server;$/m);
  assert.match(updated, /^\s*include snippets\/snakeoil\.conf;$/m);
  assert.match(updated, /^\s*include \/etc\/nginx\/snippets\/\*\.conf;$/m);
  assert.doesNotMatch(updated, /^\s*# listen 443 ssl default_server;$/m);
  assert.doesNotMatch(updated, /^\s*# include snippets\/snakeoil\.conf;$/m);
});
