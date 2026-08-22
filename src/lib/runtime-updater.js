'use strict';

/**
 * Runtime updater — ensures the user-level dsh environment is consistent.
 *
 * The environment lives at %USERPROFILE%\.dsh-desktop\ — independent of the
 * app install directory and of any system dsh installation. Layout:
 *
 *   .dsh-desktop/
 *     node.exe                ← portable Node.js
 *     node_modules/…          ← full @deepseek-ai/dsh dependency tree
 *     .version                ← @deepseek-ai/dsh version string
 *     dsh.cmd                 ← shim so the CLI works from any terminal
 *
 * Behavior:
 *   • ensureRuntime()   — deploy from resources/dsh/ when missing/incomplete
 *   • checkForUpdates() — background npm check; auto-update the
 *                         @deepseek-ai/dsh package (preserving node.exe and
 *                         all third-party deps so an offline install never
 *                         breaks)
 *   • installShim()     — create dsh.cmd for CLI usage
 *   • addEnvDirToPath() / removeEnvDirFromPath() — manage the user PATH
 *
 * Resolution priority (resolveDshCommand):
 *   1. $DSH_DESKTOP_DSH_BIN env var
 *   2. system PATH dsh.cmd/dsh (when preferSystem)
 *   3. user-level environment (.dsh-desktop/)
 *   4. resources/dsh/ (read-only fallback shipped in installer)
 *   5. PATH dsh.cmd/dsh (development fallback)
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const log = require('electron-log/main');

// ---------------------------------------------------------------------------
// paths (all keyed off the environment root dir)
// ---------------------------------------------------------------------------

function deployDir(envDir) {
  return envDir;
}

function versionFile(envDir) {
  return path.join(envDir, '.version');
}

function nodeExePath(envDir) {
  return path.join(envDir, 'node.exe');
}

function dshBinPath(envDir) {
  return path.join(envDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function commanderPath(envDir) {
  return path.join(envDir, 'node_modules', 'commander', 'package.json');
}

function shimPath(envDir) {
  return path.join(envDir, 'dsh.cmd');
}

/** The PATH entry we publish for this environment dir. */
function pathEntry(envDir) {
  const home = os.homedir();
  if (envDir.startsWith(home + path.sep) || envDir === home) {
    return '%USERPROFILE%' + envDir.slice(home.length);
  }
  return envDir;
}

// ---------------------------------------------------------------------------
// integrity check
// ---------------------------------------------------------------------------

function isRuntimeIntact(envDir) {
  return (
    fs.existsSync(nodeExePath(envDir)) &&
    fs.existsSync(dshBinPath(envDir)) &&
    fs.existsSync(versionFile(envDir)) &&
    fs.existsSync(commanderPath(envDir))
  );
}

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else if (entry.isFile()) {
      try {
        fs.copyFileSync(s, d);
      } catch (err) {
        log.warn('[runtime-updater] copy error ' + s + ': ' + err.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// version helpers
// ---------------------------------------------------------------------------

function readDeployedVersion(envDir) {
  try {
    const vf = versionFile(envDir);
    if (fs.existsSync(vf)) return fs.readFileSync(vf, 'utf-8').trim();
  } catch { /* ignore */ }
  return null;
}

function writeDeployedVersion(envDir, version) {
  try {
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(versionFile(envDir), version, 'utf-8');
  } catch (err) {
    log.warn('[runtime-updater] failed to write version file: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

/**
 * Ensure the user-level environment exists and is intact.
 * If missing or incomplete, deploy from the built-in resources.
 *
 * @param {object} opts
 * @param {string} opts.envDir        environment root (e.g. %USERPROFILE%\.dsh-desktop)
 * @param {string} [opts.resourcesPath] process.resourcesPath (packaged app)
 * @returns {string|null} path to deployed node.exe, or null
 */
function ensureRuntime(opts) {
  const { envDir, resourcesPath } = opts;

  // Fast path: environment already deployed and intact.
  if (isRuntimeIntact(envDir)) {
    return nodeExePath(envDir);
  }

  // No built-in resources to deploy from — caller must fall back.
  if (!resourcesPath) return null;

  const src = path.join(resourcesPath, 'dsh');
  if (!fs.existsSync(src)) {
    log.warn('[runtime-updater] built-in runtime not found at ' + src);
    return null;
  }

  log.info('[runtime-updater] deploying built-in runtime to ' + envDir);

  // Fresh deploy: remove any partial/stale directory first.
  try {
    fs.rmSync(envDir, { recursive: true, force: true });
  } catch (e) {
    log.warn('[runtime-updater] could not remove old runtime: ' + e.message);
  }
  fs.mkdirSync(envDir, { recursive: true });

  copyDirSync(src, envDir);

  // Write version marker.
  const pkgJson = path.join(envDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
    if (pkg.version) writeDeployedVersion(envDir, pkg.version);
  } catch {}

  // Final integrity check.
  if (!isRuntimeIntact(envDir)) {
    log.error('[runtime-updater] deploy completed but runtime is still incomplete');
    return null;
  }

  return nodeExePath(envDir);
}

// ---------------------------------------------------------------------------
// CLI shim
// ---------------------------------------------------------------------------

/**
 * Create the `dsh.cmd` shim inside the environment dir so the CLI works
 * from any terminal once the dir is on PATH.
 *
 * @param {string} envDir  environment root
 * @returns {string|null} shim path, or null on failure
 */
function installShim(envDir) {
  try {
    const shim = [
      '@ECHO off',
      '"%~dp0node.exe" "%~dp0node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*',
      '',
    ].join('\r\n');
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(shimPath(envDir), shim, 'utf-8');
    log.info('[runtime-updater] installed dsh.cmd shim at ' + shimPath(envDir));
    return shimPath(envDir);
  } catch (err) {
    log.warn('[runtime-updater] could not install dsh.cmd shim: ' + err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// user PATH management (Windows)
// ---------------------------------------------------------------------------

/**
 * Parse the raw output of `reg query HKCU\Environment /v Path` into the
 * current user Path value. Pure, testable.
 *
 * @param {string} regOut  raw reg query output
 * @returns {string} the Path value ('' if absent)
 */
function parseUserPath(regOut) {
  if (!regOut) return '';
  const m = String(regOut).match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

/**
 * Join path parts with ';', dropping empties. Pure, testable.
 * @param {string[]} parts
 * @returns {string}
 */
function formatUserPath(parts) {
  return parts.filter(Boolean).join(';');
}

function defaultReg(args) {
  return execFileSync('reg', args, { encoding: 'utf8', windowsHide: true });
}

/**
 * Append the environment dir to the user PATH (HKCU\Environment), stored as
 * REG_EXPAND_SZ so %USERPROFILE% keeps working if the profile moves.
 *
 * @param {string} envDir
 * @param {object} [opts]
 * @param {function} [opts.reg]  injectable reg runner for tests
 * @returns {boolean} true if the entry was added (or already present)
 */
function addEnvDirToPath(envDir, opts = {}) {
  if (process.platform !== 'win32') return false;
  const reg = opts.reg || defaultReg;
  const entry = pathEntry(envDir);

  try {
    let current = '';
    try {
      current = parseUserPath(reg(['query', 'HKCU\\Environment', '/v', 'Path']));
    } catch { /* key may not exist yet — treat as empty */ }

    const parts = current.split(';');
    if (parts.includes(entry)) return true; // already there

    parts.push(entry);
    const next = formatUserPath(parts);
    reg(['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', next, '/f']);
    log.info('[runtime-updater] added ' + entry + ' to user PATH');
    return true;
  } catch (err) {
    log.warn('[runtime-updater] could not add to PATH: ' + err.message);
    return false;
  }
}

/**
 * Remove the environment dir from the user PATH.
 *
 * @param {string} envDir
 * @param {object} [opts]
 * @param {function} [opts.reg]  injectable reg runner for tests
 * @returns {boolean} true if removed (or already absent)
 */
function removeEnvDirFromPath(envDir, opts = {}) {
  if (process.platform !== 'win32') return false;
  const reg = opts.reg || defaultReg;
  const entry = pathEntry(envDir);

  try {
    let current = '';
    try {
      current = parseUserPath(reg(['query', 'HKCU\\Environment', '/v', 'Path']));
    } catch { return true; } // nothing to remove

    const parts = current.split(';').filter((p) => p !== entry);
    const next = formatUserPath(parts);
    if (next === current) return true; // nothing changed

    if (next === '') {
      reg(['delete', 'HKCU\\Environment', '/v', 'Path', '/f']);
    } else {
      reg(['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', next, '/f']);
    }
    log.info('[runtime-updater] removed ' + entry + ' from user PATH');
    return true;
  } catch (err) {
    log.warn('[runtime-updater] could not remove from PATH: ' + err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// update checks
// ---------------------------------------------------------------------------

/**
 * Check npm registry for a newer @deepseek-ai/dsh version. If the user-level
 * environment is deployed AND a newer version is available, download and
 * replace the @deepseek-ai/dsh package (preserving node.exe + deps).
 *
 * @param {object} opts
 * @param {string} opts.envDir       environment root
 * @param {function} [opts.onProgress]  callback(status, detail)
 */
function checkForUpdates(opts) {
  const { envDir, onProgress } = opts;

  // Offline mode (Plugins edition): skip update check entirely.
  // The kernel + plugins are a locked set; auto-updating the kernel would
  // break compatibility with the bundled plugins.
  if (process.env.DSH_DESKTOP_OFFLINE === '1') {
    log.info('[runtime-updater] offline mode — skipping update check');
    if (onProgress) onProgress('skip', '离线模式，跳过更新检查');
    return;
  }

  setImmediate(async () => {
    try {
      const currentVer = readDeployedVersion(envDir);
      if (!currentVer) {
        if (onProgress) onProgress('skip', '未部署本地环境，跳过更新检查');
        return;
      }

      if (onProgress) onProgress('checking', '正在检查 DSH 版本更新…');

      const https = require('node:https');
      const pkgUrl = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest';
      const latestVer = await new Promise((resolve) => {
        https.get(pkgUrl, { timeout: 10000 }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(body).version); }
            catch { resolve(null); }
          });
        }).on('error', () => resolve(null))
          .on('timeout', function() { this.destroy(); resolve(null); });
      });

      if (!latestVer) {
        if (onProgress) onProgress('fail', '无法获取最新版本（网络不可用）');
        return;
      }

      const cmp = compareVersions(currentVer, latestVer);
      if (cmp >= 0) {
        if (onProgress) onProgress('uptodate', `当前版本 ${currentVer} 已是最新`);
        return;
      }

      log.info(`[runtime-updater] update available: ${currentVer} → ${latestVer}`);
      if (onProgress) onProgress('found', `发现新版本 ${latestVer}（当前 ${currentVer}）`);

      const tarballUrl = `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${latestVer}.tgz`;
      if (onProgress) onProgress('downloading', `正在下载 DSH ${latestVer}（~15MB）…`);

      const tarballBuffer = await new Promise((resolve, reject) => {
        https.get(tarballUrl, { timeout: 60000 }, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject)
          .on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
      });

      if (onProgress) onProgress('extracting', '正在解压更新…');

      try {
        await updateFromTarball(tarballBuffer, envDir, latestVer);
        if (onProgress) onProgress('done', `DSH 已更新至 ${latestVer}，下次启动生效`);
      } catch (updateErr) {
        log.error('[runtime-updater] update failed', updateErr);
        if (onProgress) onProgress('fail', `更新失败：${updateErr.message}`);
      }

    } catch (err) {
      log.warn('[runtime-updater] check failed: ' + err.message);
      if (onProgress) onProgress('fail', err.message);
    }
  });
}

/**
 * Compare two semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Replace the deployed @deepseek-ai/dsh package with a newly downloaded
 * version. The npm tarball contains only the package itself (no
 * node_modules); we preserve node.exe and every existing dependency and
 * only swap the @deepseek-ai/dsh files, so an interrupted or partial update
 * can never leave the runtime unstartable.
 *
 * Extraction uses the system `tar` (bsdtar, present on Windows 10 1803+ and
 * every POSIX system) so this module has zero runtime dependencies.
 *
 * @param {Buffer} tarballBuffer  downloaded .tgz
 * @param {string} envDir         environment root
 * @param {string} version        new version string
 */
async function updateFromTarball(tarballBuffer, envDir, version) {
  const tempDir = path.join(os.tmpdir(), `dsh-update-${Date.now()}`);

  try {
    // 1. Write the tarball to a temp file.
    const tgzFile = path.join(tempDir, 'dsh.tgz');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(tgzFile, tarballBuffer);

    // 2. Extract with system tar, stripping the npm `package/` prefix.
    const extractDir = path.join(tempDir, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });

    const tarCmd = process.platform === 'win32' ? 'tar.exe' : 'tar';
    await new Promise((resolve, reject) => {
      const { execFile } = require('node:child_process');
      execFile(tarCmd, ['-xzf', tgzFile, '-C', extractDir, '--strip-components=1'], {
        timeout: 120000,
        windowsHide: true,
      }, (err) => (err ? reject(err) : resolve()));
    });

    const newDshPkgDir = extractDir;
    if (!fs.existsSync(newDshPkgDir) || !fs.existsSync(path.join(newDshPkgDir, 'package.json'))) {
      throw new Error('tarball extraction did not produce the expected package directory');
    }

    // 3. Replace @deepseek-ai/dsh package files (keep its node_modules deps).
    const oldDshPkgDir = path.join(envDir, 'node_modules', '@deepseek-ai', 'dsh');
    if (fs.existsSync(oldDshPkgDir)) {
      const oldEntries = fs.readdirSync(oldDshPkgDir, { withFileTypes: true });
      for (const entry of oldEntries) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(oldDshPkgDir, entry.name);
        fs.rmSync(full, { recursive: true, force: true });
      }
    } else {
      fs.mkdirSync(oldDshPkgDir, { recursive: true });
    }

    // 4. Copy new files (excluding any node_modules inside the package).
    const newEntries = fs.readdirSync(newDshPkgDir, { withFileTypes: true });
    for (const entry of newEntries) {
      if (entry.name === 'node_modules') continue;
      const src = path.join(newDshPkgDir, entry.name);
      const dst = path.join(oldDshPkgDir, entry.name);
      if (entry.isDirectory()) {
        copyDirSync(src, dst);
      } else {
        fs.copyFileSync(src, dst);
      }
    }

    // 5. Update version marker.
    writeDeployedVersion(envDir, version);

    log.info(`[runtime-updater] updated to ${version}`);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  ensureRuntime,
  checkForUpdates,
  installShim,
  addEnvDirToPath,
  removeEnvDirFromPath,
  parseUserPath,
  formatUserPath,
  pathEntry,
  deployDir,
  readDeployedVersion,
  compareVersions,
};
