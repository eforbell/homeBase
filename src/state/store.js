const fs = require('fs');
const path = require('path');

function defaultState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapPlans: [],
    installations: {},
  };
}

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ...defaultState(),
        ...parsed,
        bootstrapPlans: Array.isArray(parsed.bootstrapPlans) ? parsed.bootstrapPlans : [],
        installations: parsed.installations && typeof parsed.installations === 'object' ? parsed.installations : {},
      };
    } catch (error) {
      if (error.code === 'ENOENT') return defaultState();
      throw error;
    }
  }

  save(state) {
    const nextState = {
      ...defaultState(),
      ...state,
      updatedAt: new Date().toISOString(),
    };

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(nextState, null, 2) + '\n', 'utf8');
    fs.renameSync(tempPath, this.filePath);
    return nextState;
  }
}

module.exports = {
  StateStore,
  defaultState,
};
