// ==========================================================================
// SAMVIT V12 — COMPUTER ADAPTERS (Phase 12)
// --------------------------------------------------------------------------
// DECLARED, DELIBERATELY NOT IMPLEMENTED.
//
// The brief is explicit: do not build unrestricted browser or GUI automation
// yet, but create clean interfaces first. These are those interfaces.
//
// The point of declaring them now is that they plug into the SAME pipeline as
// everything else — permission → action → observation → verification — so
// adding a real browser or vision implementation later does not mean
// inventing a second, less-guarded execution path.
//
// Every adapter reports `available: false` and refuses to execute, so there
// is no way to reach unguarded behaviour by accident.
// ==========================================================================

export const ADAPTER_KINDS = Object.freeze(['browser', 'screen', 'application', 'filesystem']);

/**
 * A ComputerAction is the only envelope any adapter may execute. It is the
 * same shape the policy engine already understands.
 */
export function computerAction({capability, args = {}, adapter = 'filesystem', deviceId = null, missionId = null}) {
  if (typeof capability !== 'string' || !capability) throw Error('A capability is required');
  if (!ADAPTER_KINDS.includes(adapter)) throw Error(`Unknown adapter: ${adapter}`);
  return {capability, args, adapter, deviceId, missionId};
}

export function createAdapter({kind, name, actions = [], notes = ''}) {
  if (!ADAPTER_KINDS.includes(kind)) throw Error(`Unknown adapter kind: ${kind}`);
  return Object.freeze({
    kind,
    name,
    notes,
    available: false,
    actions: Object.freeze([...actions]),
    /** Present so the pipeline is complete; refuses until implemented. */
    async execute() {
      throw Object.assign(
        Error(`The ${name} is not implemented in this release. It is declared so future computer interaction reuses the same permission, observation and verification pipeline.`),
        {reason: 'adapter_unavailable', adapter: kind}
      );
    },
    /** What a future implementation would need before it could be enabled. */
    requirements() {
      return {
        permissionLevel: 'HIGH_IMPACT_ACTION',
        userConfirmation: true,
        capabilities: this.actions,
        implemented: false
      };
    }
  });
}

export const browserAdapter = () => createAdapter({
  kind: 'browser',
  name: 'BrowserAdapter',
  actions: ['navigate', 'readPage', 'screenshot', 'click', 'type'],
  notes: 'Would drive a real browser. Requires per-origin allow-listing and user confirmation.'
});

export const screenObserver = () => createAdapter({
  kind: 'screen',
  name: 'ScreenObserver',
  actions: ['capture', 'describe'],
  notes: 'Would capture and interpret the screen. Requires explicit, time-boxed consent.'
});

export const applicationAdapter = () => createAdapter({
  kind: 'application',
  name: 'ApplicationAdapter',
  actions: ['launch', 'focus', 'list'],
  notes: 'Would control desktop applications. Requires an explicit per-application allow-list.'
});

/** The filesystem adapter is the one that IS implemented (see executor.js). */
export const filesystemAdapter = () => Object.freeze({
  kind: 'filesystem',
  name: 'FilesystemAdapter',
  notes: 'Implemented. Structured capabilities only; see shared/desktop.js.',
  available: true,
  actions: Object.freeze(['fs.list', 'fs.stat', 'fs.read', 'fs.search', 'fs.write', 'fs.mkdir', 'fs.move', 'fs.copy', 'fs.delete', 'dev.run', 'env.inspect']),
  requirements: () => ({permissionLevel: 'OBSERVE..SENSITIVE_ACTION', userConfirmation: true, implemented: true})
});

export function adapterRegistry() {
  const adapters = [filesystemAdapter(), browserAdapter(), screenObserver(), applicationAdapter()];
  return {
    list: () => adapters.map(adapter => ({
      kind: adapter.kind,
      name: adapter.name,
      available: adapter.available,
      actions: [...adapter.actions],
      notes: adapter.notes || ''
    })),
    get: kind => adapters.find(adapter => adapter.kind === kind) || null,
    /** Adapters are executed through executeAction(); nothing else is reachable. */
    async execute(action) {
      const adapter = adapters.find(entry => entry.kind === action?.adapter);
      if (!adapter) throw Object.assign(Error('Unknown adapter'), {reason: 'unknown_adapter'});
      if (!adapter.available) return adapter.execute(action);
      throw Object.assign(Error('Filesystem actions are executed by the executor, not the adapter registry'), {reason: 'use_executor'});
    }
  };
}
