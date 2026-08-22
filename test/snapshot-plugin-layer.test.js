'use strict';

// Test the snapshot-plugin-layer.mjs module.
// Since it's an ESM module, we use dynamic import in an async test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let mod;

// Helper: robust temp dir cleanup (Windows EPERM race)
function robustRmSync(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

async function loadModule() {
  if (!mod) {
    const modulePath = path.resolve(__dirname, '..', 'scripts', 'snapshot-plugin-layer.mjs');
    mod = await import('file:///' + modulePath.replace(/\\/g, '/'));
  }
  return mod;
}

// Helper: create a fake bundled dsh tree
function makeFakeBundledDsh(dir, version) {
  const dshDir = path.join(dir, 'dsh');
  const pkgDir = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dshDir, 'node.exe'), 'fake-node');
  fs.writeFileSync(path.join(pkgDir, 'lib', 'bin.js'), 'fake-bin');
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: version || '0.1.0-rc.7' }),
  );
  return dshDir;
}

// Helper: create a fake user ~/.dsh tree
function makeFakeDshHome(dir) {
  fs.mkdirSync(path.join(dir, 'profiles', 'web'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'profiles', 'web', 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'profiles', 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.agent-presets', 'my-preset'), { recursive: true });

  // cordis.yml
  fs.writeFileSync(
    path.join(dir, 'profiles', 'web', 'cordis.yml'),
    'plugins:\n  - my-plugin\n',
  );

  // profiles/web/package.json with dsh.profile.bundles
  fs.writeFileSync(
    path.join(dir, 'profiles', 'web', 'package.json'),
    JSON.stringify({
      name: 'dsh-web-profile',
      dsh: { profile: { bundles: ['dsh-base', 'dsh-web-app', 'my-plugin'] } },
    }),
  );

  // A user-only plugin in profiles/web/node_modules (where dsh resolves it)
  const userPkg = path.join(dir, 'profiles', 'web', 'node_modules', 'my-plugin');
  fs.mkdirSync(userPkg, { recursive: true });
  fs.writeFileSync(path.join(userPkg, 'index.js'), 'module.exports = {};');
  fs.writeFileSync(
    path.join(userPkg, 'package.json'),
    JSON.stringify({ name: 'my-plugin', version: '2.0.0' }),
  );

  // A plugin that also exists in bundled (same version �?should be skipped)
  const sharedPkg = path.join(dir, 'profiles', 'web', 'node_modules', 'shared-pkg');
  fs.mkdirSync(sharedPkg, { recursive: true });
  fs.writeFileSync(path.join(sharedPkg, 'index.js'), 'module.exports = {};');
  fs.writeFileSync(
    path.join(sharedPkg, 'package.json'),
    JSON.stringify({ name: 'shared-pkg', version: '1.0.0' }),
  );

  // Preset
  fs.writeFileSync(
    path.join(dir, '.agent-presets', 'my-preset', 'config.yml'),
    'name: my-preset\n',
  );

  return dir;
}

// ---------------------------------------------------------------------------

test('EXCLUDED_NAMES contains settings.yaml and credentials', async () => {
  const { EXCLUDED_NAMES } = await loadModule();
  assert.ok(EXCLUDED_NAMES.has('settings.yaml'));
  assert.ok(EXCLUDED_NAMES.has('.credentials.yaml'));
  assert.ok(EXCLUDED_NAMES.has('sessions'));
  assert.ok(EXCLUDED_NAMES.has('task-board'));
});

test('SENSITIVE_PATTERNS detects key-value assignments', async () => {
  const { SENSITIVE_PATTERNS } = await loadModule();
  assert.ok(SENSITIVE_PATTERNS.some(p => p.test('api_key: "sk-1234567890"')), 'should match api_key assignment');
  assert.ok(SENSITIVE_PATTERNS.some(p => p.test('token: "abc123def456"')), 'should match token assignment');
  assert.ok(SENSITIVE_PATTERNS.some(p => p.test('secret: "mysecret123"')), 'should match secret assignment');
  assert.ok(SENSITIVE_PATTERNS.some(p => p.test('password: "pass"')), 'should match password assignment');
  assert.ok(SENSITIVE_PATTERNS.some(p => p.test('"credential": "mycred12345"')), 'should match credential assignment');
  // Bare words without values should NOT match (avoids false positives on schema/descriptions)
  assert.ok(!SENSITIVE_PATTERNS.some(p => p.test('api_key')), 'should not match bare api_key');
  assert.ok(!SENSITIVE_PATTERNS.some(p => p.test('token')), 'should not match bare token');
});

test('isSensitiveFilename: detects sensitive filenames', async () => {
  const { isSensitiveFilename } = await loadModule();
  assert.ok(isSensitiveFilename('api_key.txt'));
  assert.ok(isSensitiveFilename('.credentials.yaml'));
  assert.ok(isSensitiveFilename('secret-token.json'));
  assert.ok(!isSensitiveFilename('index.js'));
  assert.ok(!isSensitiveFilename('package.json'));
});

test('isSensitiveContent: detects sensitive content', async () => {
  const { isSensitiveContent } = await loadModule();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  try {
    const f = path.join(tmp, 'config.js');
    fs.writeFileSync(f, 'const api_key = "sk-1234567890";\n');
    assert.ok(isSensitiveContent(f));

    const f2 = path.join(tmp, 'clean.js');
    fs.writeFileSync(f2, 'const x = 1;\n');
    assert.ok(!isSensitiveContent(f2));

    // Documentation files with common words should NOT trigger false positives
    const f3 = path.join(tmp, 'README.md');
    fs.writeFileSync(f3, 'This plugin manages tokens and secrets for the user.\n');
    assert.ok(!isSensitiveContent(f3));

    // Config files (yaml) with plaintext "password:" SHOULD trigger
    const f4 = path.join(tmp, 'config.yaml');
    fs.writeFileSync(f4, 'password: mySecret123\n');
    assert.ok(isSensitiveContent(f4));
  } finally {
    robustRmSync(tmp);
  }
});

test('EXCLUDED_CONFIG_PATTERNS: matches .env.*, *.local.*, .secrets', async () => {
  const { EXCLUDED_CONFIG_PATTERNS } = await loadModule();
  // .env itself is in EXCLUDED_NAMES; patterns cover .env.* variants
  assert.ok(EXCLUDED_CONFIG_PATTERNS.some(p => p.test('.env.local')));
  assert.ok(EXCLUDED_CONFIG_PATTERNS.some(p => p.test('.env.production')));
  assert.ok(EXCLUDED_CONFIG_PATTERNS.some(p => p.test('config.local.json')));
  assert.ok(EXCLUDED_CONFIG_PATTERNS.some(p => p.test('app.local.yml')));
  assert.ok(EXCLUDED_CONFIG_PATTERNS.some(p => p.test('.secrets.json')));
  assert.ok(EXCLUDED_CONFIG_PATTERNS.some(p => p.test('.secrets')));
  // Should NOT match normal files
  assert.ok(!EXCLUDED_CONFIG_PATTERNS.some(p => p.test('index.js')));
  assert.ok(!EXCLUDED_CONFIG_PATTERNS.some(p => p.test('package.json')));
  assert.ok(!EXCLUDED_CONFIG_PATTERNS.some(p => p.test('config.yml')));
});

test('isExcludedConfig: excludes .env, *.local.*, .secrets, and EXCLUDED_NAMES', async () => {
  const { isExcludedConfig } = await loadModule();
  assert.ok(isExcludedConfig('.env'));
  assert.ok(isExcludedConfig('.env.local'));
  assert.ok(isExcludedConfig('config.local.json'));
  assert.ok(isExcludedConfig('.secrets.json'));
  assert.ok(isExcludedConfig('settings.yaml'));   // from EXCLUDED_NAMES
  assert.ok(isExcludedConfig('.credentials.yaml'));
  assert.ok(isExcludedConfig('sessions'));
  // Normal files pass through
  assert.ok(!isExcludedConfig('index.js'));
  assert.ok(!isExcludedConfig('package.json'));
  assert.ok(!isExcludedConfig('config.yml'));
  assert.ok(!isExcludedConfig('README.md'));
});

test('SENSITIVE_PATTERNS: detects URL with embedded credentials', async () => {
  const { SENSITIVE_PATTERNS } = await loadModule();
  const url = 'https://user:pass123@example.com/api';
  assert.ok(SENSITIVE_PATTERNS.some(p => p.test(url)), 'should match URL with credentials');
  // Normal URL without credentials should not match the credential-URL pattern
  const cleanUrl = 'https://example.com/api';
  // Find the URL-credential pattern by testing against a known positive
  const urlPattern = SENSITIVE_PATTERNS.find(p => p.test('https://u:p@h.com') && !p.test('clean'));
  assert.ok(urlPattern, 'should find the URL-credential pattern');
  assert.ok(!urlPattern.test(cleanUrl), 'should not match clean URL');
});

test('SENSITIVE_PATTERNS: detects URL with embedded credentials', async () => {
  const { SENSITIVE_PATTERNS } = await loadModule();
  const urlWithCreds = 'https://user:pass123@host.example.com/path';
  assert.ok(SENSITIVE_PATTERNS.some(p => p.test(urlWithCreds)), 'should match URL with credentials');
  // Plain URL without credentials should not match the credential pattern
  const plainUrl = 'https://host.example.com/path';
  const credPattern = SENSITIVE_PATTERNS.find(p => /\\\/\\\/\[\^\\s/.test(p.source));
  assert.ok(credPattern, 'should find URL credential pattern');
  assert.ok(!credPattern.test(plainUrl), 'should not match plain URL');
});

test('copyDirFiltered: skips .env and *.local.* files', async () => {
  const { copyDirFiltered } = await loadModule();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-copy-'));
  try {
    const src = path.join(tmp, 'src');
    const dest = path.join(tmp, 'dest');
    fs.mkdirSync(src, { recursive: true });

    // Files that should be copied
    fs.writeFileSync(path.join(src, 'index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(src, 'package.json'), '{}');

    // Files that should be excluded
    fs.writeFileSync(path.join(src, '.env'), 'SECRET=abc');
    fs.writeFileSync(path.join(src, '.env.local'), 'KEY=xyz');
    fs.writeFileSync(path.join(src, 'config.local.json'), '{"key":"val"}');
    fs.writeFileSync(path.join(src, '.secrets.json'), '{}');

    copyDirFiltered(src, dest);

    // Should be present
    assert.ok(fs.existsSync(path.join(dest, 'index.js')));
    assert.ok(fs.existsSync(path.join(dest, 'package.json')));
    // Should be excluded
    assert.ok(!fs.existsSync(path.join(dest, '.env')));
    assert.ok(!fs.existsSync(path.join(dest, '.env.local')));
    assert.ok(!fs.existsSync(path.join(dest, 'config.local.json')));
    assert.ok(!fs.existsSync(path.join(dest, '.secrets.json')));
  } finally {
    robustRmSync(tmp);
  }
});

test('indexNodeModules: indexes packages with versions', async () => {
  const { indexNodeModules } = await loadModule();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  try {
    // Create a package
    const pkgDir = path.join(tmp, 'test-pkg');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'test-pkg', version: '3.1.4' }),
    );

    // Create a scoped package
    const scopedDir = path.join(tmp, '@scope', 'sub-pkg');
    fs.mkdirSync(scopedDir, { recursive: true });
    fs.writeFileSync(
      path.join(scopedDir, 'package.json'),
      JSON.stringify({ name: '@scope/sub-pkg', version: '1.0.0' }),
    );

    const map = indexNodeModules(tmp);
    // indexNodeModules returns Map<name, {version, path}>
    assert.equal(map.get('test-pkg').version, '3.1.4');
    assert.equal(map.get('@scope/sub-pkg').version, '1.0.0');
  } finally {
    robustRmSync(tmp);
  }
});

test('diffPlugins: returns user-only and version-diff', async () => {
  const { diffPlugins } = await loadModule();
  // diffPlugins expects Map<name, {version, path}> and returns an array
  const userMap = new Map([
    ['pkg-a', { version: '1.0.0', path: '/a' }],   // same as bundled �?skip
    ['pkg-b', { version: '2.0.0', path: '/b' }],   // user only �?include
    ['pkg-c', { version: '1.0.0', path: '/c' }],   // version diff �?include
  ]);
  const bundledMap = new Map([
    ['pkg-a', { version: '1.0.0', path: '/ba' }],
    ['pkg-c', { version: '2.0.0', path: '/bc' }],
  ]);

  const result = diffPlugins(userMap, bundledMap);
  // result is an array of {name, version, path, source}
  const userOnly = result.filter(p => p.source === 'user-only');
  const versionDiff = result.filter(p => p.source === 'version-diff');

  // user-only: pkg-b
  assert.ok(userOnly.some(p => p.name === 'pkg-b'));
  // version-diff: pkg-c (user 1.0.0 vs bundled 2.0.0)
  assert.ok(versionDiff.some(p => p.name === 'pkg-c'));
  // pkg-a should not be in result (same version)
  assert.ok(!result.some(p => p.name === 'pkg-a'));
});

test('readDshVersion: reads version from package.json', async () => {
  const { readDshVersion } = await loadModule();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  try {
    makeFakeBundledDsh(tmp, '9.9.9');
    const version = readDshVersion(path.join(tmp, 'dsh'));
    assert.equal(version, '9.9.9');
  } finally {
    robustRmSync(tmp);
  }
});

test('buildManifest: generates correct structure', async () => {
  const { buildManifest } = await loadModule();
  const manifest = buildManifest({
    dshVersion: '0.1.0-rc.7',
    plugins: [{ name: 'pkg-a', version: '1.0.0' }],
    presets: [{ name: 'my-preset' }],
    snapshotSha: 'deadbeef',
    buildMachine: 'test-pc',
  });

  assert.equal(manifest.schema, 'dsh-plugin-snapshot/v1');
  assert.equal(manifest.dshVersion, '0.1.0-rc.7');
  assert.equal(manifest.snapshotSha, 'deadbeef');
  assert.equal(manifest.plugins.length, 1);
  assert.equal(manifest.presets.length, 1);
  assert.ok(manifest.createdAt);
  assert.equal(manifest.buildMachine, 'test-pc');
});

test('buildSnapshot: builds snapshot with diff, manifest, and sha', async () => {
  const { buildSnapshot } = await loadModule();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-full-'));
  try {
    const dshHome = path.join(tmp, 'dsh-home');
    const bundledDsh = path.join(tmp, 'dsh');  // must be named 'dsh' for makeFakeBundledDsh
    const outputDir = path.join(tmp, 'output');

    makeFakeDshHome(dshHome);
    makeFakeBundledDsh(tmp, '0.1.0-rc.7');  // creates tmp/dsh/
    // Add shared-pkg to bundled so diff logic works
    const sharedBundled = path.join(bundledDsh, 'node_modules', 'shared-pkg');
    fs.mkdirSync(sharedBundled, { recursive: true });
    fs.writeFileSync(
      path.join(sharedBundled, 'package.json'),
      JSON.stringify({ name: 'shared-pkg', version: '1.0.0' }),
    );

    const manifest = await buildSnapshot({
      dshHome,
      bundledDsh,
      outputDir,
      presetWhitelist: null,  // include all
    });

    // Manifest should be generated
    assert.ok(manifest);
    assert.equal(manifest.schema, 'dsh-plugin-snapshot/v1');
    assert.equal(manifest.dshVersion, '0.1.0-rc.7');
    assert.ok(manifest.snapshotSha);
    assert.ok(manifest.plugins.length > 0);

    // Output dir should have manifest.json
    assert.ok(fs.existsSync(path.join(outputDir, 'manifest.json')));

    // cordis.yml should be copied
    assert.ok(fs.existsSync(path.join(outputDir, 'cordis.yml')));

    // package.json (with dsh.profile.bundles) should be copied
    assert.ok(fs.existsSync(path.join(outputDir, 'package.json')));
    const pkgContent = JSON.parse(fs.readFileSync(path.join(outputDir, 'package.json'), 'utf-8'));
    assert.ok(pkgContent.dsh && pkgContent.dsh.profile && pkgContent.dsh.profile.bundles);

    // my-plugin (user-only) should be in output node_modules
    assert.ok(fs.existsSync(path.join(outputDir, 'node_modules', 'my-plugin', 'index.js')));

    // shared-pkg (same version) should NOT be in output (skipped by diff)
    assert.ok(!fs.existsSync(path.join(outputDir, 'node_modules', 'shared-pkg')));

    // Preset should be copied
    assert.ok(fs.existsSync(path.join(outputDir, 'agent-presets', 'my-preset', 'config.yml')));
  } finally {
    robustRmSync(tmp);
  }
});

test('buildSnapshot: rejects sensitive files', async () => {
  const { buildSnapshot } = await loadModule();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-sensitive-'));
  try {
    const dshHome = path.join(tmp, 'dsh-home');
    const bundledDsh = path.join(tmp, 'dsh');
    const outputDir = path.join(tmp, 'output');

    makeFakeDshHome(dshHome);
    makeFakeBundledDsh(tmp, '0.1.0-rc.7');

    // Add a sensitive file to user plugins (matches high-confidence pattern)
    const userPkg = path.join(dshHome, 'profiles', 'web', 'node_modules', 'my-plugin');
    fs.writeFileSync(path.join(userPkg, 'api_key.txt'), 'sk-1234567890abcdefghijklmnop');

    await assert.rejects(
      buildSnapshot({ dshHome, bundledDsh, outputDir }),
      /sensitive/i,
    );
  } finally {
    robustRmSync(tmp);
  }
});

test('sha256String: produces consistent hash', async () => {
  const { sha256String } = await loadModule();
  const h1 = sha256String('test');
  const h2 = sha256String('test');
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);  // hex string
  assert.notEqual(h1, sha256String('other'));
});
