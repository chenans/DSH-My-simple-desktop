'use strict';

/**
 * Plugin layer deployer — deploys the bundled plugin snapshot to ~/.dsh
 * on first launch of the Plugins edition.
 *
 * Design goals:
 *   • Idempotent: a marker file (~/.dsh/.dsd-plugin-snapshot.json) records
 *     the deployed snapshot sha. If it matches the bundled manifest, skip.
 *   • Non-destructive: never overwrites user-installed plugins, presets,
 *     sessions, or settings. Only adds files that don't exist.
 *   • Web-profile-aligned: plugins are deployed to
 *     ~/.dsh/profiles/web/node_modules (where dsh's web profile resolves
 *     bundles), NOT profiles/node_modules (the shared tree).
 *     package.json (with dsh.profile.bundles) is non-destructively merged
 *     into ~/.dsh/profiles/web/package.json so dsh can discover the plugins.
 *   • Failure-tolerant: deployment failure is logged but does not block
 *     app startup. The bundled runtime still launches dsh bare.
 *
 * The marker file format:
 *   {
 *     "snapshotSha": "<sha256>",
 *     "deployedAt": "<ISO timestamp>",
 *     "dshVersion": "<version>"
 *   }
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const log = require('electron-log/main');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function markerPath(dshHome) {
  return path.join(dshHome, '.dsd-plugin-snapshot.json');
}

function bundledManifestPath(resourcesPath) {
  return path.join(resourcesPath, 'plugins', 'manifest.json');
}

function bundledPluginsRoot(resourcesPath) {
  return path.join(resourcesPath, 'plugins');
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Check if the app is running in Plugins edition mode.
 * Detection: resources/plugins/manifest.json exists.
 *
 * @param {string|null} resourcesPath  process.resourcesPath (packaged) or null
 * @returns {boolean}
 */
function isPluginsEdition(resourcesPath) {
  if (!resourcesPath) return false;
  return fs.existsSync(bundledManifestPath(resourcesPath));
}

/**
 * Read the bundled manifest.json.
 * @returns {object|null}
 */
function readBundledManifest(resourcesPath) {
  try {
    const p = bundledManifestPath(resourcesPath);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    log.warn('[plugin-deployer] could not read bundled manifest: ' + err.message);
    return null;
  }
}

/**
 * Read the deployed marker file.
 * @returns {object|null}
 */
function readDeployedMarker(dshHome) {
  try {
    const p = markerPath(dshHome);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write the deployed marker file.
 */
function writeDeployedMarker(dshHome, manifest) {
  try {
    const marker = {
      snapshotSha: manifest.snapshotSha,
      deployedAt: new Date().toISOString(),
      dshVersion: manifest.dshVersion,
    };
    fs.writeFileSync(markerPath(dshHome), JSON.stringify(marker, null, 2), 'utf-8');
    log.info('[plugin-deployer] marker written: ' + markerPath(dshHome));
  } catch (err) {
    log.warn('[plugin-deployer] could not write marker: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

/**
 * Copy a file only if the destination does not exist (non-destructive).
 * @returns {boolean} true if copied, false if skipped (already exists)
 */
function copyIfAbsent(src, dest) {
  if (fs.existsSync(dest)) return false;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  } catch (err) {
    log.warn('[plugin-deployer] copy failed ' + src + ' → ' + dest + ': ' + err.message);
    return false;
  }
}

/**
 * Copy a directory tree recursively, only adding files that don't exist.
 * Never overwrites existing files (user modifications preserved).
 *
 * @returns {{copied: number, skipped: number}}
 */
function copyDirIfAbsent(src, dest) {
  let copied = 0;
  let skipped = 0;
  if (!fs.existsSync(src)) return { copied, skipped };

  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      const r = copyDirIfAbsent(s, d);
      copied += r.copied;
      skipped += r.skipped;
    } else if (entry.isFile()) {
      if (copyIfAbsent(s, d)) {
        copied++;
      } else {
        skipped++;
      }
    }
  }
  return { copied, skipped };
}

// ---------------------------------------------------------------------------
// package.json non-destructive merge
// ---------------------------------------------------------------------------

/**
 * Non-destructively merge the bundled package.json into the user's
 * ~/.dsh/profiles/web/package.json.
 *
 * Strategy:
 *   - If the user's package.json doesn't exist → copy the bundled one.
 *   - If it exists → merge dsh.profile.bundles: only add bundle entries
 *     that the user doesn't already have. Never remove user's entries.
 *   - Other fields (name, version, dependencies, etc.) are preserved
 *     from the user's file; only dsh.profile.bundles is merged.
 *
 * @param {string} srcPkgJson   bundled package.json path
 * @param {string} destPkgJson  user's package.json path
 * @returns {boolean} true if written/updated, false if skipped
 */
function mergePackageJson(srcPkgJson, destPkgJson) {
  try {
    const srcContent = fs.readFileSync(srcPkgJson, 'utf-8');
    const srcPkg = JSON.parse(srcContent);

    if (!fs.existsSync(destPkgJson)) {
      // User doesn't have a package.json — copy the bundled one
      fs.mkdirSync(path.dirname(destPkgJson), { recursive: true });
      fs.copyFileSync(srcPkgJson, destPkgJson);
      log.info('[plugin-deployer] deployed package.json (new file)');
      return true;
    }

    // User already has package.json — merge dsh.profile.bundles
    const destContent = fs.readFileSync(destPkgJson, 'utf-8');
    const destPkg = JSON.parse(destContent);

    const srcBundles = (srcPkg.dsh && srcPkg.dsh.profile && srcPkg.dsh.profile.bundles) || [];
    if (srcBundles.length === 0) {
      log.info('[plugin-deployer] bundled package.json has no dsh.profile.bundles, skipping merge');
      return false;
    }

    const destBundles = (destPkg.dsh && destPkg.dsh.profile && destPkg.dsh.profile.bundles) || [];
    const destSet = new Set(destBundles);
    let added = 0;
    for (const bundle of srcBundles) {
      if (!destSet.has(bundle)) {
        destBundles.push(bundle);
        added++;
      }
    }

    if (added === 0) {
      log.info('[plugin-deployer] package.json bundles already complete, no merge needed');
      return false;
    }

    // Ensure dsh.profile.bundles exists in dest
    if (!destPkg.dsh) destPkg.dsh = {};
    if (!destPkg.dsh.profile) destPkg.dsh.profile = {};
    destPkg.dsh.profile.bundles = destBundles;

    fs.writeFileSync(destPkgJson, JSON.stringify(destPkg, null, 2), 'utf-8');
    log.info(`[plugin-deployer] merged ${added} bundle(s) into package.json`);
    return true;
  } catch (err) {
    log.warn('[plugin-deployer] package.json merge failed: ' + err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

/**
 * Deploy the bundled plugin snapshot to ~/.dsh.
 *
 *   Steps:
 *   1. Check marker — if snapshotSha matches, skip (idempotent).
 *   2. Copy cordis.yml → ~/.dsh/profiles/web/cordis.yml (if absent).
 *   3. Merge package.json → ~/.dsh/profiles/web/package.json (non-destructive:
 *      only add dsh.profile.bundles entries that don't already exist).
 *   4. Copy incremental plugin node_modules → ~/.dsh/profiles/web/node_modules/
 *      (non-destructive: only add missing packages).
 *   5. Copy agent-presets → ~/.dsh/.agent-presets/ (if absent).
 *   6. Write marker file.
 *
 * @param {object} opts
 * @param {string} opts.dshHome        ~/.dsh
 * @param {string} opts.resourcesPath  process.resourcesPath
 * @param {object} [opts.log]          logger (defaults to electron-log)
 * @returns {Promise<{deployed: boolean, reason: string, copied: number, skipped: number}>}
 */
async function deployPluginLayer(opts) {
  const { dshHome, resourcesPath } = opts;
  const logger = opts.log || log;

  const manifest = readBundledManifest(resourcesPath);
  if (!manifest) {
    return { deployed: false, reason: 'no bundled manifest', copied: 0, skipped: 0 };
  }

  // --- Check marker (idempotency) ---
  const marker = readDeployedMarker(dshHome);
  if (marker && marker.snapshotSha === manifest.snapshotSha) {
    logger.info('[plugin-deployer] snapshot already deployed (sha matches), skipping');
    return { deployed: false, reason: 'already deployed', copied: 0, skipped: 0 };
  }

  logger.info('[plugin-deployer] deploying plugin snapshot to ' + dshHome);
  logger.info('[plugin-deployer] snapshot sha: ' + manifest.snapshotSha);
  logger.info('[plugin-deployer] dsh version: ' + manifest.dshVersion);
  logger.info('[plugin-deployer] plugins: ' + (manifest.plugins || []).length);
  logger.info('[plugin-deployer] presets: ' + (manifest.presets || []).length);

  const bundledRoot = bundledPluginsRoot(resourcesPath);
  let totalCopied = 0;
  let totalSkipped = 0;

  try {
    // --- 1. Copy cordis.yml ---
    const cordisSrc = path.join(bundledRoot, 'cordis.yml');
    const cordisDest = path.join(dshHome, 'profiles', 'web', 'cordis.yml');
    if (fs.existsSync(cordisSrc)) {
      if (copyIfAbsent(cordisSrc, cordisDest)) {
        totalCopied++;
        logger.info('[plugin-deployer] deployed cordis.yml');
      } else {
        totalSkipped++;
        logger.info('[plugin-deployer] cordis.yml already exists, preserved');
      }
    }

    // --- 2. Merge package.json (dsh.profile.bundles) ---
    const pkgJsonSrc = path.join(bundledRoot, 'package.json');
    const pkgJsonDest = path.join(dshHome, 'profiles', 'web', 'package.json');
    if (fs.existsSync(pkgJsonSrc)) {
      if (mergePackageJson(pkgJsonSrc, pkgJsonDest)) {
        totalCopied++;
      } else {
        totalSkipped++;
      }
    }

    // --- 3. Copy incremental plugin node_modules ---
    // Bug fix: deploy to profiles/web/node_modules (where dsh's web profile
    // resolves bundles), NOT profiles/node_modules (the shared tree).
    const srcNm = path.join(bundledRoot, 'node_modules');
    const destNm = path.join(dshHome, 'profiles', 'web', 'node_modules');
    if (fs.existsSync(srcNm)) {
      // Ensure profiles/web/node_modules exists
      fs.mkdirSync(destNm, { recursive: true });

      // Copy each package non-destructively
      for (const entry of fs.readdirSync(srcNm, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const s = path.join(srcNm, entry.name);
        const d = path.join(destNm, entry.name);

        if (entry.isDirectory()) {
          // For scoped dirs (@scope), copy each child package
          if (entry.name.startsWith('@')) {
            fs.mkdirSync(d, { recursive: true });
            for (const sub of fs.readdirSync(s, { withFileTypes: true })) {
              if (!sub.isDirectory()) continue;
              const r = copyDirIfAbsent(
                path.join(s, sub.name),
                path.join(d, sub.name),
              );
              totalCopied += r.copied;
              totalSkipped += r.skipped;
            }
          } else {
            const r = copyDirIfAbsent(s, d);
            totalCopied += r.copied;
            totalSkipped += r.skipped;
          }
        }
      }
      logger.info('[plugin-deployer] plugin node_modules deployed to profiles/web/node_modules ' +
        `(copied=${totalCopied}, skipped=${totalSkipped})`);
    }

    // --- 4. Copy agent-presets ---
    const srcPresets = path.join(bundledRoot, 'agent-presets');
    const destPresets = path.join(dshHome, '.agent-presets');
    if (fs.existsSync(srcPresets)) {
      fs.mkdirSync(destPresets, { recursive: true });
      for (const entry of fs.readdirSync(srcPresets, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const r = copyDirIfAbsent(
          path.join(srcPresets, entry.name),
          path.join(destPresets, entry.name),
        );
        totalCopied += r.copied;
        totalSkipped += r.skipped;
      }
      logger.info('[plugin-deployer] agent-presets deployed');
    }

    // --- 4. Write marker ---
    writeDeployedMarker(dshHome, manifest);

    logger.info('[plugin-deployer] deployment complete ' +
      `(total copied=${totalCopied}, skipped=${totalSkipped})`);

    return {
      deployed: true,
      reason: 'success',
      copied: totalCopied,
      skipped: totalSkipped,
    };
  } catch (err) {
    logger.error('[plugin-deployer] deployment failed: ' + err.message);
    // Do NOT write marker on failure — so next launch retries
    return {
      deployed: false,
      reason: 'error: ' + err.message,
      copied: totalCopied,
      skipped: totalSkipped,
    };
  }
}

module.exports = {
  isPluginsEdition,
  deployPluginLayer,
  readBundledManifest,
  readDeployedMarker,
  writeDeployedMarker,
  markerPath,
  bundledManifestPath,
  bundledPluginsRoot,
  copyIfAbsent,
  copyDirIfAbsent,
};
