// SID-003: a stand-in for the household directory, so sovereignAuth's snapshot and member resolution can
// be proven on a test host before SID-004 builds the real one. Off unless HOME_BASE_IDENTITY_PREVIEW names a
// members file, which root writes by hand:
//
//   { "members": [ { "user_id": "1234567890", "login": "parent@example.com", "name": "Parent",
//                    "role": "parent", "apps": ["family-pulse"], "status": "active" } ] }
//
// Those members are admitted by the identity endpoint (so nginx sends their headers) and published in the
// snapshot apps read (D18), rewritten every 30 s like the real one. It holds no credentials and no keys, so
// nothing can be stepped up against it. SID-004 replaces this file with the directory.

const fs = require('fs');
const path = require('path');
const { DEFAULT_SNAPSHOT_PATH, parseSnapshot, writeSnapshot } = require('sovereign-auth');

const PUBLISH_MS = 30_000;

function readPreviewMembers(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data?.members)) throw new Error(`${file} must hold { "members": [...] }`);
  return data.members.map((member) => ({
    user_id: String(member.user_id ?? ''),
    member_id: String(member.member_id || `m_${member.user_id}`),
    login: String(member.login ?? ''),
    name: String(member.name ?? ''),
    role: member.role,
    status: member.status || 'active',
    epoch: 0,
    apps: member.apps,
  }));
}

// The generation must only grow, across restarts too, so it continues from the published file.
function publishedGeneration(file) {
  try {
    const generation = JSON.parse(fs.readFileSync(file, 'utf8')).generation;
    return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
  } catch {
    return 0;
  }
}

function createPreviewDirectory({ membersFile, household, snapshotFile = DEFAULT_SNAPSHOT_PATH, now = Date.now, log = () => {} }) {
  const file = path.resolve(snapshotFile);
  let generation = publishedGeneration(file);
  let members = [];

  // Reads the members file and publishes it. A bad members file publishes nothing new, so the last good
  // snapshot ages out after 120 s and apps fall back to "no member" (fail closed).
  function publish() {
    try {
      const next = readPreviewMembers(membersFile);
      const data = {
        format: 1,
        household: household || 'preview',
        generation: generation + 1,
        written_at: new Date(now()).toISOString(),
        global_epoch: 1,
        keys: [],
        members: next,
      };
      parseSnapshot(data);
      writeSnapshot(data, { file });
      generation += 1;
      members = next;
    } catch (error) {
      members = [];
      log(`identity preview: not published (${error.message})`);
    }
  }

  // The identity endpoint's directory: only active members of the last published snapshot get an identity.
  function lookup(userId) {
    const member = members.find((entry) => entry.user_id === userId);
    return member ? { admitted: member.status === 'active' } : null;
  }

  function start() {
    publish();
    return setInterval(publish, PUBLISH_MS).unref();
  }

  return { lookup, publish, start, snapshotFile: file };
}

module.exports = { createPreviewDirectory, readPreviewMembers };
