// Config validation that doesn't need a running Home Base.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isKnownTimezone } = require('../src/homebase-config');

test('a household timezone must be a zone Intl knows, named exactly as a file in the zone database', (t) => {
  const zoneinfo = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-zoneinfo-'));
  t.after(() => fs.rmSync(zoneinfo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(zoneinfo, 'America'));
  fs.writeFileSync(path.join(zoneinfo, 'America', 'Chicago'), 'TZif');
  fs.symlinkSync('America', path.join(zoneinfo, 'US'));

  assert.equal(isKnownTimezone('America/Chicago', zoneinfo), true);
  assert.equal(isKnownTimezone('america/chicago', zoneinfo), false, 'case, even on a case-insensitive filesystem');
  assert.equal(isKnownTimezone('America/New_York', zoneinfo), false, 'Intl knows it, this host does not');
  assert.equal(isKnownTimezone('America', zoneinfo), false, 'a folder');
  assert.equal(isKnownTimezone('Foo/Bar', zoneinfo), false, 'Intl does not know it');
  assert.equal(isKnownTimezone('US/Central', zoneinfo), false, 'Intl knows it, but no file has that name');
  fs.symlinkSync(path.join('..', 'America', 'Chicago'), path.join(zoneinfo, 'America', 'Matamoros'));
  assert.equal(isKnownTimezone('America/Matamoros', zoneinfo), true, 'a symlinked zone file');
  fs.symlinkSync('Nowhere', path.join(zoneinfo, 'America', 'Merida'));
  assert.equal(isKnownTimezone('America/Merida', zoneinfo), false, 'a broken link');
  // Without a zone database, Intl decides.
  const none = path.join(zoneinfo, 'absent');
  assert.equal(isKnownTimezone('America/New_York', none), true);
  assert.equal(isKnownTimezone('Foo/Bar', none), false);
});
