'use strict';

/**
 * Runtime updater — ensures the user-local dsh runtime is consistent.
 *
 * Directory layout (under userData):
 *   runtime/
 *     dsh/                  ← deploy target (copy of resources/dsh/)
 *       node.exe
 *       node_modules/@deepseek-ai/dsh/lib/bin.js
 *       .version            ← bundled @deepseek-ai/dsh version string
 *
 * On every launch we verify integrity. If the runtime is intact we skip IO;
 * if missing or incomplete we re-deploy from the built-in resources.
 *
 * Resolution priority (resolveDshCommand):
 *   1. $DSH_DESKTOP_DSH_BIN env var
 *   2. userData/runtime/dsh/      ← deploy target
 *   3. resources/dsh/             ← built-in (read-only, shipped in installer)
 *   4. system PATH dsh.cmd/dsh
 */

const fs = require('node:fs');
const path = require('node:path');
const log = require('electron-log/main');

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

function runtimeDir(userData) {
  return path.join(userData, 'runtime');
}

function deployDir(userData) {
  return path.join(runtimeDir(userData), 'dsh');
}

function versionFile(userData) {
  return path.join(deployDir(userData), '.version');
}

function nodeExePath(userData) {
  return path.join(deployDir(userData), 'node.exe');
}

function dshBinPath(userData) {
  return path.join(deployDir(userData), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function commanderPath(userData) {
  return path.join(deployDir(userData), 'node_modules', 'commander', 'package.json');
}

// ---------------------------------------------------------------------------
// integrity check
// ---------------------------------------------------------------------------

function isRuntimeIntact(userData) {
  return (
    fs.existsSync(nodeExePath(userData)) &&
    fs.existsSync(dshBinPath(userData)) &&
    fs.existsSync(versionFile(userData)) &&
    fs.existsSync(commanderPath(userData))
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

function readDeployedVersion(userData) {
  try {
    const vf = versionFile(userData);
    if (fs.existsSync(vf)) return fs.readFileSync(vf, 'utf-8').trim();
  } catch { /* ignore */ }
  return null;
}

function writeDeployedVersion(userData, version) {
  try {
    fs.mkdirSync(deployDir(userData), { recursive: true });
    fs.writeFileSync(versionFile(userData), version, 'utf-8');
  } catch (err) {
    log.warn('[runtime-updater] failed to write version file: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the user-local runtime exists and is intact.
 * If missing or incomplete, deploy from built-in resources (shipped in installer).
 *
 * @param {object} opts
 * @param {string} opts.userData        app.getPath('userData')
 * @param {string} [opts.resourcesPath] process.resourcesPath (packaged app)
 * @returns {string|null} path to deployed node.exe, or null
 */
function ensureRuntime(opts) {
  const { userData, resourcesPath } = opts;

  // Fast path: runtime already deployed and intact — nothing to do.
  if (isRuntimeIntact(userData)) {
    return nodeExePath(userData);
  }

  // No built-in resources to deploy from — caller must fall back.
  if (!resourcesPath) return null;

  const src = path.join(resourcesPath, 'dsh');
  if (!fs.existsSync(src)) {
    log.warn('[runtime-updater] built-in runtime not found at ' + src);
    return null;
  }

  log.info('[runtime-updater] deploying built-in runtime to user data…');

  // Fresh deploy: remove any partial/stale directory first.
  const dest = deployDir(userData);
  try {
    fs.rmSync(dest, { recursive: true, force: true });
  } catch (e) {
    log.warn('[runtime-updater] could not remove old runtime: ' + e.message);
  }
  fs.mkdirSync(deployDir(userData), { recursive: true });

  copyDirSync(src, dest);

  // Write version marker.
  const pkgJson = path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
    if (pkg.version) writeDeployedVersion(userData, pkg.version);
  } catch {}

  // Final integrity check.
  if (!isRuntimeIntact(userData)) {
    log.error('[runtime-updater] deploy completed but runtime is still incomplete');
    return null;
  }

  return nodeExePath(userData);
}

/**
 * Background check: logs whether a newer @deepseek-ai/dsh is on npm.
 * NEVER replaces the runtime (npm tarball lacks full dependency tree).
 *
 * @param {object} opts
 * @param {string} opts.userData  app.getPath('userData')
 */
function checkForUpdates(opts) {
  const { userData } = opts;

  setImmediate(async () => {
    try {
      const currentVer = readDeployedVersion(userData) || '(bundled)';
      const https = require('node:https');
      const pkgUrl = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest';
      const latestVer = await new Promise((resolve) => {
        https.get(pkgUrl, { timeout: 8000 }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(body).version); }
            catch { resolve(null); }
          });
        }).on('error', () => resolve(null))
          .on('timeout', function() { this.destroy(); resolve(null); });
      });
      if (latestVer) {
        const msg = currentVer === latestVer
          ? 'up to date (' + latestVer + ')'
          : 'update available: ' + latestVer + ' (current: ' + currentVer + ' — reinstall desktop to update)';
        log.info('[runtime-updater] ' + msg);
      }
    } catch (err) {
      log.warn('[runtime-updater] check failed: ' + err.message);
    }
  });
}

module.exports = {
  ensureRuntime,
  checkForUpdates,
  deployDir,
  readDeployedVersion,
};
