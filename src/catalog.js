const catalog = [
  {
    id: 'family-pulse',
    repoKey: 'familyPulse',
    name: 'Family Pulse',
    purpose: 'Cash flow visibility, budgeting, and household financial awareness.',
    repository: {
      url: 'https://github.com/eforbell/familyPulse.git',
      sshUrl: 'git@github.com:eforbell/familyPulse.git',
      defaultRef: 'main',
    },
    runtime: {
      kind: 'node',
      installCommand: 'npm ci --omit=dev',
      startCommand: 'node server.js',
      nodeEnv: 'production',
    },
    network: {
      preferredMountPath: '/pulse/',
      preferredPort: 3003,
      upstreamBind: '127.0.0.1',
      health: {
        type: 'http',
        livenessPath: '/api/health',
        readinessPath: '/api/health',
      },
      notes: [
        'Plaid production OAuth requires a public HTTPS callback path.',
        'Current repo uses a second MCP sidecar service on port 3004.',
      ],
    },
    database: {
      engine: 'postgres',
      bootstrap: 'migrations',
      databaseName: 'familypulse',
      databaseUser: 'familypulse',
      migrationCommand: 'node db/migrate.js',
      seedPolicy: 'manual-only',
    },
    service: {
      name: 'family-pulse',
      description: 'Family Pulse App',
      envFile: '.env',
    },
    sidecars: [
      {
        name: 'family-pulse-mcp',
        description: 'Family Pulse MCP Server',
        execStart: 'node mcp/server.js',
        env: {
          NODE_ENV: 'production',
        },
      },
    ],
    config: {
      env: {
        DATABASE_URL: '{{databaseUrl}}',
        PORT: '{{port}}',
        PLAID_CLIENT_ID: '',
        PLAID_SECRET: '',
        PLAID_ENV: 'production',
        APP_URL: '{{externalUrl}}',
        PLAID_OAUTH_REDIRECT_URI: '{{publicUrl}}oauth/callback',
        OPENAI_API_KEY: '',
        OPENAI_MODEL: 'gpt-4o-mini',
        MCP_PORT: '{{sidecar.family-pulse-mcp.port}}',
        MCP_HOST: '127.0.0.1',
        MCP_AUTH_TOKEN: '',
        LOG_LEVEL: 'info',
        BOOTSTRAP_SECRET: '',
      },
    },
    storage: {
      paths: [],
    },
    updateNotes: [
      'Main app is a singleton because cron jobs run in-process.',
      'Use dedicated review for Plaid callback exposure before enabling production linking.',
    ],
  },
  {
    id: 'family-help',
    repoKey: 'familyHelp',
    name: 'Family Help',
    purpose: 'Household task intake, assignments, reminders, and first-tier help.',
    repository: {
      url: 'https://github.com/eforbell/familyHelp.git',
      sshUrl: 'git@github.com:eforbell/familyHelp.git',
      defaultRef: 'main',
    },
    runtime: {
      kind: 'node',
      installCommand: 'npm ci --omit=dev',
      startCommand: 'node server.js',
      nodeEnv: 'production',
    },
    network: {
      preferredMountPath: '/help/',
      preferredPort: 3002,
      upstreamBind: '127.0.0.1',
      health: {
        type: 'http',
        livenessPath: '/api/health',
        readinessPath: '/api/ready',
      },
      notes: [
        'First-run household setup is handled in the browser when family_members is empty.',
      ],
    },
    database: {
      engine: 'postgres',
      bootstrap: 'migrations',
      databaseName: 'familyhelp',
      databaseUser: 'familyhelp',
      migrationCommand: 'node db/migrate.js',
      seedPolicy: 'app-onboarding',
    },
    onboarding: {
      mode: 'browser',
      setupPath: '/setup',
      statusPath: '/api/bootstrap',
      readyWhen: 'household_initialized',
      notes: [
        'No production db/seed.sql is required; app bootstrap creates household and starter content from the browser.',
      ],
    },
    service: {
      name: 'family-help',
      description: 'Family Help App',
      envFile: '.env',
    },
    timers: [
      {
        serviceName: 'family-help-reminders',
        description: 'Family Help reminder runner',
        execStart: 'node scripts/send-reminders.js',
        timerName: 'family-help-reminders.timer',
        onCalendar: '*:0/30',
      },
    ],
    config: {
      env: {
        DATABASE_URL: '{{databaseUrl}}',
        PORT: '{{port}}',
        OPENAI_API_KEY: '',
        OPENAI_MODEL: 'gpt-4o-mini',
        SETTINGS_PIN: '',
      },
    },
    storage: {
      paths: ['uploads'],
    },
    updateNotes: [
      'Back up repo-local uploads alongside PostgreSQL dumps.',
      'Reminder base URL should match the installed nginx/Tailscale address.',
    ],
  },
  {
    id: 'family-dinner',
    repoKey: 'familyDinner',
    name: 'Family Dinner',
    purpose: 'Meal planning, recipes, rotation scheduling, and grocery helpers.',
    repository: {
      url: 'https://github.com/eforbell/familyDinner.git',
      sshUrl: 'git@github.com:eforbell/familyDinner.git',
      defaultRef: 'main',
    },
    runtime: {
      kind: 'node',
      installCommand: 'npm ci --omit=dev',
      startCommand: 'node server.js',
      nodeEnv: 'production',
    },
    network: {
      preferredMountPath: '/dinner/',
      preferredPort: 3000,
      upstreamBind: '127.0.0.1',
      health: {
        type: 'synthetic-http',
        livenessPath: '/api/week',
        readinessPath: '/api/tonight',
      },
      notes: [
        'No dedicated health endpoint yet; probe week/tonight routes.',
      ],
    },
    database: {
      engine: 'postgres',
      bootstrap: 'migrations',
      databaseName: 'family_dinner',
      databaseUser: 'family_dinner',
      migrationCommand: 'npm run db:migrate',
      seedPolicy: 'manual-only',
    },
    service: {
      name: 'family-dinner',
      description: 'Family Dinner App',
      envFile: '.env',
    },
    config: {
      env: {
        DATABASE_URL: '{{databaseUrl}}',
        PORT: '{{port}}',
        OPENAI_API_KEY: '',
        OPENAI_MODEL: 'gpt-4o-mini',
        OPENAI_RECIPE_MODEL: 'gpt-4o-mini',
        RECIPE_IMPORT_USER_AGENT: 'Home Base importer/0.1',
      },
    },
    storage: {
      paths: [],
    },
    updateNotes: [
      'Do not run db/seed.sql in production installs; it is destructive sample data.',
    ],
  },
  {
    id: 'family-plan',
    repoKey: 'familyPlan',
    name: 'Family Plan',
    purpose: 'Family calendar aggregation, daily briefings, and optional Google writeback.',
    repository: {
      url: 'https://github.com/eforbell/familyPlan.git',
      sshUrl: 'git@github.com:eforbell/familyPlan.git',
      defaultRef: 'main',
    },
    runtime: {
      kind: 'node',
      installCommand: 'npm ci --omit=dev',
      startCommand: 'node server.js',
      nodeEnv: 'production',
    },
    network: {
      preferredMountPath: '/plan/',
      preferredPort: 3001,
      upstreamBind: '127.0.0.1',
      health: {
        type: 'http',
        livenessPath: '/api/health',
        readinessPath: '/api/ready',
      },
      notes: [
        'Explicit GOOGLE_REDIRECT_URI is recommended when using a subpath proxy.',
        'First-run household setup is handled in the browser when family_members is empty.',
      ],
    },
    database: {
      engine: 'postgres',
      bootstrap: 'migrations',
      databaseName: 'familyplan',
      databaseUser: 'familyplan',
      migrationCommand: 'node db/migrate.js',
      seedPolicy: 'app-onboarding',
    },
    onboarding: {
      mode: 'browser',
      setupPath: '/setup',
      statusPath: '/api/bootstrap',
      readyWhen: 'household_initialized',
      notes: [
        'No production db/seed.sql is required; app bootstrap creates the first household from the browser.',
      ],
    },
    service: {
      name: 'family-plan',
      description: 'Family Plan App',
      envFile: '.env',
    },
    timers: [
      {
        serviceName: 'family-plan-reminders',
        description: 'Family Plan reminder runner',
        execStart: 'node scripts/send-reminders.js',
        timerName: 'family-plan-reminders.timer',
        onCalendar: '*-*-* 07:00:00',
      },
    ],
    config: {
      env: {
        DATABASE_URL: '{{databaseUrl}}',
        PORT: '{{port}}',
        OPENAI_API_KEY: '',
        OPENAI_MODEL: 'gpt-4o-mini',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        GOOGLE_REDIRECT_URI: '{{externalUrl}}api/google-calendar/oauth/callback',
        SETTINGS_PIN: '',
        CALENDAR_WRITE_PIN: '',
        HOUSEHOLD_TIMEZONE: 'America/New_York',
      },
    },
    storage: {
      paths: [],
    },
    updateNotes: [
      'Important runtime config also lives in app_config; env alone is not the full state.',
      'Do not run db/seed.sql automatically for production households.',
    ],
  },
  {
    id: 'bitcoin-accounting',
    repoKey: 'bitcoinAccounting',
    name: 'Bitcoin Accounting',
    purpose: 'Treasury management, tax reporting, and attestation for sovereign bitcoin holdings.',
    repository: {
      url: 'https://github.com/eforbell/bitcoinAccounting.git',
      sshUrl: 'git@github.com:eforbell/bitcoinAccounting.git',
      defaultRef: 'master',
    },
    runtime: {
      kind: 'python',
      installCommand: '.venv/bin/python -m pip install -e .',
      startCommand: '.venv/bin/uvicorn web.app:create_app --factory --host 127.0.0.1 --port {{port}}',
      pythonVenv: '.venv',
    },
    network: {
      preferredMountPath: '/bitcoin-accounting/',
      preferredPort: 3010,
      upstreamBind: '127.0.0.1',
      health: {
        type: 'http',
        livenessPath: '/api/health',
        readinessPath: '/api/ready',
      },
      notes: [
        'Reverse proxy must strip the external subpath before proxying upstream.',
      ],
    },
    database: {
      engine: 'postgres-or-sqlite',
      bootstrap: 'schema-file',
      databaseName: 'bitcoin_accounting',
      databaseUser: 'bitcoin_accountant',
      schemaCommand: 'psql -d {{dbName}} -f src/sql/tables.sql',
      migrationCommand: '.venv/bin/bitcoin-accounting-web-init',
      seedPolicy: 'never',
    },
    service: {
      name: 'bitcoin-accounting-web',
      description: 'Bitcoin Accounting Web API',
      envFile: '.env',
    },
    config: {
      env: {
        DB_BACKEND: 'postgres',
        PGHOST: '127.0.0.1',
        PGPORT: '5432',
        PGUSER: '{{dbUser}}',
        PGPASSWORD: '{{dbPassword}}',
        PGDATABASE: '{{dbName}}',
        BITCOIN_ACCOUNTING_ENV: 'production',
        BITCOIN_ACCOUNTING_WEB_BASE_PATH: '{{mountBasePath}}',
        BITCOIN_ACCOUNTING_WEB_DOCS: '0',
        BITCOIN_ACCOUNTING_WEB_ALLOW_SQLITE: '0',
        BITCOIN_ACCOUNTING_AUTH_ENABLED: '1',
        BITCOIN_ACCOUNTING_AUTH_PASSPHRASE: '{{secret1}}',
        BITCOIN_ACCOUNTING_SESSION_SECRET: '{{secret2}}',
        BITCOIN_ACCOUNTING_SESSION_COOKIE: 'ba_session',
        BITCOIN_ACCOUNTING_SESSION_TTL_SECONDS: '604800',
        BITCOIN_CHAIN_STATUS_ENABLED: '0',
        BITCOIN_RPC_URL: '',
        BITCOIN_RPC_COOKIE_FILE: '',
        BITCOIN_RPC_USER: '',
        BITCOIN_RPC_PASSWORD: '',
        BITCOIN_RPC_TIMEOUT_SECONDS: '3',
      },
    },
    storage: {
      paths: [],
    },
    updateNotes: [
      'Prefer repo-local virtualenvs over system Python.',
      'PostgreSQL installs must run src/sql/tables.sql before the web init command.',
    ],
  },
  {
    id: 'bug-base',
    repoKey: 'bugBase',
    name: 'Bug Base',
    purpose: 'Household bug tracker and feature request log with an MCP sidecar for agent access.',
    repository: {
      url: 'https://github.com/eforbell/bugBase.git',
      sshUrl: 'git@github.com:eforbell/bugBase.git',
      defaultRef: 'main',
    },
    runtime: {
      kind: 'node',
      installCommand: 'npm ci --omit=dev',
      startCommand: 'node server.js',
      nodeEnv: 'production',
    },
    network: {
      preferredMountPath: '/bugs/',
      preferredPort: 3005,
      upstreamBind: '127.0.0.1',
      health: {
        type: 'http',
        livenessPath: '/api/health',
        readinessPath: '/api/health',
      },
      notes: [
        'MCP sidecar runs on a separate port; expose it behind a protected nginx lane if needed.',
        'Set client_max_body_size 12M in the nginx location block to allow screenshot uploads.',
      ],
    },
    database: {
      engine: 'postgres',
      bootstrap: 'migrations',
      databaseName: 'bugbase',
      databaseUser: 'bugbase',
      migrationCommand: 'node db/migrate.js',
      seedPolicy: 'browser-setup',
    },
    service: {
      name: 'bug-base',
      description: 'Bug Base App',
      envFile: '.env',
    },
    sidecars: [
      {
        name: 'bug-base-mcp',
        description: 'Bug Base MCP Server',
        execStart: 'node mcp/server.js',
        env: {
          NODE_ENV: 'production',
        },
      },
    ],
    config: {
      env: {
        DATABASE_URL: '{{databaseUrl}}',
        PORT: '{{port}}',
        MCP_PORT: '{{sidecar.bug-base-mcp.port}}',
        MCP_HOST: '127.0.0.1',
        BUGBASE_AGENT_TOKENS: '',
        BUGBASE_MCP_AUTH_TOKEN: '',
        BUGBASE_BROWSER_ACCESS_CODE: '',
      },
    },
    storage: {
      paths: ['uploads'],
    },
    updateNotes: [
      'Run node db/migrate.js after every deploy — deploy/deploy.sh does this automatically.',
      'Seed migration (002) inserts family members and app rows; add new apps via additional migrations.',
      'BUGBASE_BROWSER_ACCESS_CODE is optional; leave blank for open family-LAN access.',
    ],
  },
];

function getCatalog() {
  return catalog.slice();
}

function getAppById(id) {
  return catalog.find((entry) => entry.id === id) || null;
}

module.exports = {
  catalog,
  getCatalog,
  getAppById,
};
