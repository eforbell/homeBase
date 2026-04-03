const test = require('node:test');
const assert = require('node:assert/strict');
const { catalog } = require('../src/catalog');
const { validateManifestEntry } = require('../src/manifest-schema');

test('catalog entries satisfy the managed app manifest contract', () => {
  for (const entry of catalog) {
    assert.deepEqual(validateManifestEntry(entry), [], `invalid manifest for ${entry.id}`);
  }
});
