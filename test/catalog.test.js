const test = require('node:test');
const assert = require('node:assert/strict');
const { catalog } = require('../src/catalog');
const { validateManifestEntry } = require('../src/manifest-schema');

test('catalog entries satisfy the managed app manifest contract', () => {
  for (const entry of catalog) {
    assert.deepEqual(validateManifestEntry(entry), [], `invalid manifest for ${entry.id}`);
  }
});

test('family help and family plan expose first-run onboarding contracts', () => {
  const familyHelp = catalog.find((entry) => entry.id === 'family-help');
  const familyPlan = catalog.find((entry) => entry.id === 'family-plan');

  assert.equal(familyHelp.network.health.livenessPath, '/api/health');
  assert.equal(familyHelp.network.health.readinessPath, '/api/ready');
  assert.equal(familyHelp.database.seedPolicy, 'app-onboarding');
  assert.equal(familyHelp.onboarding.setupPath, '/setup');
  assert.equal(familyHelp.onboarding.statusPath, '/api/bootstrap');

  assert.equal(familyPlan.network.health.livenessPath, '/api/health');
  assert.equal(familyPlan.network.health.readinessPath, '/api/ready');
  assert.equal(familyPlan.database.bootstrap, 'migrations');
  assert.equal(familyPlan.database.migrationCommand, 'node db/migrate.js');
  assert.equal(familyPlan.database.seedPolicy, 'app-onboarding');
  assert.equal(familyPlan.onboarding.setupPath, '/setup');
  assert.equal(familyPlan.onboarding.statusPath, '/api/bootstrap');
});

test('family dinner catalog uses current OpenAI defaults and preserves operator model choices', () => {
  const familyDinner = catalog.find((entry) => entry.id === 'family-dinner');

  assert.equal(familyDinner.config.env.OPENAI_MODEL, 'gpt-5.4-nano');
  assert.equal(familyDinner.config.env.OPENAI_RECIPE_MODEL, 'gpt-5.4-nano');
  assert.equal(familyDinner.config.env.OPENAI_REASONING_EFFORT, 'none');
  assert.deepEqual(familyDinner.config.preserveExistingKeys, [
    'OPENAI_MODEL',
    'OPENAI_RECIPE_MODEL',
    'OPENAI_REASONING_EFFORT',
  ]);
});
