const { runSqliteOp } = require('./sqlite-driver');

class SqliteStateStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
  }

  init() {
    runSqliteOp(this.dbPath, 'init');
  }

  loadState() {
    return runSqliteOp(this.dbPath, 'load_state');
  }

  addBootstrapPlan(record) {
    return runSqliteOp(this.dbPath, 'add_bootstrap_plan', record);
  }

  upsertInstallation(record) {
    return runSqliteOp(this.dbPath, 'upsert_installation', { record });
  }

  createJob(job) {
    return runSqliteOp(this.dbPath, 'create_job', { job });
  }

  appendJobLog(jobId, text) {
    return runSqliteOp(this.dbPath, 'append_job_log', { jobId, text });
  }

  updateJob(jobId, fields) {
    return runSqliteOp(this.dbPath, 'update_job', { jobId, fields });
  }

  getJob(jobId) {
    return runSqliteOp(this.dbPath, 'get_job', { jobId });
  }

  recordBackup(record) {
    return runSqliteOp(this.dbPath, 'record_backup', { record });
  }

  listBackups(appId) {
    return runSqliteOp(this.dbPath, 'list_backups', { appId });
  }
}

module.exports = {
  SqliteStateStore,
};
