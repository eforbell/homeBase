const fs = require('fs');
const path = require('path');
const { lookupSystemUser, lstatOrNull, requireLayout, deny } = require('./handlers');
const { BACKUP_ROOT, APPS_ROOT } = require('../src/operations/paths');

// Moving a sensitive app from the shared user to its own (Feature-10 SID-002). Everything it owns is
// handed over by root: its HOME, external storage, backups, and last the checkout, whose owner is what
// decides who the app runs as (identity.js), so an interrupted move simply resumes.
//
// The shared user owns these trees until the move and may be hostile, so each one is handed over in two
// passes. First every directory is taken to root through a no-follow descriptor, top down: once a
// directory is root's, the shared user can no longer add, rename, or swap anything in it, and a symlink
// swapped in before root got there fails the open (the move stops). Then, with every entry pinned, files
// and links go to the app's user and directories follow bottom up. Hardlinked files are copied first
// (a link to another app's file, or to a root-owned git object, must never change owner), and setuid and
// setgid bits are dropped.

const NO_FOLLOW_DIRECTORY = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const NO_FOLLOW_FILE = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const SPECIAL_BITS = 0o6000;

function createMoveHandlers({ fsImpl = fs, lookupUser = (name) => lookupSystemUser(name, fsImpl) } = {}) {
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

  // Pass 1: every directory in the tree becomes root's, top down. Returns them in that order.
  const lockTree = (top) => {
    const directories = [];
    const visit = (directory) => {
      withDirectory(directory, (fd) => fsImpl.fchownSync(fd, 0, 0));
      directories.push(directory);
      for (const name of fsImpl.readdirSync(directory)) {
        const child = path.posix.join(directory, name);
        const stat = fsImpl.lstatSync(child);
        if (stat.isDirectory() && !stat.isSymbolicLink()) visit(child);
      }
    };
    visit(top);
    return directories;
  };

  const handOverFile = (target, stat, owner) => {
    if (stat.isSymbolicLink()) { fsImpl.lchownSync(target, owner.uid, owner.gid); return 'link'; }
    if (!stat.isFile()) { fsImpl.lchownSync(target, owner.uid, owner.gid); return 'other'; }
    let copied = false;
    if (stat.nlink > 1) {
      // Its directory is root's now, so the copy and the rename can't be redirected.
      const temp = `${target}.reown-${process.pid}`;
      fsImpl.copyFileSync(target, temp, fs.constants.COPYFILE_EXCL);
      fsImpl.renameSync(temp, target);
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
  const handOverTree = (top, owner) => {
    const directories = lockTree(top);
    const counts = { file: 0, link: 0, other: 0, copied: 0, directory: directories.length };
    for (const directory of directories) {
      for (const name of fsImpl.readdirSync(directory)) {
        const child = path.posix.join(directory, name);
        const stat = fsImpl.lstatSync(child);
        if (stat.isDirectory() && !stat.isSymbolicLink()) continue;
        counts[handOverFile(child, stat, owner)] += 1;
      }
    }
    for (const directory of [...directories].reverse()) {
      withDirectory(directory, (fd) => {
        fsImpl.fchownSync(fd, owner.uid, owner.gid);
        const { mode } = fsImpl.fstatSync(fd);
        fsImpl.fchmodSync(fd, directory === top ? 0o700 : mode & 0o777 & ~SPECIAL_BITS);
      });
    }
    return counts;
  };

  return {
    'filesystem.reown-app': async (operation, { layout } = {}) => {
      requireLayout(layout);
      if (!layout.identity.own) deny(`${layout.app.name} runs as the shared user by design.`);
      const owner = lookupUser(layout.identity.user);
      const shared = lookupUser('sovereign');
      if (!owner) deny(`The ${layout.identity.user} identity does not exist; ensure it first.`);
      if (owner.uid === 0 || owner.uid === shared?.uid) deny(`${layout.identity.user} must be its own unprivileged identity.`);
      rootOwnParent(APPS_ROOT);
      rootOwnParent(BACKUP_ROOT);
      const trees = [
        layout.identity.home,
        ...(layout.storage && !layout.storage.inCheckout ? [layout.storage.root] : []),
        `${BACKUP_ROOT}/${layout.app.id}`,
        // Last: its owner is what says the app has moved.
        layout.checkout,
      ];
      const moved = [];
      for (const tree of trees) {
        const stat = lstatOrNull(fsImpl, tree);
        if (!stat) continue;
        if (stat.isSymbolicLink() || !stat.isDirectory()) deny(`${tree} is not a real directory.`);
        if (lstatOrNull(fsImpl, path.posix.dirname(tree))?.uid !== 0) deny(`${path.posix.dirname(tree)} must be owned by root before ${tree} can be handed over.`);
        const counts = handOverTree(tree, owner);
        moved.push(`${tree} (${counts.directory} directories, ${counts.file + counts.copied} files${counts.copied ? `, ${counts.copied} hardlinks copied` : ''})`);
      }
      if (!lstatOrNull(fsImpl, layout.checkout)) deny(`${layout.app.name} has no checkout at ${layout.checkout}; install it instead.`);
      // The .env is the app's secrets: private to its user, like a fresh install writes it.
      const env = lstatOrNull(fsImpl, layout.envPath);
      if (env?.isFile()) {
        const fd = fsImpl.openSync(layout.envPath, NO_FOLLOW_FILE);
        try { fsImpl.fchmodSync(fd, 0o600); } finally { fsImpl.closeSync(fd); }
      }
      return `handed ${layout.app.name} to ${layout.identity.user}: ${moved.join('; ')}`;
    },
  };
}

module.exports = { createMoveHandlers };
