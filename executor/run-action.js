const { compileAction, generateSecretBindings } = require('./actions');
const { ProtocolError } = require('./protocol-error');
const { executePlan } = require('./execute');
const { readExistingDatabasePassword } = require('./handlers');
const { appLayout } = require('../src/operations/app-layout');
const { getAppById } = require('../src/catalog');

// Compiles, journals, and runs one action. The journal is written before the first event so the
// outcome survives a lost connection or a Home Base restart; the peer going away never stops a plan.
function createRunAction({ handlers, journal, compile = compileAction, execute = executePlan, existingPassword = (layout, { duringMove = false } = {}) => readExistingDatabasePassword({ layout, duringMove }) }) {
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
      // Installs, adopts and moves write the app's .env, so they bind its existing database password;
      // other lifecycle handlers read live wiring themselves.
      const layout = ['app-install', 'app-adopt', 'app-move-user'].includes(plan.kind) ? appLayout(getAppById(plan.target)) : null;
      const existing = layout?.database ? { databasePassword: existingPassword(layout, { duringMove: plan.kind === 'app-move-user' }) } : {};
      // Adopting and moving keep the running app's credentials and never create them: a fresh one in the
      // .env would no longer match the database role (a move once did this to an app whose URL key is its own).
      if (['app-adopt', 'app-move-user'].includes(plan.kind) && layout?.database && !existing.databasePassword) {
        throw new ProtocolError('POLICY_DENIED', `${layout.app.name} has no database wiring in its .env; nothing to ${plan.kind === 'app-adopt' ? 'adopt' : 'move'} (it keeps an app's existing credentials and never creates them).`);
      }
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
