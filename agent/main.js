#!/usr/bin/env node
// ==========================================================================
// SAMVIT V12 — DESKTOP AGENT DAEMON
// --------------------------------------------------------------------------
// Run this on the computer you want Samvit to be able to work on:
//
//     node agent/pair.js <PAIRING-CODE>     (once, with a code from the UI)
//     node agent/main.js                    (start the agent)
//
// It polls Samvit for approved work, executes it locally under the scope and
// command restrictions the user configured, and reports a real observation
// back. It never listens on a port, never accepts an inbound connection, and
// holds no credential that can act on the cloud account.
// ==========================================================================
import {pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';
import {requireConfig, configPath} from './config.js';
import {createTransport} from './transport.js';
import {executeAction} from './executor.js';
import {adapterRegistry} from './adapters.js';
import {createReceiptStore, shouldRecord} from './receipts.js';

/**
 * One poll cycle. Exported so it can be tested without running the daemon.
 * Returns a summary rather than throwing, so a single bad action cannot take
 * the agent down.
 *
 * `receipts` makes redelivery safe: an action that already completed is
 * replayed from its receipt instead of being performed a second time.
 *
 * `host` is the executor's path bridge (see executor.js). Production leaves
 * it undefined — the native bridge — so behaviour on a real PC is unchanged.
 */
export async function runOnce(transport, {log = () => {}, execute = executeAction, receipts = null, host = undefined} = {}) {
  const {actions = [], halted} = await transport.poll();
  if (halted) {
    log('Samvit has engaged the emergency stop; not taking new work.');
    return {executed: 0, refused: 0, replayed: 0, halted: true};
  }
  const policy = transport.policy || {scopes: [], approvedCommands: []};
  let executed = 0, refused = 0, replayed = 0;
  for (const action of actions) {
    try {
      const receipt = receipts?.get(action.id);
      if (receipt) {
        // Already done. Re-report the original outcome; do NOT run it again.
        replayed++;
        await transport.complete(action.id, {observation: receipt.observation, report: receipt.report});
        log(`replay ${action.capability} (already completed; not run again)`);
        continue;
      }
      const {observation, result} = await execute({
        capability: action.capability,
        args: action.args,
        scopes: policy.scopes || [],
        approvedCommands: policy.approvedCommands || [],
        ...(host ? {host} : {})
      });
      // Durable receipt FIRST, report second. The dangerous crash window is
      // "effect happened, report never landed": if the receipt were written
      // only after a successful report, that window would re-execute the
      // operation on redelivery. Written before, any later crash replays the
      // receipt instead of performing the effect twice.
      if (receipts && shouldRecord(action.capability)) {
        receipts.put(action.id, {capability: action.capability, observation, report: result});
      }
      await transport.complete(action.id, {observation, report: result});
      executed++;
      log(`ok    ${action.capability}${result ? ` -> ${JSON.stringify(result).slice(0, 200)}` : ''}`);
    } catch (error) {
      // A refusal is reported, not swallowed — the cloud verifies it and the
      // user sees why nothing happened.
      refused++;
      log(`refuse ${action.capability}: ${error.message}`);
      try { await transport.complete(action.id, {error: error.message}); } catch { /* report is best-effort */ }
    }
  }
  return {executed, refused, replayed, halted: false};
}

export async function main({log = message => console.log(message)} = {}) {
  const config = requireConfig();
  const configFile = configPath();
  const receipts = createReceiptStore(join(dirname(configFile), 'receipts.json'));
  const transport = createTransport({
    cloudUrl: config.cloudUrl,
    deviceId: config.deviceId,
    deviceToken: config.deviceToken,
    pollMs: config.pollMs
  });
  const interval = Math.max(1000, Number(config.pollMs) || 3000);

  log(`Samvit desktop agent running for "${config.deviceName || 'this computer'}"`);
  log(`Polling ${config.cloudUrl} every ${interval} ms. Press Ctrl+C to stop.`);
  log(`Durable receipts: ${receipts.size()} recorded.`);
  const adapters = adapterRegistry().list().filter(adapter => !adapter.available).map(adapter => adapter.name);
  log(`Not implemented in this release: ${adapters.join(', ')}`);

  let stopped = false;
  const stop = () => { stopped = true; log('Stopping.'); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopped) {
    try {
      await runOnce(transport, {log, receipts});
    } catch (error) {
      // Network blips are normal; keep polling rather than exiting.
      log(`poll failed: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
