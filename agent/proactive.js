// ==========================================================================
// SAMVIT V14 — AGENT PROACTIVE WATCHER (P14)
// --------------------------------------------------------------------------
// Runs INSIDE the desktop agent. It watches folders the user explicitly
// enabled (cloud is the source of truth for which), debounces file events
// and posts one advisory signal per burst. Everything is contained: a watch
// can only target a folder already authorised on this computer — the same
// checkScopeAccess rule as every read capability, evaluated here, not
// trusted from the cloud.
//
// Honest platform note: fs.watch is recursive on Windows/macOS; on Linux it
// covers the authorised folder's immediate entries (depth 0).
// ==========================================================================
import {watch} from 'node:fs';
import {checkScopeAccess} from '../shared/desktop.js';
import {DEBOUNCE_MS} from '../shared/proactive.js';

/**
 * Reconcile running watchers with the monitor set the cloud wants active.
 * Pure-ish with real fs side effects; returns the NEXT watcher map so it is
 * fully testable per call.
 *
 * @param {Map} current   monitorId -> {close(), timer, lastPath}
 * @param {Array} monitors from the cloud: {id, kind, path}
 * @param {Array} scopes  authorised folders from the device policy
 */
export function reconcileWatchers(current, monitors, scopes, {host, onEvent, log = () => {}, debounceMs = DEBOUNCE_MS} = {}) {
  const next = new Map();
  const wanted = new Map();
  for (const monitor of Array.isArray(monitors) ? monitors : []) {
    if (!monitor?.id || monitor.kind !== 'watch.folder' || typeof monitor.path !== 'string') continue;
    wanted.set(monitor.id, monitor);
  }
  for (const [id, entry] of current) {
    if (wanted.has(id) && wanted.get(id).path === entry.path) {
      next.set(id, entry);
      wanted.delete(id);
    } else {
      try { entry.close(); } catch { /* closing an already-dead watcher */ }
    }
  }
  for (const [id, monitor] of wanted) {
    // Containment, locally: the watch target must be inside an authorised
    // (read) folder. If the cloud record ever drifted, the agent refuses.
    const access = checkScopeAccess(scopes || [], monitor.path, 'read');
    if (!access.allowed) { log(`watch "${monitor.path}" refused locally: ${access.reason}`); continue; }
    const real = host.toHostPath(monitor.path);
    const entry = {path: monitor.path, timer: null, pending: null, close: null};
    try {
      const recursive = process.platform === 'win32' || process.platform === 'darwin';
      const watcher = watch(real, {recursive}, () => schedule(id, entry, monitor, onEvent, log, debounceMs));
      watcher.on('error', error => log(`watch "${monitor.path}" dropped: ${error.message}`));
      entry.close = () => watcher.close();
      next.set(id, entry);
      log(`watching "${monitor.path}" for change signals${recursive ? '' : ' (depth 0 on this platform)'}`);
    } catch (error) {
      log(`cannot watch "${monitor.path}": ${error.message}`);
    }
  }
  return next;
}

/** Debounce per monitor: a burst of file activity becomes ONE signal. */
function schedule(id, entry, monitor, onEvent, log, debounceMs) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    try { await onEvent({monitorId: monitor.id, path: monitor.path, event: 'changed'}); }
    catch (error) { log(`signal for "${monitor.path}" was not accepted: ${error.message}`); }
  }, debounceMs);
}

/** Tear every watcher down (agent shutdown). */
export function closeWatchers(map) {
  for (const entry of map.values()) { clearTimeout(entry.timer); try { entry.close(); } catch { /* idempotent */ } }
}
