'use strict';

/**
 * Resolution of the `dsh` executable — pure function, unit-testable.
 * Caller passes environment facts explicitly (testable without Electron).
 *
 * Priority:
 *   1. $DSH_DESKTOP_DSH_BIN env var (explicit override)
 *   2. User-local runtime: userData/runtime/dsh/node.exe + bin.js (UPDATABLE)
 *   3. Bundled runtime: resources/dsh/node.exe + dsh/lib/bin.js
 *   4. PATH dsh.cmd / dsh (system installation)
 *
 * Strategy 2 ships a portable Node.js + the full @deepseek-ai/dsh package
 * tree inside the installer, so the app works on machines without Node.js.
 * Strategy 2 can be auto-updated when a newer npm version is found.
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
 * @param {string} [ctx.userData]  app.getPath('userData'), for user-local runtime
 * @returns {{cmd: string, args: string[], needsShell: boolean} | {cmd: string, needsShell: boolean}}
 */
function resolveDshCommand({
  isPackaged,
  resourcesPath,
  env = process.env,
  platform = process.platform,
  preferSystem = false,
  userData,
}) {
  // 1. explicit override
  if (env.DSH_DESKTOP_DSH_BIN) {
    return { cmd: env.DSH_DESKTOP_DSH_BIN, needsShell: false };
  }

  // When preferSystem is true, try system PATH first
  if (preferSystem) {
    const sysName = platform === 'win32' ? 'dsh.cmd' : 'dsh';
    return { cmd: sysName, needsShell: platform === 'win32' };
  }

  // 2. User-local runtime (updatable copy)
  if (userData) {
    const nodeExe = path.join(userData, 'runtime', 'dsh', 'node.exe');
    const dshBin = path.join(
      userData, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
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

  // 4. PATH fallback
  const name = platform === 'win32' ? 'dsh.cmd' : 'dsh';
  return { cmd: name, needsShell: platform === 'win32' };
}

module.exports = { resolveDshCommand };
