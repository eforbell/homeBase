const fs = require('fs');
const path = require('path');
const { writeFileAtomic, lstatOrNull } = require('./handlers');

// Durable record of every accepted action, so Home Base can learn the real outcome after it lost the
// connection or restarted. One root-only JSON file per job; entries hold the accepted plan (secret ref
// names only, never values) and progress. Anything still "running" when the executor starts again was
// cut off by an executor restart and is marked "interrupted".
const JOURNAL_DIR = '/var/lib/homebase-executor/jobs';
const KEEP = 200;

function createJournal({ dir = JOURNAL_DIR, fsImpl = fs, now = () => new Date() } = {}) {
  const fileFor = (jobId) => path.join(dir, `${jobId}.json`);
  const ensureDir = () => {
    if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatOrNull(fsImpl, dir);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== 0) throw new Error(`${dir} must be a root-owned directory.`);
  };
  const read = (jobId) => {
    if (!/^[1-9][0-9]{0,14}$/.test(String(jobId))) return null;
    try { return JSON.parse(fsImpl.readFileSync(fileFor(jobId), 'utf8')); } catch { return null; }
  };
  const write = (entry) => {
    ensureDir();
    writeFileAtomic(fsImpl, fileFor(entry.jobId), `${JSON.stringify(entry)}\n`, 0o600);
  };
  // Oldest first by start time (job ids restart if Home Base's database is recreated), never the entry
  // just written.
  const prune = (keepJobId) => {
    const entries = fsImpl.readdirSync(dir).filter((name) => /^[1-9][0-9]{0,14}\.json$/.test(name))
      .map((name) => ({ name, jobId: name.slice(0, -5), startedAt: read(name.slice(0, -5))?.startedAt || '' }))
      .filter((entry) => entry.jobId !== String(keepJobId))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const entry of entries.slice(0, Math.max(0, entries.length - (KEEP - 1)))) fsImpl.unlinkSync(path.join(dir, entry.name));
  };

  return {
    begin({ jobId, requestId, action, plan, planDigest }) {
      write({ jobId, requestId, action, planDigest, plan, status: 'running', completedOperationIds: [], startedAt: now().toISOString() });
      prune(jobId);
    },
    progress(jobId, event) {
      const entry = read(jobId);
      if (!entry) return;
      if (event.eventType === 'operation.completed' && !entry.completedOperationIds.includes(event.operationId)) entry.completedOperationIds.push(event.operationId);
      else if (event.eventType === 'operation.failed') entry.failedOperationId = event.operationId;
      else return;
      write(entry);
    },
    finish(jobId, { ok, error = null }) {
      const entry = read(jobId);
      if (!entry) return;
      write({ ...entry, status: ok ? 'completed' : 'failed', error: error ? String(error).slice(0, 2000) : null, finishedAt: now().toISOString() });
    },
    // Called once at executor start: no plan can still be running in a fresh process.
    markInterrupted() {
      if (!fsImpl.existsSync(dir)) return;
      for (const name of fsImpl.readdirSync(dir).filter((file) => /^[1-9][0-9]{0,14}\.json$/.test(file))) {
        const entry = read(name.slice(0, -5));
        if (entry?.status === 'running') write({ ...entry, status: 'interrupted', finishedAt: now().toISOString() });
      }
    },
    // An entry answers only for the run-action request that created it; a reused job id (e.g. after
    // Home Base's database was recreated) reads as unknown rather than someone else's outcome.
    status(jobId, requestId) {
      const entry = read(jobId);
      return entry && entry.requestId === requestId ? entry : { jobId: String(jobId), status: 'unknown' };
    },
  };
}

module.exports = { JOURNAL_DIR, createJournal };
