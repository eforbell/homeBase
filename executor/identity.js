const fs = require('fs');
const { ProtocolError } = require('./protocol');
const { SHARED_USER, SHARED_HOME, MOVE_STATE_ROOT } = require('../src/operations/paths');

// Who an app's files and processes belong to on this host (Feature-10 SID-002).
//
// A sensitive app's target is its own user (layout.identity, app-layout.js). An install from before
// SID-002 still has a checkout owned by the shared user; it keeps running as sovereign until the "move to
// its own user" action re-owns it, so updates, backups and restarts keep working in the meantime. The
// checkout's owner decides, because the move re-owns the checkout last. Anything else fails closed.
//
// While a move is under way its files belong to root, the shared user and the app's user at once, so a
// root-only marker (MOVE_STATE_ROOT/<app id>) stands in for the checkout's owner: every plan but the move
// itself refuses until a re-run of the move finishes it, and the move continues as the app's own user.

function deny(message) { throw new ProtocolError('POLICY_DENIED', message); }

function lstatOrNull(fsImpl, target) {
  try { return fsImpl.lstatSync(target); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function moveMarker(layout) { return `${MOVE_STATE_ROOT}/${layout.app.id}`; }

function moveInterrupted(layout, fsImpl = fs) {
  const marker = lstatOrNull(fsImpl, moveMarker(layout));
  return Boolean(marker && marker.isFile() && marker.uid === 0);
}

function interruptedMessage(layout) {
  return `Moving ${layout.app.name} to ${layout.identity.user} was interrupted; run "Move to its own user" again to finish it.`;
}

// Returns { uid, gid, name, home, own, pendingMove, moving }. duringMove: the caller is the move plan.
function resolveAppIdentity(layout, { fsImpl = fs, lookupUser, duringMove = false }) {
  const shared = lookupUser(SHARED_USER);
  const sharedIdentity = () => {
    if (!shared) deny(`The ${SHARED_USER} identity does not exist.`);
    return { uid: shared.uid, gid: shared.gid, name: SHARED_USER, home: SHARED_HOME, own: false, pendingMove: false };
  };
  if (!layout.identity?.own) return sharedIdentity();
  const own = lookupUser(layout.identity.user);
  if (moveInterrupted(layout, fsImpl)) {
    if (!duringMove) deny(interruptedMessage(layout));
    if (!own || own.uid === 0 || own.uid === shared?.uid) deny(`${layout.identity.user} must be its own unprivileged identity.`);
    return { uid: own.uid, gid: own.gid, name: layout.identity.user, home: layout.identity.home, own: true, pendingMove: false, moving: true };
  }
  const checkout = lstatOrNull(fsImpl, layout.checkout);
  if (checkout && (checkout.isSymbolicLink() || !checkout.isDirectory())) deny(`${layout.checkout} is not a real directory.`);
  if (checkout && shared && checkout.uid === shared.uid && (!own || own.uid !== shared.uid)) return { ...sharedIdentity(), pendingMove: true };
  if (!own) deny(`The ${layout.identity.user} identity does not exist; install ${layout.app.name} first.`);
  if (own.uid === 0 || own.uid === shared?.uid) deny(`${layout.identity.user} must be its own unprivileged identity.`);
  if (checkout && checkout.uid !== own.uid) deny(`${layout.checkout} belongs to uid ${checkout.uid}, which is neither ${layout.identity.user} nor ${SHARED_USER}.`);
  return { uid: own.uid, gid: own.gid, name: layout.identity.user, home: layout.identity.home, own: true, pendingMove: false };
}

// /etc/group membership: an app user in nginx's group could reach every app's socket (SID-002).
function groupMembers(name, fsImpl = fs) {
  try {
    const row = fsImpl.readFileSync('/etc/group', 'utf8').split('\n').find((line) => line.startsWith(`${name}:`));
    if (!row) return null;
    const [, , gid, members = ''] = row.split(':');
    return { gid: Number.parseInt(gid, 10), members: members.split(',').map((member) => member.trim()).filter(Boolean) };
  } catch { return null; }
}

// For Home Base's app page: who the app runs as on this host, and whether it still has to move.
function describeAppIdentity(layout, { fsImpl = fs, lookupUser }) {
  const base = { appId: layout.app.id, target: layout.identity.user, own: layout.identity.own };
  if (layout.identity.own && moveInterrupted(layout, fsImpl)) return { ...base, installed: true, runsAs: null, pendingMove: true, interrupted: true, problem: interruptedMessage(layout) };
  if (!lstatOrNull(fsImpl, layout.checkout)) return { ...base, installed: false, runsAs: null, pendingMove: false };
  try {
    const identity = resolveAppIdentity(layout, { fsImpl, lookupUser });
    return { ...base, installed: true, runsAs: identity.name, pendingMove: identity.pendingMove };
  } catch (error) {
    return { ...base, installed: true, runsAs: null, pendingMove: false, problem: error.message };
  }
}

module.exports = { describeAppIdentity, groupMembers, moveInterrupted, moveMarker, resolveAppIdentity };
