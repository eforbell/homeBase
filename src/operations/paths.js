// Fixed host locations shared by the executor, the compilers, and the web process. No dependencies,
// so the unprivileged web service can import it without loading the executor's validators.
module.exports = Object.freeze({
  APPS_ROOT: '/opt/sovereign-home/apps',
  MIRROR_ROOT: '/var/lib/sovereign-home/git-mirrors',
  BACKUP_ROOT: '/var/lib/sovereign-home/backups',
  // Per-app data parents (/var/lib/sovereign-home/<app id>) and the shared user's HOME.
  DATA_ROOT: '/var/lib/sovereign-home',
  SHARED_USER: 'sovereign',
  SHARED_HOME: '/var/lib/sovereign-home/sovereign',
  // App sockets (SID-002): /run/sovereign-apps/<app id>/app.sock, the directory <app user>:<nginx group> 2750.
  APP_SOCKET_ROOT: '/run/sovereign-apps',
  NGINX_GROUP: 'www-data',
});
