const fs = require('fs');
const path = require('path');
const { getAppById } = require('../catalog');

function getBackupRoot(appId, config = {}) {
  return `${(config.baseBackupDir || '/var/lib/sovereign-home/backups').replace(/\/$/, '')}/${appId}`;
}

function listBackups({ appId, config = {} }) {
  const app = getAppById(appId);
  if (!app) {
    const error = new Error(`Unknown app id: ${appId}`);
    error.code = 'APP_NOT_FOUND';
    throw error;
  }

  const backupRoot = getBackupRoot(appId, config);
  let entries = [];
  try {
    entries = fs.readdirSync(backupRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const fullPath = path.join(backupRoot, entry.name);
        const generatedAtFile = path.join(fullPath, 'backup-generated-at.txt');
        let generatedAt = null;
        try {
          generatedAt = fs.readFileSync(generatedAtFile, 'utf8').trim();
        } catch {
          generatedAt = null;
        }
        return {
          name: entry.name,
          archiveDir: fullPath,
          generatedAt,
        };
      })
      .sort((a, b) => (b.generatedAt || b.name).localeCompare(a.generatedAt || a.name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return {
    app: { id: app.id, name: app.name },
    backupRoot,
    backups: entries,
  };
}

module.exports = {
  getBackupRoot,
  listBackups,
};
