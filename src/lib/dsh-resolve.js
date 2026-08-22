'use strict';

/**
 * Resolution of the `dsh` executable — pure function, unit-testable.
 * Caller passes environment facts explicitly (testable without Electron).
 *
 * Priority (production / isPackaged=true):
 *   1. $DSH_DESKTOP_DSH_BIN env var (explicit override)
 *   2. System PATH dsh.cmd / dsh (when preferSystem = true)
 *   3. User-level environment: envDir/node.exe + bin.js (deployed copy)
 *   4. Bundled runtime: resources/dsh/node.exe + bin.js (shipped in installer)
 *   5. PATH fallback (development, no bundled available)
 *
 * Development mode (isPackaged=false): jumps to 5 (PATH fallback).
 *
 * The user-level environment (priority 3, e.g. %USERPROFILE%\.dsh-desktop)
 * is deployed from the bundled runtime on first run and can be updated
 * independently when a newer DSH version is available.  Priority 4 is the
 * read-only fallback shipped inside the installer.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {object} ctx
 * @param {boolean} ctx.isPackaged  app.isPackaged
 * @param {string} ctx.resourcesPath process.resourcesPath (packaged app)
 * @param {NodeJS.ProcessEnv} [ctx.env]
 * @param {string} [ctx.platform] process.platform
 * @param {boolean} [ctx.preferSystem]  if true, system PATH dsh takes priority over all
 * @param {string} [ctx.envDir]  user-level environment dir (e.g. %USERPROFILE%\.dsh-desktop)
 * @param {boolean} [ctx.forceBundled]  if true, ignore preferSystem and always use bundled/envDir (Plugins edition)
 * @returns {{cmd: string, args: string[], needsShell: boolean} | {cmd: string, needsShell: boolean}}
 */
function resolveDshCommand({
  isPackaged,
  resourcesPath,
  env = process.env,
  platform = process.platform,
  preferSystem = false,
  envDir,
  forceBundled = false,
}) {
  // 1. explicit override
  if (env.DSH_DESKTOP_DSH_BIN) {
    return { cmd: env.DSH_DESKTOP_DSH_BIN, needsShell: false };
  }

  // Plugins edition: never use system dsh (it lacks the bundled plugins).
  // Skip the preferSystem branch entirely.
  if (!forceBundled && preferSystem) {
    const sysName = platform === 'win32' ? 'dsh.cmd' : 'dsh';
    return { cmd: sysName, needsShell: platform === 'win32' };
  }

  // Development mode: use PATH directly
  if (!isPackaged) {
    const name = platform === 'win32' ? 'dsh.cmd' : 'dsh';
    return { cmd: name, needsShell: platform === 'win32' };
  }

  // 2. User-level environment (deployed copy, can be updated)
  if (envDir) {
    const nodeExe = path.join(envDir, 'node.exe');
    const dshBin = path.join(
      envDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
    );
    if (fs.existsSync(nodeExe) && fs.existsSync(dshBin)) {
      return { cmd: nodeExe, args: [dshBin], needsShell: false };
    }
  }

  // 3. bundled runtime shipped next to the app (resources/dsh/)
  if (isPackaged && resourcesPath) {
    const nodeExe = path.join(resourcesPath, 'dsh', 'node.exe');
    const dshBin = path.join(
      resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
    );
    if (fs.existsSync(nodeExe) && fs.existsSync(dshBin)) {
      return { cmd: nodeExe, args: [dshBin], needsShell: false };
    }
  }

  // 4. PATH fallback (last resort)
  const name = platform === 'win32' ? 'dsh.cmd' : 'dsh';
  return { cmd: name, needsShell: platform === 'win32' };
}

module.exports = { resolveDshCommand };
