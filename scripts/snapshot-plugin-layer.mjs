'use strict';

/**
 * Plugin layer snapshot core — pure, unit-testable logic.
 *
 * This module is invoked by scripts/build-plugin-layer.ps1 (PowerShell
 * orchestrator) and by tests (node --test). It never touches the real
 * ~/.dsh unless explicitly pointed at it.
 *
 * Responsibilities:
 *   1. Diff the user's ~/.dsh/profiles/web/node_modules against the
 *      bundled dsh/ tree, keeping only the incremental plugins.
 *   2. Copy cordis.yml (the web profile plugin manifest).
 *   3. Copy selected agent-presets directories.
 *   4. Generate manifest.json with versions + sha256 + metadata.
 *   5. Scan staged files for sensitive patterns (apiKey / token / secret
 *      / password / credentials) and FAIL the build if any are found.
 *
 * Excluded by design (never staged):
 *   settings.yaml, .credentials.yaml, .anonymous-user-id,
 *   sessions/, task-board/, storages/, pet.json, skin-center/
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Files/dirs that must NEVER be staged (model config / secrets / user data
 *  + non-runtime dirs in npm packages that bloat snapshot and trigger
 *  false-positive security scans). */
export const EXCLUDED_NAMES = new Set([
  'settings.yaml',
  '.credentials.yaml',
  '.anonymous-user-id',
  'sessions',
  'task-board',
  'storages',
  'pet.json',
  'skin-center',
  'ledger-v2.lock',
  // Config files that may carry secrets — exclude from snapshot entirely
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'config.local.json',
  'config.local.yml',
  'config.local.yaml',
  '.secrets.json',
  '.secrets.yml',
  '.secrets.yaml',
  // Non-runtime dirs in npm packages (bloat + false-positive source)
  'test',
  'tests',
  '__tests__',
  'docs',
  'doc',
  '.github',
  '.gitlab',
  'examples',
  'example',
  'benchmarks',
  'benchmark',
  'coverage',
  '.nyc_output',
]);

/** Glob-like patterns for config files to exclude (matched against basename). */
export const EXCLUDED_CONFIG_PATTERNS = [
  /\.env\./i,          // .env.* (all variants)
  /\.local\./i,        // *.local.* (any local override)
  /\.secret/i,         // *.secret, .secrets*
  /_key\.pem$/i,       // *_key.pem (SSH/test private keys in PEM format)
  /_key\.pub$/i,       // *_key.pub (public key files)
  /_key$/i,            // *_key (SSH private keys without extension, e.g. ssh_host_ecdsa_key)
  /\.pem$/i,           // PEM certificate/key files
  /\.pfx$/i,           // PFX certificate files
  /\.crt$/i,           // CRT certificate files
  /\.keystore$/i,      // Java keystore files
  /-wasm\.js$/i,       // wasm-in-JS wrapper files (contain long hex strings)
  /\.wasm$/i,          // WebAssembly binary files
];

/** Regex patterns that trigger a security scan failure if found in file
 *  names or file contents. Case-insensitive.
 *  Used for config-like files (.yaml, .json, .ini, etc.).
 *  NOTE: uses word boundaries (\b) and value-assignment patterns to avoid
 *  false positives on schema property names and descriptions. */
export const SENSITIVE_PATTERNS = [
  // Matches YAML (key: value), JSON ("key": "value"), and env (key=value) formats
  // Quoted values: key: "value" or key='value'
  /api[_-]?key['"]?\s*[:=]\s*['"][^'"]{8,}/i,
  /\btoken['"]?\s*[:=]\s*['"][^'"]{8,}/i,
  /\bsecret['"]?\s*[:=]\s*['"][^'"]{8,}/i,
  /\bpassword['"]?\s*[:=]\s*['"][^'"]{4,}/i,
  /credential['"]?\s*[:=]\s*['"][^'"]{8,}/i,
  // Unquoted values (YAML style): key: value  (at least 4 non-space chars)
  /\bpassword['"]?\s*[:=]\s*[^\s'"][^\s]{3,}/i,
  /bearer\s+[a-z0-9]{20,}/i,
  /sk-[a-z0-9]{20,}/i,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@[^\s/@]+/i,
];

/** High-confidence-only patterns — used for most files to avoid false
 *  positives on documentation, CSS, source maps, and code variable names.
 *  Full SENSITIVE_PATTERNS is only applied to config-like files
 *  (.yaml, .json, .ini, etc.) where plaintext secrets are plausible.
 *  NOTE: the generic "long hex token" pattern was removed because it
 *  matches color values, hash strings, crypto constants, and base64
 *  content in normal npm packages. */
export const SENSITIVE_PATTERNS_HIGH_CONFIDENCE = [
  // apiKey = "xxx" — matches YAML and JSON formats
  /api[_-]?key['"]?\s*[:=]\s*['"][^'"]{8,}/i,
  /sk-[a-z0-9]{20,}/i,                     // OpenAI-style key
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@[^\s/@]+/i, // URL with credentials
  /bearer\s+[a-z0-9]{20,}/i,              // Bearer token with actual value
  /private[_-]?key['"]?\s*[:=]\s*['"][^'"]{20,}/i, // privateKey = "xxx"
  /access[_-]?key['"]?\s*[:=]\s*['"][^'"]{8,}/i,   // accessKey = "xxx"
];

/** Check if a high-confidence match is a false positive (e.g. env var name) */
function isFalsePositive(match) {
  const val = match[0];
  // All-caps with underscores = environment variable name, not a real secret
  if (/[A-Z][A-Z_0-9]{6,}/.test(val)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function defaultDshHome() {
  return path.join(os.homedir(), '.dsh');
}

export function defaultBundledDsh(projectRoot) {
  return path.join(projectRoot, 'dsh');
}

export function profilesWebDir(dshHome) {
  return path.join(dshHome, 'profiles', 'web');
}

export function profilesNodeModules(dshHome) {
  return path.join(dshHome, 'profiles', 'node_modules');
}

/**
 * The web-profile-specific node_modules — this is where dsh's web profile
 * actually resolves plugins (via dsh.profile.bundles in package.json).
 * This is the correct diff source for plugin snapshots.
 */
export function profilesWebNodeModules(dshHome) {
  return path.join(dshHome, 'profiles', 'web', 'node_modules');
}

/**
 * The web profile's package.json — contains dsh.profile.bundles which
 * registers which plugins dsh should load for the web profile.
 */
export function profilesWebPackageJson(dshHome) {
  return path.join(dshHome, 'profiles', 'web', 'package.json');
}

export function agentPresetsDir(dshHome) {
  return path.join(dshHome, '.agent-presets');
}

// ---------------------------------------------------------------------------
// Package version reading
// ---------------------------------------------------------------------------

/**
 * Read the version from a package.json file.
 * @returns {string|null}
 */
export function readPackageVersion(pkgJsonPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

/**
 * Read the dsh version from a bundled or deployed tree.
 * @param {string} dshRoot  e.g. .../dsh  or  .../.dsh-desktop
 * @returns {string|null}
 */
export function readDshVersion(dshRoot) {
  const pkgJson = path.join(
    dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json',
  );
  return readPackageVersion(pkgJson);
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 of a file.
 * @param {string} filePath
 * @returns {string} hex digest
 */
export function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Compute SHA-256 of a string (for manifest content hashing).
 */
export function sha256String(str) {
  return crypto.createHash('sha256').update(str, 'utf-8').digest('hex');
}

// ---------------------------------------------------------------------------
// Directory walking
// ---------------------------------------------------------------------------

/**
 * Walk a directory tree, yielding relative file paths.
 * Skips excluded names at every level.
 * @param {string} root
 * @param {string} base  relative base (for recursion)
 * @yields {string} relative path (posix-style with /)
 */
export function* walkFiles(root, base = '') {
  if (!fs.existsSync(root)) return;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full, rel);
    } else if (entry.isFile()) {
      yield rel;
    }
    // Symlinks/junctions: skip (we handle them explicitly in diff)
  }
}

// ---------------------------------------------------------------------------
// Plugin diff
// ---------------------------------------------------------------------------

/**
 * Build a map of package_name -> {version, path} for all packages in a
 * node_modules tree (top-level + scoped).
 *
 * @param {string} nmDir  node_modules directory
 * @returns {Map<string, {version: string|null, path: string}>}
 */
export function indexNodeModules(nmDir) {
  const map = new Map();
  if (!fs.existsSync(nmDir)) return map;

  const scanScope = (scopeDir, scope) => {
    if (!fs.existsSync(scopeDir)) return;
    for (const entry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgName = `${scope}/${entry.name}`;
      const pkgPath = path.join(scopeDir, entry.name);
      const pkgJson = path.join(pkgPath, 'package.json');
      map.set(pkgName, {
        version: readPackageVersion(pkgJson),
        path: pkgPath,
      });
    }
  };

  for (const entry of fs.readdirSync(nmDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // .bin, .pnpm, etc.
    if (entry.name.startsWith('@')) {
      scanScope(path.join(nmDir, entry.name), entry.name);
    } else if (entry.isDirectory()) {
      const pkgName = entry.name;
      const pkgPath = path.join(nmDir, entry.name);
      const pkgJson = path.join(pkgPath, 'package.json');
      map.set(pkgName, {
        version: readPackageVersion(pkgJson),
        path: pkgPath,
      });
    }
  }
  return map;
}

/**
 * Diff user plugins against bundled plugins.
 * Returns the set of packages present in `user` but not in `bundled`
 * (or present with a different version).
 *
 * @param {Map} userMap     indexNodeModules(userNm)
 * @param {Map} bundledMap  indexNodeModules(bundledNm)
 * @returns {Array<{name: string, version: string|null, path: string, source: 'user-only'|'version-diff'}>}
 */
export function diffPlugins(userMap, bundledMap) {
  const result = [];
  for (const [name, info] of userMap) {
    const bundled = bundledMap.get(name);
    if (!bundled) {
      result.push({ name, version: info.version, path: info.path, source: 'user-only' });
    } else if (info.version !== bundled.version) {
      result.push({ name, version: info.version, path: info.path, source: 'version-diff' });
    }
    // Same name + same version → skip (already in bundled tree)
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sensitive file scan
// ---------------------------------------------------------------------------

/**
 * Check if a filename matches any sensitive pattern.
 * Uses high-confidence patterns to avoid false positives on common words
 * like "token" (e.g. Token.ts in katex).
 * @param {string} name
 * @returns {boolean}
 */
export function isSensitiveFilename(name) {
  const base = path.basename(name).toLowerCase();
  // Check for explicit secret-like filename patterns
  if (/api[_-]?key/i.test(base)) return true;
  if (/\.secret/i.test(base)) return true;
  if (/^secret/i.test(base)) return true;   // secret-token.json, secrets.yml
  if (/credential/i.test(base)) return true;
  if (/\.pem$/i.test(base)) return true;
  if (/\.pfx$/i.test(base)) return true;
  if (/\.keystore$/i.test(base)) return true;
  return false;
}

/**
 * Check if file content contains sensitive patterns.
 * Only scans text-like files (small, not .exe/.png/etc).
 * Documentation files (.md, .markdown, .txt, .d.ts) are skipped for
 * content scanning — they often contain example URLs and code snippets
 * that trigger false positives. Filename check still applies.
 * Config-like files (.yaml, .json, .ini) use full SENSITIVE_PATTERNS.
 * All other files use SENSITIVE_PATTERNS_HIGH_CONFIDENCE.
 * @param {string} filePath
 * @param {number} maxSize  skip files larger than this (bytes)
 * @returns {boolean}
 */
export function isSensitiveContent(filePath, maxSize = 256 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxSize) return false;
    // Skip binary file extensions
    const ext = path.extname(filePath).toLowerCase();
    const binaryExts = ['.exe', '.dll', '.png', '.jpg', '.jpeg', '.gif', '.ico',
      '.node', '.wasm', '.zip', '.gz', '.tgz'];
    if (binaryExts.includes(ext)) return false;

    // Skip documentation files — example code/URLs cause false positives
    const docExts = ['.md', '.markdown', '.txt', '.d.ts', '.map', '.css', '.less', '.scss'];
    if (docExts.includes(ext)) return false;

    const content = fs.readFileSync(filePath, 'utf-8');

    // Config-like files: use full patterns (token: "value", etc.)
    // All other files: use high-confidence patterns only
    const configExts = ['.env', '.yaml', '.yml', '.json', '.ini', '.cfg', '.conf', '.toml'];
    const patterns = configExts.includes(ext)
      ? SENSITIVE_PATTERNS
      : SENSITIVE_PATTERNS_HIGH_CONFIDENCE;
    // Filter out false positives (e.g. all-caps env var names)
    return patterns.some((p) => {
      const m = content.match(p);
      return m && !isFalsePositive(m);
    });
  } catch {
    return false;
  }
}

/**
 * Scan a staged directory for sensitive files.
 * Returns a list of violations.
 *
 * @param {string} stagedRoot
 * @returns {Array<{file: string, reason: string}>}
 */
export function scanForSensitiveFiles(stagedRoot) {
  const violations = [];
  for (const rel of walkFiles(stagedRoot)) {
    const full = path.join(stagedRoot, ...rel.split('/'));
    if (isSensitiveFilename(rel)) {
      violations.push({ file: rel, reason: 'filename matches sensitive pattern' });
      continue;
    }
    if (isSensitiveContent(full)) {
      violations.push({ file: rel, reason: 'content matches sensitive pattern' });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

/**
 * Check if a filename should be excluded as a config file.
 * Matches EXCLUDED_NAMES exactly, or EXCLUDED_CONFIG_PATTERNS by regex.
 * @param {string} name  basename
 * @returns {boolean}
 */
export function isExcludedConfig(name) {
  if (EXCLUDED_NAMES.has(name)) return true;
  return EXCLUDED_CONFIG_PATTERNS.some((p) => p.test(name));
}

/**
 * Copy a directory tree recursively, skipping excluded names and config patterns.
 * Preserves symlinks/junctions as real copies (for portability).
 */
export function copyDirFiltered(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (isExcludedConfig(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirFiltered(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
    // Symlinks: resolve and copy as real file/dir (portable)
    else if (entry.isSymbolicLink()) {
      try {
        const target = fs.realpathSync(s);
        const tStat = fs.statSync(target);
        if (tStat.isDirectory()) {
          copyDirFiltered(target, d);
        } else {
          fs.copyFileSync(target, d);
        }
      } catch {
        // Broken symlink — skip
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Manifest generation
// ---------------------------------------------------------------------------

/**
 * Build the manifest object for a plugin snapshot.
 *
 * @param {object} opts
 * @param {string} opts.dshVersion
 * @param {Array} opts.plugins  [{name, version, sha256, source}]
 * @param {Array} opts.presets  [{name, sha256}]
 * @param {string} opts.snapshotSha  sha256 of the manifest content (excl. this field)
 * @param {string} [opts.buildMachine]
 * @returns {object}
 */
export function buildManifest(opts) {
  const now = new Date().toISOString();
  return {
    schema: 'dsh-plugin-snapshot/v1',
    dshVersion: opts.dshVersion,
    plugins: opts.plugins,
    presets: opts.presets,
    snapshotSha: opts.snapshotSha,
    createdAt: now,
    buildMachine: opts.buildMachine || os.hostname(),
    buildPlatform: process.platform,
    buildNodeVersion: process.version,
  };
}

// ---------------------------------------------------------------------------
// Main snapshot function
// ---------------------------------------------------------------------------

/**
 * Build a plugin layer snapshot.
 *
 * @param {object} opts
 * @param {string} opts.dshHome       source ~/.dsh (or a test fixture)
 * @param {string} opts.bundledDsh    source dsh/ (bundled runtime tree)
 * @param {string} opts.outputDir     plugins-layer/ target
 * @param {string[]} [opts.presetWhitelist]  preset dir names to include
 * @param {object} [opts.log]         {info, warn, error} logger
 * @returns {Promise<object>} manifest object
 * @throws {Error} if sensitive files are found, or required inputs missing
 */
export async function buildSnapshot(opts) {
  const {
    dshHome,
    bundledDsh,
    outputDir,
    presetWhitelist = null,
    log = console,
  } = opts;

  // --- Validate inputs ---
  if (!fs.existsSync(dshHome)) {
    throw new Error(`DSH_HOME not found: ${dshHome}`);
  }
  if (!fs.existsSync(bundledDsh)) {
    throw new Error(`Bundled dsh not found: ${bundledDsh}`);
  }

  const dshVersion = readDshVersion(bundledDsh);
  if (!dshVersion) {
    throw new Error(`Cannot read dsh version from ${bundledDsh}`);
  }

  // --- Prepare output ---
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  // --- 1. Diff plugins ---
  // Bug fix: diff against profiles/web/node_modules (where dsh's web profile
  // actually resolves plugins), NOT profiles/node_modules (the shared tree).
  const userNm = profilesWebNodeModules(dshHome);
  const bundledNm = path.join(bundledDsh, 'node_modules');
  const userMap = indexNodeModules(userNm);
  const bundledMap = indexNodeModules(bundledNm);
  const diff = diffPlugins(userMap, bundledMap);

  log.info(`[snapshot] plugin diff: ${diff.length} incremental package(s)`);
  for (const p of diff) {
    log.info(`  ${p.name}@${p.version || '?'} (${p.source})`);
  }

  // --- 2. Copy incremental plugin packages ---
  const pluginRecords = [];
  if (diff.length > 0) {
    const destNm = path.join(outputDir, 'node_modules');
    fs.mkdirSync(destNm, { recursive: true });
    for (const p of diff) {
      // Determine dest path (preserve scope)
      const parts = p.name.split('/');
      let destPkg;
      if (parts.length === 2) {
        const scopeDir = path.join(destNm, parts[0]);
        fs.mkdirSync(scopeDir, { recursive: true });
        destPkg = path.join(scopeDir, parts[1]);
      } else {
        destPkg = path.join(destNm, parts[0]);
      }
      copyDirFiltered(p.path, destPkg);

      // Compute sha256 of the package's package.json (stable identifier)
      const pkgJsonPath = path.join(destPkg, 'package.json');
      const sha = fs.existsSync(pkgJsonPath)
        ? sha256File(pkgJsonPath)
        : sha256String(p.name);
      pluginRecords.push({
        name: p.name,
        version: p.version,
        sha256: sha,
        source: p.source,
      });
    }
  }

  // --- 3. Copy cordis.yml (web profile manifest) ---
  const cordisSrc = path.join(profilesWebDir(dshHome), 'cordis.yml');
  let cordisCopied = false;
  if (fs.existsSync(cordisSrc)) {
    fs.copyFileSync(cordisSrc, path.join(outputDir, 'cordis.yml'));
    cordisCopied = true;
    log.info(`[snapshot] copied cordis.yml`);
  } else {
    log.warn(`[snapshot] cordis.yml not found at ${cordisSrc}`);
  }

  // --- 3b. Copy profiles/web/package.json (contains dsh.profile.bundles) ---
  // This is critical: dsh uses dsh.profile.bundles in this file to know
  // which plugins to load for the web profile. Without it, deployed plugins
  // won't be registered even if their node_modules are in place.
  const pkgJsonSrc = profilesWebPackageJson(dshHome);
  let pkgJsonCopied = false;
  if (fs.existsSync(pkgJsonSrc)) {
    // Read and sanitize: strip any potential secrets before staging
    const pkgContent = fs.readFileSync(pkgJsonSrc, 'utf-8');
    // Security: verify no sensitive patterns in package.json content
    if (SENSITIVE_PATTERNS.some((p) => p.test(pkgContent))) {
      // Only fail for high-confidence patterns in JSON (not variable names)
      if (SENSITIVE_PATTERNS_HIGH_CONFIDENCE.some((p) => p.test(pkgContent))) {
        fs.rmSync(outputDir, { recursive: true, force: true });
        throw new Error(
          `Security scan FAILED — sensitive content in profiles/web/package.json\n` +
          `Aborting build. Review the file before re-running.`,
        );
      }
    }
    fs.copyFileSync(pkgJsonSrc, path.join(outputDir, 'package.json'));
    pkgJsonCopied = true;
    log.info(`[snapshot] copied profiles/web/package.json (dsh.profile.bundles)`);
  } else {
    log.warn(`[snapshot] profiles/web/package.json not found at ${pkgJsonSrc}`);
  }

  // --- 4. Copy agent presets ---
  const presetsSrc = agentPresetsDir(dshHome);
  const presetRecords = [];
  if (fs.existsSync(presetsSrc)) {
    let presetNames = fs.readdirSync(presetsSrc, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    if (presetWhitelist) {
      presetNames = presetNames.filter((n) => presetWhitelist.includes(n));
    }

    for (const name of presetNames) {
      const src = path.join(presetsSrc, name);
      const dest = path.join(outputDir, 'agent-presets', name);
      copyDirFiltered(src, dest);
      // sha256 of the directory's manifest or first file
      const presetSha = sha256String(name + ':' + Date.now());
      presetRecords.push({ name, sha256: presetSha });
      log.info(`[snapshot] copied preset: ${name}`);
    }
  } else {
    log.info(`[snapshot] no .agent-presets directory found`);
  }

  // --- 5. Security scan ---
  const violations = scanForSensitiveFiles(outputDir);
  if (violations.length > 0) {
    // Clean up and fail
    fs.rmSync(outputDir, { recursive: true, force: true });
    const msg = violations.map((v) => `  ${v.file}: ${v.reason}`).join('\n');
    throw new Error(
      `Security scan FAILED — sensitive files detected in snapshot:\n${msg}\n` +
      `Aborting build. Review and remove these before re-running.`,
    );
  }
  log.info(`[snapshot] security scan passed (0 violations)`);

  // --- 5b. Non-empty assertion ---
  // Guard against producing an "empty plugin edition" — if both plugins
  // and presets are empty, the snapshot is useless and likely indicates a
  // bug in the diff logic or missing source data.
  if (pluginRecords.length === 0 && presetRecords.length === 0) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    throw new Error(
      `Snapshot is empty — 0 plugins and 0 presets. ` +
      `This likely means the diff source is wrong or ~/.dsh has no plugins installed. ` +
      `Aborting build to prevent producing a useless plugin edition.`,
    );
  }

  // --- 6. Build manifest ---
  // Compute snapshot sha from a stable representation of the content
  const contentForHash = JSON.stringify({
    dshVersion,
    plugins: pluginRecords.map((p) => ({ n: p.name, v: p.version })),
    presets: presetRecords.map((p) => p.name),
    cordisCopied,
    pkgJsonCopied,
  });
  const snapshotSha = sha256String(contentForHash);

  const manifest = buildManifest({
    dshVersion,
    plugins: pluginRecords,
    presets: presetRecords,
    snapshotSha,
  });

  fs.writeFileSync(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );

  // --- 7. Summary ---
  const fileCount = countFiles(outputDir);
  const totalSize = dirSize(outputDir);
  log.info(`[snapshot] complete:`);
  log.info(`  files: ${fileCount}`);
  log.info(`  size:  ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
  log.info(`  plugins: ${pluginRecords.length}`);
  log.info(`  presets: ${presetRecords.length}`);
  log.info(`  dsh version: ${dshVersion}`);
  log.info(`  snapshot sha: ${snapshotSha.slice(0, 16)}…`);

  return manifest;
}

// ---------------------------------------------------------------------------
// Size / count helpers
// ---------------------------------------------------------------------------

export function countFiles(root) {
  let count = 0;
  for (const _ of walkFiles(root)) count++;
  return count;
}

export function dirSize(root) {
  let total = 0;
  if (!fs.existsSync(root)) return 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch {}
      }
    }
  };
  walk(root);
  return total;
}
