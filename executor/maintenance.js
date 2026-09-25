const fs = require('fs');

// install.sh --repair/--repair-executor creates this root-owned flag before it checks for active work,
// and removes it when it exits. While it exists the executor accepts no new mutating request, so a
// repair can never race a job that starts mid-copy or just before the service is stopped.
// /run/homebase is root-owned: the web process can neither set nor clear it.
const MAINTENANCE_FLAG = '/run/homebase/executor.maintenance';

function maintenanceActive({ fsImpl = fs, flag = MAINTENANCE_FLAG } = {}) {
  try {
    const stat = fsImpl.lstatSync(flag);
    return stat.isFile() && stat.uid === 0;
  } catch { return false; }
}

module.exports = { MAINTENANCE_FLAG, maintenanceActive };
