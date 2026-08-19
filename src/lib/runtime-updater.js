'use strict';

/**
 * Runtime updater — keeps the user-local dsh runtime up to date.
 *
 * On every launch we asynchronously check npm for a newer @deepseek-ai/dsh
 * version. If found, we download & extract it into the user data directory.
 * All of this happens in the background — it NEVER blocks app startup.
 *
 * Directory layout (under userData):
 *   runtime/
 *     dsh/                  ← the deploy target (copy of resources/dsh/ + updates)
 *       node.exe
 *       node_modules/@deepseek-ai/dsh/lib/bin.js
 *       .version            ← current version string
 *     .updating.lock        ← lock file to prevent concurrent updates
 *
 * Resolution priority (resolveDshCommand):
 *   1. $DSH_DESKTOP_DSH_BIN env var
 *   2. userData/runtime/dsh/      ← UPDATABLE copy
 *   3. resources/dsh/             ← built-in (read-only)
 *   4. system PATH dsh.cmd/dsh
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');

const log = require('electron-log/main');

const UPDATE_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh';
const PACKAGE_NAME = '@deepseek-ai/dsh';
const NPM_PACKAGE_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest';
// How often to check (in days) — we store last-check timestamp
const CHECK_INTERVAL_DAYS = 1;

/**
 * @param {string} userData  app.getPath('userData')
 * @returns {string}  path to the runtime directory
 */
function runtimeDir(userData) {
  return path.join(userData, 'runtime');
}

/**
 * @param {string} userData
 * @returns {string}  path to the deploy target dsh directory
 */
function deployDir(userData) {
  return path.join(runtimeDir(userData), 'dsh');
}

/**
 * @param {string} userData
 * @returns {string}  path to the version marker file
 */
function versionFile(userData) {
  return path.join(deployDir(userData), '.version');
}

/**
 * @param {string} userData
 * @returns {string}  path to the lock file
 */
function lockFile(userData) {
  return path.join(runtimeDir(userData), '.updating.lock');
}

/**
 * Read the current deployed version from .version file.
 * @param {string} userData
 * @returns {string|null}
 */
function readDeployedVersion(userData) {
  try {
    const vf = versionFile(userData);
    if (fs.existsSync(vf)) {
      return fs.readFileSync(vf, 'utf-8').trim();
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Write the deployed version to .version file.
 * @param {string} userData
 * @param {string} version
 */
function writeDeployedVersion(userData, version) {
  try {
    fs.mkdirSync(deployDir(userData), { recursive: true });
    fs.writeFileSync(versionFile(userData), version, 'utf-8');
  } catch (err) {
    log.warn(`[runtime-updater] failed to write version file: ${err.message}`);
  }
}

/**
 * Read the last-check timestamp from the runtime dir.
 * @param {string} userData
 * @returns {number}  epoch ms, or 0
 */
function readLastCheck(userData) {
  try {
    const f = path.join(runtimeDir(userData), '.last-check');
    if (fs.existsSync(f)) {
      return parseInt(fs.readFileSync(f, 'utf-8').trim(), 10) || 0;
    }
  } catch { /* ignore */ }
  return 0;
}

/**
 * Write the last-check timestamp.
 * @param {string} userData
 */
function writeLastCheck(userData) {
  try {
    fs.mkdirSync(runtimeDir(userData), { recursive: true });
    fs.writeFileSync(path.join(runtimeDir(userData), '.last-check'), String(Date.now()), 'utf-8');
  } catch { /* ignore */ }
}

/**
 * Fetch the latest version of @deepseek-ai/dsh from npm registry.
 * Returns null on failure.
 * @returns {Promise<string|null>}
 */
function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(NPM_PACKAGE_URL, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.version || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Deploy the built-in dsh runtime (from resources) to the user data directory.
 * This is a copy operation using Node.js streams (no extra tooling needed).
 * @param {string} userData
 * @param {string} resourcesPath  process.resourcesPath
 * @returns {boolean}  true if deployment succeeded
 */
function deployBuiltinRuntime(userData, resourcesPath) {
  const src = path.join(resourcesPath, 'dsh');
  const dest = deployDir(userData);
  try {
    if (!fs.existsSync(src)) return false;
    // Only copy if destination doesn't exist yet (avoid unnecessary I/O)
    if (fs.existsSync(path.join(dest, 'node.exe')) &&
        fs.existsSync(path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
      // Already deployed — but we might still need to write a version
      return true;
    }
    log.info('[runtime-updater] deploying built-in dsh runtime to user data…');
    copyDirSync(src, dest);
    // Read the version from the bundled package.json
    const pkgJson = path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    if (fs.existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
        if (pkg.version) writeDeployedVersion(userData, pkg.version);
      } catch { /* ignore */ }
    }
    return true;
  } catch (err) {
    log.warn(`[runtime-updater] deploy builtin runtime failed: ${err.message}`);
    return false;
  }
}

/**
 * Recursively copy a directory (files only, no symlinks).
 * @param {string} src
 * @param {string} dest
 */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else if (entry.isFile()) {
      // Skip if dest exists and is same size (optimization)
      try {
        const st = fs.statSync(s);
        try {
          const dt = fs.statSync(d);
          if (dt.size === st.size && dt.mtimeMs >= st.mtimeMs) continue;
        } catch { /* dest doesn't exist, copy */ }
        fs.copyFileSync(s, d);
      } catch (err) {
        log.warn(`[runtime-updater] copy error ${s}: ${err.message}`);
      }
    }
  }
}

/**
 * Try to acquire the update lock.
 * @param {string} userData
 * @returns {boolean}
 */
function acquireLock(userData) {
  try {
    const lf = lockFile(userData);
    fs.mkdirSync(path.dirname(lf), { recursive: true });
    // If lock file exists and is older than 30 min, assume stale
    try {
      const stat = fs.statSync(lf);
      if (Date.now() - stat.mtimeMs < 30 * 60 * 1000) {
        return false; // Another process is updating
      }
      // Stale lock — remove it
      fs.unlinkSync(lf);
    } catch { /* no lock file */ }
    fs.writeFileSync(lf, String(process.pid), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Release the update lock.
 * @param {string} userData
 */
function releaseLock(userData) {
  try {
    fs.unlinkSync(lockFile(userData));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the user-local runtime exists (deploy built-in if needed).
 * To be called once at startup before spawning dsh.
 *
 * Every time this runs, we re-deploy from the built-in resources to ensure
 * the runtime is always consistent with what was shipped in the installer.
 * (The old background auto-update that only patched the dsh package without
 *  its dependency tree caused ERR_MODULE_NOT_FOUND crashes — see commit
 *  2504fb4.)
 *
 * @param {object} opts
 * @param {string} opts.userData  app.getPath('userData')
 * @param {string} [opts.resourcesPath]  process.resourcesPath (packaged)
 * @returns {string|null}  path to the deployed runtime node.exe, or null
 */
function ensureRuntime(opts) {
  const { userData, resourcesPath } = opts;
  const dest = deployDir(userData);
  const nodeExe = path.join(dest, 'node.exe');
  const dshBin = path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

  // If there's a version marker and commander is present, the runtime is
  // intact — skip re-deploy to save startup time.
  if (fs.existsSync(nodeExe) && fs.existsSync(dshBin)) {
    const hasVersion = fs.existsSync(versionFile(userData));
    const hasCommander = fs.existsSync(
      path.join(dest, 'node_modules', 'commander', 'package.json'),
    );
    if (hasVersion && hasCommander) {
      return nodeExe;
    }
  }

  // Deploy from built-in resources (fresh copy).
  if (resourcesPath) {
    log.info('[runtime-updater] deploying built-in dsh runtime to user data…');
    // Remove any partial/stale runtime first
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
    const ok = deployBuiltinRuntime(userData, resourcesPath);
    if (ok && fs.existsSync(nodeExe) && fs.existsSync(dshBin)) {
      // Write version marker
      const pkgJson = path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
        if (pkg.version) writeDeployedVersion(userData, pkg.version);
      } catch {}
      return nodeExe;
    }
  }

  return null;
}

/**
 * Check for updates in the background. Never throws. Never blocks.
 * Logs whether a newer version is available — but does NOT auto-update,
 * because the npm package only ships @deepseek-ai/dsh itself without its
 * full dependency tree, and a partial replacement causes ERR_MODULE_NOT_FOUND.
 *
 * @param {object} opts
 * @param {string} opts.userData  app.getPath('userData')
 */
function checkForUpdates(opts) {
  const { userData } = opts;

  const lastCheck = readLastCheck(userData);
  if (lastCheck > 0 && (Date.now() - lastCheck) < CHECK_INTERVAL_DAYS * 24 * 60 * 60 * 1000) {
    return;
  }
  writeLastCheck(userData);

  setImmediate(async () => {
    try {
      const currentVer = readDeployedVersion(userData) || '(bundled)';
      const latestVer = await fetchLatestVersion();
      if (latestVer) {
        log.info(`[runtime-updater] current=${currentVer} latest=${latestVer}${latestVer !== currentVer ? ' (update available — manual reinstall required)' : ' (up to date)'}`);
      }
    } catch (err) {
      log.warn(`[runtime-updater] check failed: ${err.message}`);
    }
  });
}

/**
 * Download the npm tarball for @deepseek-ai/dsh and extract to deploy directory.
 * @param {string} userData
 * @param {string} version
 * @returns {Promise<boolean>}
 */
function downloadAndExtract(userData, version) {
  return new Promise((resolve) => {
    const tgzUrl = `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`;
    const dest = deployDir(userData);
    const tmpDir = path.join(runtimeDir(userData), `.update-${version}`);

    // Clean any stale tmp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

    log.info(`[runtime-updater] downloading ${tgzUrl}`);

    https.get(tgzUrl, { timeout: 60_000 }, (res) => {
      if (res.statusCode !== 200) {
        log.warn(`[runtime-updater] download got HTTP ${res.statusCode}`);
        res.resume();
        resolve(false);
        return;
      }

      // Save to a temp tgz file, then extract
      const tmpTgz = path.join(runtimeDir(userData), `.update-${version}.tgz`);
      const fileStream = fs.createWriteStream(tmpTgz);
      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();

        // Extract the tgz — it's a standard gzip tarball.
        // We extract only the "package/" prefix contents into the tmp dir,
        // then merge into the deploy dir.
        extractTgz(tmpTgz, tmpDir, version)
          .then((ok) => {
            try { fs.unlinkSync(tmpTgz); } catch { /* ignore */ }
            if (!ok) {
              try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
              resolve(false);
              return;
            }

            // Merge tmpDir/package/ → dest/
            const srcPkg = path.join(tmpDir, 'package');
            if (fs.existsSync(srcPkg)) {
              // First, we need to also have node.exe in the deploy dir.
              // The npm tarball only contains the dsh package, NOT node.exe.
              // We need to copy node.exe from the existing deployment or resources.
              // For now, keep the existing node.exe and just update the dsh package.
              // Remove the old @deepseek-ai/dsh directory
              const oldDsh = path.join(dest, 'node_modules', '@deepseek-ai', 'dsh');
              try { fs.rmSync(oldDsh, { recursive: true, force: true }); } catch { /* ignore */ }

              // Copy new package contents
              copyDirSync(srcPkg, path.join(dest, 'node_modules', '@deepseek-ai', 'dsh'));

              // Also ensure node.exe exists in dest
              // If missing, it means the initial deploy didn't happen — mark as failed
              const nodeExe = path.join(dest, 'node.exe');
              if (!fs.existsSync(nodeExe)) {
                log.warn('[runtime-updater] node.exe missing in deploy dir, update incomplete');
                try { fs.rmSync(oldDsh, { recursive: true, force: true }); } catch { /* ignore */ }
                resolve(false);
                return;
              }

              try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
              resolve(true);
            } else {
              log.warn('[runtime-updater] extracted tarball has no package/ directory');
              try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
              resolve(false);
            }
          })
          .catch((err) => {
            log.warn(`[runtime-updater] extract error: ${err.message}`);
            try { fs.unlinkSync(tmpTgz); } catch { /* ignore */ }
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
            resolve(false);
          });
      });

      fileStream.on('error', (err) => {
        log.warn(`[runtime-updater] file write error: ${err.message}`);
        resolve(false);
      });
    }).on('error', (err) => {
      log.warn(`[runtime-updater] download error: ${err.message}`);
      resolve(false);
    }).on('timeout', function() {
      this.destroy();
      log.warn('[runtime-updater] download timeout');
      resolve(false);
    });
  });
}

/**
 * Extract a .tgz file to a directory using Node.js built-in zlib + tar.
 * Falls back to using node.exe 7za if available.
 * @param {string} tgzPath
 * @param {string} destDir
 * @param {string} version  (for logging)
 * @returns {Promise<boolean>}
 */
function extractTgz(tgzPath, destDir, version) {
  return new Promise((resolve) => {
    fs.mkdirSync(destDir, { recursive: true });

    // Use node's built-in zlib + tar via child_process node -e
    // because native zlib doesn't handle tar extraction easily.
    // We spawn a small Node.js script.
    const script = `
      const zlib = require('zlib');
      const tar = require('tar-stream');
      const fs = require('fs');
      const path = require('path');
      const extract = tar.extract();
      const dest = ${JSON.stringify(destDir)};
      extract.on('entry', (header, stream, next) => {
        const fpath = path.join(dest, header.name);
        if (header.type === 'directory') {
          fs.mkdirSync(fpath, { recursive: true });
          stream.resume();
          next();
        } else {
          fs.mkdirSync(path.dirname(fpath), { recursive: true });
          const ws = fs.createWriteStream(fpath);
          stream.pipe(ws);
          ws.on('finish', next);
        }
      });
      extract.on('finish', () => process.exit(0));
      extract.on('error', () => process.exit(1));
      fs.createReadStream(${JSON.stringify(tgzPath)}).pipe(zlib.createGunzip()).pipe(extract);
    `;

    const child = spawn(process.execPath, ['-e', script], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 30_000,
    });

    child.on('exit', (code) => {
      resolve(code === 0);
    });
    child.on('error', () => {
      resolve(false);
    });
  });
}

module.exports = {
  ensureRuntime,
  checkForUpdates,
  deployDir,
  readDeployedVersion,
};
