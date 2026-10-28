const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { lookupSystemUser, lstatOrNull, requireLayout, deny, writeFileAtomic } = require('./handlers');
const { moveMarker } = require('./identity');
const { BACKUP_ROOT, APPS_ROOT, MOVE_STATE_ROOT } = require('../src/operations/paths');

// Moving a sensitive app from the shared user to its own (Feature-10 SID-002). Everything it owns is
// handed over by root: its HOME, external storage, backups, and last the checkout, whose owner is what
// decides who the app runs as (identity.js). A root-only marker covers the move from before the first
// hand-over until the last, so an interrupted move refuses every other plan and a re-run resumes it.
//
// The shared user owns these trees until the move and may be hostile, so each one is handed over in two
// passes. First every directory becomes root's and mode 0700 through a no-follow descriptor, top down,
// before root reads it: from then on the shared user can't add, rename or swap anything in it, even
// through a descriptor it already holds, so every path below a locked directory stays what root saw. A
// symlink swapped in before root got there fails the open (the move stops). Then files and links go to
// the app's user and directories follow bottom up, getting their modes back. A hardlinked file is copied
// first when the shared user or the app's user owns it (a link to another app's file must never change
// owner); one owned by anyone else (a root-owned git object, or a planted link to a system file) is left
// exactly as it is, never copied or chowned. Copies are made in a root-only staging directory at the top
// of their tree, recorded in the marker before it is created, so a re-run removes exactly what an earlier
// attempt left and nothing else (one marker write per tree, however many copies). Setuid and setgid bits
// are dropped.
//
// Every tree must be one mount: a copy is renamed into place from its tree's staging directory, and Linux
// refuses a rename across mount points, bind mounts of the same filesystem included. The kernel's mount
// table (/proc/self/mountinfo) is the authority: the move plan checks it read-only before the app stops
// (filesystem.check-app-trees), the hand-over again before each tree, and pass 1 compares each directory's
// own mount (the kernel's mnt_id for the descriptor root opened) with its tree's before changing it, so a
// mount made while the hand-over runs is refused too.

const NO_FOLLOW_DIRECTORY = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const NO_FOLLOW_FILE = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const SPECIAL_BITS = 0o6000;
const STAGING_PREFIX = '.reown-staging-';
const MOUNT_TABLE = '/proc/self/mountinfo';

function createMoveHandlers({ fsImpl = fs, lookupUser = (name) => lookupSystemUser(name, fsImpl), randomName = () => crypto.randomBytes(8).toString('hex') } = {}) {
  // The move in progress: what the marker records (see writeMarker).
  let move = null;

  const withDirectory = (target, fn) => {
    let fd;
    try { fd = fsImpl.openSync(target, NO_FOLLOW_DIRECTORY); } catch (error) {
      if (['ELOOP', 'ENOTDIR'].includes(error.code)) deny(`${target} changed into something other than a directory during the move; nothing more was handed over.`);
      throw error;
    }
    try {
      if (!fsImpl.fstatSync(fd).isDirectory()) deny(`${target} is not a real directory.`);
      return fn(fd);
    } finally { fsImpl.closeSync(fd); }
  };

  // The parents the trees sit in must be root's, or the shared user could swap a whole tree mid-move.
  const rootOwnParent = (directory) => {
    const stat = lstatOrNull(fsImpl, directory);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) deny(`${directory} is missing or not a real directory.`);
    if (stat.uid !== 0) withDirectory(directory, (fd) => { fsImpl.fchownSync(fd, 0, 0); fsImpl.fchmodSync(fd, 0o755); });
  };

  // The mount an open descriptor is on, as the kernel reports it. Unknown means it can't be ruled out: refuse.
  const mountIdOf = (fd) => {
    let info = '';
    try { info = String(fsImpl.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')); } catch { /* refused below */ }
    const match = /^mnt_id:\s*(\d+)\s*$/m.exec(info);
    if (!match) deny('The kernel did not say which mount a directory is on, so mounts inside the app can\'t be ruled out.');
    return Number(match[1]);
  };
  const mountedInside = (directory, top) => deny(`Something is mounted at ${directory}, inside ${top}; unmount it or move it out, then move the app again.`);

  // Mount points, from the kernel (field 5 of each line, octal-escaped). Unreadable means unknown: refuse.
  const mountPoints = () => {
    let table;
    try { table = String(fsImpl.readFileSync(MOUNT_TABLE, 'utf8')); } catch { deny(`${MOUNT_TABLE} is unreadable, so mounts inside the app can't be ruled out.`); }
    return table.split('\n').map((line) => line.split(' ')[4]).filter(Boolean)
      .map((point) => point.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8))));
  };
  // Nothing is mounted inside the tree (the tree itself may be, or sit inside, a mount).
  const assertNoMountInside = (top, points = mountPoints()) => {
    const inside = points.find((point) => point.startsWith(`${top}/`));
    if (inside) mountedInside(inside, top);
  };

  // Pass 1: every directory in the tree becomes root's and 0700, top down, before it is read. Returns them
  // in that order with their modes, which pass 2 gives back. A re-run finds its own locks (root, 0700) and
  // restores those, which is harmless: the top is 0700 to the app's user either way.
  const lockTree = (top) => {
    const directories = [];
    let mount = null;
    const visit = (directory) => {
      const mode = withDirectory(directory, (fd) => {
        const stat = fsImpl.fstatSync(fd);
        const here = mountIdOf(fd);
        if (mount === null) mount = here;
        else if (here !== mount) mountedInside(directory, top);
        const before = stat.mode & 0o777;
        fsImpl.fchownSync(fd, 0, 0);
        fsImpl.fchmodSync(fd, 0o700);
        return before;
      });
      directories.push({ directory, mode });
      for (const name of fsImpl.readdirSync(directory)) {
        const child = path.posix.join(directory, name);
        const stat = fsImpl.lstatSync(child);
        if (stat.isDirectory() && !stat.isSymbolicLink()) visit(child);
      }
    };
    visit(top);
    return directories;
  };

  // The tree's staging directory, made on its first copy (a sibling of every copy's target can't be used:
  // its name would need provenance). Inside the tree, so the rename stays on one filesystem.
  const stagingFor = (tree) => {
    if (move.staging[tree]) return move.staging[tree];
    const staging = path.posix.join(tree, `${STAGING_PREFIX}${randomName()}`);
    move.staging[tree] = staging;
    writeMarker(move);
    fsImpl.mkdirSync(staging, { mode: 0o700 });
    return staging;
  };

  const handOverFile = (target, stat, owner, shared, tree) => {
    if (stat.isSymbolicLink()) { fsImpl.lchownSync(target, owner.uid, owner.gid); return 'link'; }
    if (!stat.isFile()) { fsImpl.lchownSync(target, owner.uid, owner.gid); return 'other'; }
    let copied = false;
    if (stat.nlink > 1) {
      if (stat.uid !== shared.uid && stat.uid !== owner.uid) return 'kept';
      // Its directory is root's now, so the copy and the rename can't be redirected. A crash between the
      // copy and the rename leaves the copy in a staging directory the re-run knows is its own.
      const temp = path.posix.join(stagingFor(tree), randomName());
      fsImpl.copyFileSync(target, temp, fs.constants.COPYFILE_EXCL);
      try { fsImpl.renameSync(temp, target); } catch (error) {
        try { fsImpl.unlinkSync(temp); } catch { /* the re-run removes it */ }
        throw error;
      }
      copied = true;
    }
    const fd = fsImpl.openSync(target, NO_FOLLOW_FILE);
    try {
      const current = fsImpl.fstatSync(fd);
      if (!current.isFile()) deny(`${target} is not a regular file.`);
      fsImpl.fchownSync(fd, owner.uid, owner.gid);
      if (current.mode & SPECIAL_BITS) fsImpl.fchmodSync(fd, current.mode & 0o777 & ~SPECIAL_BITS);
    } finally { fsImpl.closeSync(fd); }
    return copied ? 'copied' : 'file';
  };

  // Pass 2: entries to the app's user, directories bottom up, the top private to it.
  const handOverTree = (top, owner, shared) => {
    const directories = lockTree(top);
    const counts = { file: 0, link: 0, other: 0, copied: 0, kept: 0, directory: directories.length };
    for (const { directory } of directories) {
      for (const name of fsImpl.readdirSync(directory)) {
        const child = path.posix.join(directory, name);
        const stat = fsImpl.lstatSync(child);
        if (stat.isDirectory() && !stat.isSymbolicLink()) continue;
        counts[handOverFile(child, stat, owner, shared, top)] += 1;
      }
    }
    // Every copy was renamed into place, so the staging directory is empty.
    if (move.staging[top]) fsImpl.rmdirSync(move.staging[top]);
    for (const { directory, mode } of [...directories].reverse()) {
      withDirectory(directory, (fd) => {
        fsImpl.fchownSync(fd, owner.uid, owner.gid);
        fsImpl.fchmodSync(fd, directory === top ? 0o700 : mode & ~SPECIAL_BITS);
      });
    }
    return counts;
  };

  const stateRoot = () => {
    if (!fsImpl.existsSync(MOVE_STATE_ROOT)) fsImpl.mkdirSync(MOVE_STATE_ROOT, { recursive: true, mode: 0o700 });
    const root = lstatOrNull(fsImpl, MOVE_STATE_ROOT);
    if (!root || root.isSymbolicLink() || !root.isDirectory() || root.uid !== 0) deny(`${MOVE_STATE_ROOT} must be a root-owned directory.`);
  };
  // { appId, user, staging: { <tree>: <its staging directory, recorded before it is created> } }
  const writeMarker = (state) => {
    stateRoot();
    writeFileAtomic(fsImpl, `${MOVE_STATE_ROOT}/${state.appId}`, `${JSON.stringify(state)}\n`, 0o600);
  };
  const readMarker = (layout) => {
    const stat = lstatOrNull(fsImpl, moveMarker(layout));
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== 0) deny(`${moveMarker(layout)} is not root's marker file.`);
    try { return JSON.parse(fsImpl.readFileSync(moveMarker(layout), 'utf8')); } catch { deny(`${moveMarker(layout)} is unreadable; inspect it before moving ${layout.app.name} again.`); }
  };
  // An earlier attempt's staging directories: only ones it recorded, directly at the top of one of this
  // app's trees with the staging name, still root's real directories. Their copies are root's own
  // single-link files (a copy is root's until its rename); anything else in one stops the move.
  const removeEarlierStaging = (previous, trees) => {
    const recorded = previous?.staging && typeof previous.staging === 'object' ? Object.values(previous.staging) : [];
    for (const staging of recorded) {
      if (typeof staging !== 'string' || staging !== path.posix.normalize(staging) || !trees.includes(path.posix.dirname(staging)) || !path.posix.basename(staging).startsWith(STAGING_PREFIX)) continue;
      const stat = lstatOrNull(fsImpl, staging);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== 0) continue;
      for (const name of fsImpl.readdirSync(staging)) {
        const copy = path.posix.join(staging, name);
        const entry = fsImpl.lstatSync(copy);
        if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== 0 || entry.nlink !== 1) deny(`${copy} was not left by an earlier move; inspect it before moving again.`);
        fsImpl.unlinkSync(copy);
      }
      fsImpl.rmdirSync(staging);
    }
  };

  // The app's trees, the checkout last: its owner is what says the app has moved.
  const treesOf = (layout) => [
    layout.identity.home,
    ...(layout.storage && !layout.storage.inCheckout ? [layout.storage.root] : []),
    `${BACKUP_ROOT}/${layout.app.id}`,
    layout.checkout,
  ];
  const existingTrees = (layout) => treesOf(layout).filter((tree) => {
    const stat = lstatOrNull(fsImpl, tree);
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) deny(`${tree} is not a real directory.`);
    return true;
  });

  return {
    'filesystem.check-app-trees': async (operation, { layout } = {}) => {
      requireLayout(layout);
      if (!layout.identity.own) deny(`${layout.app.name} runs as the shared user by design.`);
      const trees = existingTrees(layout);
      const points = mountPoints();
      for (const tree of trees) assertNoMountInside(tree, points);
      return `${trees.length} of ${layout.app.name}'s trees checked: nothing is mounted inside them`;
    },
    'filesystem.reown-app': async (operation, { layout } = {}) => {
      requireLayout(layout);
      if (!layout.identity.own) deny(`${layout.app.name} runs as the shared user by design.`);
      const owner = lookupUser(layout.identity.user);
      const shared = lookupUser('sovereign');
      if (!owner) deny(`The ${layout.identity.user} identity does not exist; ensure it first.`);
      if (!shared) deny('The sovereign identity does not exist.');
      if (owner.uid === 0 || owner.uid === shared.uid) deny(`${layout.identity.user} must be its own unprivileged identity.`);
      rootOwnParent(APPS_ROOT);
      rootOwnParent(BACKUP_ROOT);
      const trees = treesOf(layout);
      removeEarlierStaging(readMarker(layout), trees);
      move = { appId: layout.app.id, user: layout.identity.user, staging: {} };
      writeMarker(move);
      const moved = [];
      for (const tree of trees) {
        const stat = lstatOrNull(fsImpl, tree);
        if (!stat) continue;
        if (stat.isSymbolicLink() || !stat.isDirectory()) deny(`${tree} is not a real directory.`);
        if (lstatOrNull(fsImpl, path.posix.dirname(tree))?.uid !== 0) deny(`${path.posix.dirname(tree)} must be owned by root before ${tree} can be handed over.`);
        assertNoMountInside(tree);
        const counts = handOverTree(tree, owner, shared);
        moved.push(`${tree} (${counts.directory} directories, ${counts.file + counts.copied} files${counts.copied ? `, ${counts.copied} hardlinks copied` : ''}${counts.kept ? `, ${counts.kept} hardlinks owned by others left as they were` : ''})`);
      }
      if (!lstatOrNull(fsImpl, layout.checkout)) deny(`${layout.app.name} has no checkout at ${layout.checkout}; install it instead.`);
      // The .env is the app's secrets: private to its user, like a fresh install writes it. Only the app's
      // own single-link file: a hardlink left as it was above is someone else's inode (the plan's next step
      // writes a fresh .env anyway).
      const env = lstatOrNull(fsImpl, layout.envPath);
      if (env?.isFile()) {
        const fd = fsImpl.openSync(layout.envPath, NO_FOLLOW_FILE);
        try {
          const current = fsImpl.fstatSync(fd);
          if (current.isFile() && current.nlink === 1 && current.uid === owner.uid) fsImpl.fchmodSync(fd, 0o600);
        } finally { fsImpl.closeSync(fd); }
      }
      // Every file is the app's now: other plans may run again.
      fsImpl.rmSync(moveMarker(layout), { force: true });
      return `handed ${layout.app.name} to ${layout.identity.user}: ${moved.join('; ')}`;
    },
  };
}

module.exports = { createMoveHandlers };
