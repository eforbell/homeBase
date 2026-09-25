const { compileAction, generateSecretBindings } = require('./actions');
const { executePlan } = require('./execute');
const { readExistingDatabasePassword } = require('./handlers');
const { appLayout } = require('../src/operations/app-layout');
const { getAppById } = require('../src/catalog');

// Compiles, journals, and runs one action. The journal is written before the first event so the
// outcome survives a lost connection or a Home Base restart; the peer going away never stops a plan.
function createRunAction({ handlers, journal, compile = compileAction, execute = executePlan, existingPassword = (layout) => readExistingDatabasePassword({ layout }) }) {
  return async function runAction(spec, { emit: send, jobId, requestId }) {
    const { plan, planDigest } = compile(spec);
    journal.begin({ jobId, requestId, action: spec, plan, planDigest });
    const emit = (event) => {
      journal.progress(jobId, event);
      try { send(event); } catch { /* peer gone; the journal still has it */ }
    };
    // The accepted plan is streamed first so Home Base records exactly what ran (it holds no secrets).
    emit({ eventType: 'plan.accepted', planDigest, plan });
    try {
      // Only installs bind secrets; lifecycle handlers read live wiring themselves when they need it.
      const layout = plan.kind === 'app-install' ? appLayout(getAppById(plan.target)) : null;
      const existing = layout?.database ? { databasePassword: existingPassword(layout) } : {};
      const execution = await execute({ plan, secretBindings: generateSecretBindings(plan, { existing }) }, { handlers, emit });
      journal.finish(jobId, { ok: true });
      return { planDigest, ...execution };
    } catch (error) {
      journal.finish(jobId, { ok: false, error: error.message });
      throw error;
    }
  };
}

module.exports = { createRunAction };
