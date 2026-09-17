#!/usr/bin/env node
// ==========================================================================
// SAMVIT V12 — PAIR THIS COMPUTER
// --------------------------------------------------------------------------
//     node agent/pair.js <PAIRING-CODE> --cloud https://your-site.netlify.app
//
// The pairing code comes from Samvit (Workspace → Computers → Pair). It is
// single-use and expires in 5 minutes. Redeeming it returns a device token,
// which is written to a private config file OUTSIDE this repository — a
// repository clone never carries a credential.
// ==========================================================================
import {platform, arch, hostname} from 'node:os';
import {pathToFileURL} from 'node:url';
import {normalizeCloudUrl, saveConfig, configPath, loadConfig} from './config.js';
import {createTransport} from './transport.js';

export async function pair({code, cloudUrl, deviceName, configFile} = {}) {
  if (!code) throw Error('A pairing code is required');
  const url = normalizeCloudUrl(cloudUrl);
  const name = deviceName || hostname() || platform();
  const transport = createTransport({cloudUrl: url, deviceId: null, deviceToken: null});
  const result = await transport.pair({code, deviceName: name, platform: platform(), arch: arch()});
  const path = saveConfig({
    cloudUrl: url,
    deviceId: result.deviceId,
    deviceToken: result.deviceToken,
    deviceName: name,
    pairedAt: new Date().toISOString(),
    pollMs: 3000
  }, configFile || configPath());
  return {path, device: result.device};
}

const parseArgs = argv => {
  const options = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cloud') options.cloudUrl = argv[++i];
    else if (argv[i] === '--name') options.deviceName = argv[++i];
    else if (argv[i] === '--config') options.configFile = argv[++i];
    else rest.push(argv[i]);
  }
  options.code = rest[0];
  return options;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const existing = (() => { try { return loadConfig(options.configFile || configPath()); } catch { return null; } })();
  const cloudUrl = options.cloudUrl || existing?.cloudUrl || process.env.SAMVIT_CLOUD_URL;
  if (!options.code) {
    console.error('Usage: node agent/pair.js <PAIRING-CODE> --cloud https://your-site.netlify.app [--name "My PC"]');
    process.exit(1);
  }
  if (!cloudUrl) {
    console.error('A Samvit address is required: --cloud https://your-site.netlify.app (or set SAMVIT_CLOUD_URL)');
    process.exit(1);
  }
  pair({...options, cloudUrl})
    .then(result => {
      console.log(`Paired "${result.device.name}".`);
      console.log(`Credentials written to ${result.path}`);
      console.log('Authorise folders in Samvit before starting the agent, then run:  node agent/main.js');
    })
    .catch(error => {
      console.error(error.message);
      process.exit(1);
    });
}
