// Fixed host locations shared by the executor, the compilers, and the web process. No dependencies,
// so the unprivileged web service can import it without loading the executor's validators.
module.exports = Object.freeze({
  APPS_ROOT: '/opt/sovereign-home/apps',
  MIRROR_ROOT: '/var/lib/sovereign-home/git-mirrors',
  BACKUP_ROOT: '/var/lib/sovereign-home/backups',
});
