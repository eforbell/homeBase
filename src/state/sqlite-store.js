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

  getLatestJobByKind(kind) {
    return runSqliteOp(this.dbPath, 'get_latest_job_by_kind', { kind });
  }

  recordBackup(record) {
    return runSqliteOp(this.dbPath, 'record_backup', { record });
  }

  listBackups(appId) {
    return runSqliteOp(this.dbPath, 'list_backups', { appId });
  }

  deleteBackups(appId) {
    return runSqliteOp(this.dbPath, 'delete_backups', { appId });
  }

  deleteInstallation(appId) {
    return runSqliteOp(this.dbPath, 'delete_installation', { appId });
  }

  getHomeBaseConfig() {
    return runSqliteOp(this.dbPath, 'get_homebase_config');
  }

  setHomeBaseConfig(record) {
    return runSqliteOp(this.dbPath, 'set_homebase_config', { record });
  }

  getAdminCredential() {
    return runSqliteOp(this.dbPath, 'get_admin_credential');
  }

  setAdminCredential(record) {
    return runSqliteOp(this.dbPath, 'set_admin_credential', { record });
  }

  createAdminSession(record) {
    return runSqliteOp(this.dbPath, 'create_admin_session', { record });
  }

  getAdminSession(tokenHash) {
    return runSqliteOp(this.dbPath, 'get_admin_session', { tokenHash });
  }

  deleteAdminSession(tokenHash) {
    return runSqliteOp(this.dbPath, 'delete_admin_session', { tokenHash });
  }

  deleteAllAdminSessions() {
    return runSqliteOp(this.dbPath, 'delete_all_admin_sessions');
  }

  pruneAdminSessions(nowIso) {
    return runSqliteOp(this.dbPath, 'prune_admin_sessions', { nowIso });
  }

  createAdminAudit(record) {
    return runSqliteOp(this.dbPath, 'create_admin_audit', { record });
  }

  listAdminAudit(limit = 50) {
    return runSqliteOp(this.dbPath, 'list_admin_audit', { limit });
  }
}

module.exports = {
  SqliteStateStore,
};
