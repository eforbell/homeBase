// System users as the executor sees them (lookupSystemUser): the shared identity, postgres, and each
// sensitive app's own identity (Feature-10 SID-002), all with distinct ids.
const SOVEREIGN = Object.freeze({ uid: 1001, gid: 1002 });
const POSTGRES = Object.freeze({ uid: 999, gid: 999 });
const APP_USERS = Object.freeze({
  'sovereign-pulse': Object.freeze({ uid: 1101, gid: 1101 }),
  'sovereign-source': Object.freeze({ uid: 1102, gid: 1102 }),
  'sovereign-helm': Object.freeze({ uid: 1103, gid: 1103 }),
  'sovereign-bitcoin-accounting': Object.freeze({ uid: 1104, gid: 1104 }),
});

function users(extra = {}) {
  const table = { sovereign: SOVEREIGN, postgres: POSTGRES, ...APP_USERS, ...extra };
  return (name) => table[name] || null;
}

// What renderManagedFile gets once the executor has resolved who the app runs as.
const SHARED_IDENTITY = Object.freeze({ ...SOVEREIGN, name: 'sovereign', home: '/var/lib/sovereign-home/sovereign', own: false });
const ownIdentity = (user, appId) => ({ ...APP_USERS[user], name: user, home: `/var/lib/sovereign-home/${appId}/home`, own: true });

module.exports = { APP_USERS, POSTGRES, SHARED_IDENTITY, SOVEREIGN, ownIdentity, users };
