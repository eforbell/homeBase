const fs = require('fs');
const path = require('path');

// Minimal in-memory filesystem covering the synchronous calls executor handlers make.
// Entries: { kind: 'dir' | 'file' | 'link', content?, target?, mode, uid, gid }.
function createFakeFs(initial = {}) {
  const entries = new Map();
  const calls = [];
  const fds = new Map();
  let nextFd = 10;
  let tempCounter = 0;

  const enoent = (target) => Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
  const eexist = (target) => Object.assign(new Error(`EEXIST: ${target}`), { code: 'EEXIST' });
  const ensureParents = (target) => {
    for (let dir = path.dirname(target); dir !== '/' && !entries.has(dir); dir = path.dirname(dir)) {
      entries.set(dir, { kind: 'dir', mode: 0o755, uid: 0, gid: 0 });
    }
  };
  const put = (target, entry) => { ensureParents(target); entries.set(target, { mode: 0o644, uid: 0, gid: 0, ...entry }); };
  for (const [target, entry] of Object.entries(initial)) {
    put(target, typeof entry === 'string' ? { kind: 'file', content: entry } : entry);
  }
  const stat = (entry) => ({
    uid: entry.uid,
    gid: entry.gid,
    mode: entry.mode,
    isFile: () => entry.kind === 'file',
    isDirectory: () => entry.kind === 'dir',
    isSymbolicLink: () => entry.kind === 'link',
  });

  const fsImpl = {
    entries,
    calls,
    existsSync: (target) => entries.has(target),
    lstatSync: (target) => {
      if (!entries.has(target)) throw enoent(target);
      return stat(entries.get(target));
    },
    realpathSync: (target) => {
      const entry = entries.get(target);
      if (!entry) throw enoent(target);
      return entry.kind === 'link' ? entry.target : target;
    },
    readFileSync: (target) => {
      const entry = entries.get(target);
      if (!entry || entry.kind !== 'file') throw enoent(target);
      return entry.content;
    },
    readdirSync: (target) => [...entries.keys()].filter((key) => key !== target && path.dirname(key) === target).map((key) => path.basename(key)),
    mkdirSync: (target, options = {}) => {
      if (entries.has(target)) throw eexist(target);
      calls.push(['mkdir', target]);
      put(target, { kind: 'dir', mode: options.mode ?? 0o755 });
    },
    mkdtempSync: (prefix) => {
      const target = `${prefix}${String(++tempCounter).padStart(6, '0')}`;
      put(target, { kind: 'dir', mode: 0o700 });
      return target;
    },
    lchownSync: (target, uid, gid) => {
      calls.push(['lchown', target, uid, gid]);
      Object.assign(entries.get(target), { uid, gid });
    },
    chownSync: (target, uid, gid) => {
      calls.push(['chown', target, uid, gid]);
      Object.assign(entries.get(target), { uid, gid });
    },
    chmodSync: (target, mode) => { entries.get(target).mode = mode; },
    writeFileSync: (target, content, options = {}) => {
      if (options.flag === 'wx' && entries.has(target)) throw eexist(target);
      calls.push(['write', target]);
      put(target, { kind: 'file', content: String(content), mode: options.mode ?? 0o644 });
    },
    openSync: (target, flag, mode) => {
      if (typeof flag === 'number') {
        // Directory open: honour O_NOFOLLOW / O_DIRECTORY the way the kernel does.
        const entry = entries.get(target);
        if (!entry) throw enoent(target);
        if (entry.kind === 'link' && (flag & fs.constants.O_NOFOLLOW)) throw Object.assign(new Error(`ELOOP: ${target}`), { code: 'ELOOP' });
        if (entry.kind !== 'dir' && (flag & fs.constants.O_DIRECTORY)) throw Object.assign(new Error(`ENOTDIR: ${target}`), { code: 'ENOTDIR' });
        calls.push(['opendir', target]);
        const fd = nextFd++;
        fds.set(fd, target);
        return fd;
      }
      if (flag === 'wx' && entries.has(target)) throw eexist(target);
      calls.push(['open', target]);
      put(target, { kind: 'file', content: '', mode });
      const fd = nextFd++;
      fds.set(fd, target);
      return fd;
    },
    fstatSync: (fd) => stat(entries.get(fds.get(fd))),
    fchownSync: (fd, uid, gid) => {
      calls.push(['fchown', fds.get(fd), uid, gid]);
      Object.assign(entries.get(fds.get(fd)), { uid, gid });
    },
    fchmodSync: (fd, mode) => { entries.get(fds.get(fd)).mode = mode; },
    writeSync: (fd, content) => { entries.get(fds.get(fd)).content += content; },
    readSync: (fd, buffer, offset, length) => {
      const bytes = Buffer.from(entries.get(fds.get(fd)).content || '', 'utf8');
      return bytes.copy(buffer, offset, 0, Math.min(length, bytes.length));
    },
    fsyncSync: () => {},
    closeSync: (fd) => { fds.delete(fd); },
    renameSync: (from, to) => {
      calls.push(['rename', from, to]);
      entries.set(to, entries.get(from));
      entries.delete(from);
    },
    symlinkSync: (target, link) => { put(link, { kind: 'link', target }); },
    readlinkSync: (link) => entries.get(link).target,
    unlinkSync: (target) => { calls.push(['unlink', target]); entries.delete(target); },
    rmSync: (target) => {
      calls.push(['rm', target]);
      for (const key of [...entries.keys()]) if (key === target || key.startsWith(`${target}/`)) entries.delete(key);
    },
  };
  return fsImpl;
}

module.exports = { createFakeFs };
