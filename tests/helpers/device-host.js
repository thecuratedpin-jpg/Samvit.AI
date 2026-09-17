// tests/helpers/device-host.js
// SAMVIT — platform-aware device host for executor/agent tests.
//
// The Windows path hardening in shared/desktop.js is intentionally
// Windows-specific and is NOT weakened for tests. Instead, the executor
// accepts a host path bridge (agent/executor.js, `nativeHost`):
//
//   * ON WINDOWS  — the native bridge. Scope paths are REAL temp
//                   directories on C:\ and every byte of the genuine
//                   end-to-end path is exercised.
//   * ELSEWHERE   — a POSIX bridge that maps synthetic drive letters
//                   (C:\, Z:\) onto directories under one temp folder.
//                   canonicalPath, scope containment, realpath re-checks
//                   and the command floor all run EXACTLY as production;
//                   only the final OS syscall path is translated.
//
// On both platforms "refused" therefore means the filesystem was genuinely
// never touched, and the symlink/junction escape test exercises the real
// realpath re-check.
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, relative, sep} from 'node:path';
import {nativeHost} from '../../agent/executor.js';

const DRIVE = /^([A-Za-z]):\\(.*)$/;

/**
 * Create an isolated "computer" for a test.
 *
 * @returns {Promise<{
 *   platform: 'native'|'posix-bridge',
 *   host: object,                     // executor host bridge
 *   scopePath: string,                // Windows-form authorised folder
 *   winPath: (...s: string[]) => string,       // Windows-form path inside the scope
 *   hostPath: (winForm: string) => string,     // real OS path, for assertions
 *   outsideRoot: string,              // Windows-form root the scope does NOT cover
 *   outsidePath: (...s: string[]) => string,
 *   receiptsDir: string,              // host dir the agent may keep receipts in
 *   cleanup: () => Promise<void>
 * }>}
 */
export async function createDeviceHost({prefix = 'samvit-host-', scopeSegments = ['Projects', 'Samvit']} = {}) {
  if (process.platform === 'win32') {
    const scope = await fs.realpath(await fs.mkdtemp(join(tmpdir(), prefix)));
    const outside = await fs.realpath(await fs.mkdtemp(join(tmpdir(), `${prefix}out-`)));
    return {
      platform: 'native',
      host: nativeHost,
      scopePath: scope,
      winPath: (...segments) => [scope, ...segments].join('\\'),
      hostPath: winForm => winForm,
      outsideRoot: outside,
      outsidePath: (...segments) => [outside, ...segments].join('\\'),
      receiptsDir: scope,
      cleanup: () => Promise.all([
        fs.rm(scope, {recursive: true, force: true}),
        fs.rm(outside, {recursive: true, force: true})
      ]).then(() => {})
    };
  }

  // POSIX bridge: one temp root stands in for the machine; each drive letter
  // is a directory beneath it.
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), prefix)));
  const drivesRoot = join(base, 'drives');

  const driveFor = winForm => {
    const match = DRIVE.exec(winForm);
    if (!match) throw Error(`Not a Windows-canonical path: ${winForm}`);
    return match;
  };

  const toHostPath = winForm => {
    const [, letter, rest] = driveFor(winForm);
    return join(drivesRoot, letter.toLowerCase(), ...rest.split('\\').filter(Boolean));
  };

  const fromHostPath = hostPath => {
    const rel = relative(base, resolve(hostPath));
    const segments = rel.split(sep).filter(segment => segment && segment !== '..');
    if (segments[0] === 'drives' && /^[a-z]$/.test(segments[1] || '')) {
      const rest = segments.slice(2);
      return rest.length ? `${segments[1].toUpperCase()}:\\${rest.join('\\')}` : `${segments[1].toUpperCase()}:\\`;
    }
    // Anything that resolves outside the mapped drives (e.g. a symlink that
    // escaped the namespace) lands on a drive that is never authorised, so
    // containment refuses it deterministically — the production verdict.
    return `Z:\\unmapped\\${segments.join('\\') || 'escape'}`;
  };

  const host = Object.freeze({name: 'posix-bridge', toHostPath, fromHostPath});

  // The machine has two drives: C: (the scope lives here) and Z: (the
  // "outside" target for escape tests). Both drive roots must exist for
  // realpath walking, exactly like a real PC's drive roots always exist.
  const scopeWin = `C:\\${scopeSegments.join('\\')}`;
  await fs.mkdir(toHostPath(scopeWin), {recursive: true});
  await fs.mkdir(join(drivesRoot, 'z'), {recursive: true});

  const outsideWin = 'Z:\\outside';
  await fs.mkdir(toHostPath(outsideWin), {recursive: true});

  return {
    platform: 'posix-bridge',
    host,
    scopePath: scopeWin,
    winPath: (...segments) => [scopeWin, ...segments].join('\\'),
    hostPath: toHostPath,
    outsideRoot: outsideWin,
    outsidePath: (...segments) => [outsideWin, ...segments].join('\\'),
    receiptsDir: base,
    cleanup: () => fs.rm(base, {recursive: true, force: true})
  };
}
