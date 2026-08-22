'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// plugin-deployer requires electron-log/main — mock it
const Module = require('node:module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'electron-log/main') {
    return {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }
  return origRequire.apply(this, arguments);
};

const {
  isPluginsEdition,
  deployPluginLayer,
  readBundledManifest,
  readDeployedMarker,
  writeDeployedMarker,
  copyIfAbsent,
  copyDirIfAbsent,
  markerPath,
  bundledManifestPath,
} = require('../src/lib/plugin-deployer');

// Helper: create a fake resources/plugins tree
function makeFakePlugins(resourcesPath, manifest) {
  const pluginsDir = path.join(resourcesPath, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  // manifest.json
  fs.writeFileSync(
    path.join(pluginsDir, 'manifest.json'),
    JSON.stringify(manifest),
  );

  // cordis.yml
  fs.writeFileSync(path.join(pluginsDir, 'cordis.yml'), 'plugins:\n  - test-plugin\n');

  // package.json with dsh.profile.bundles
  fs.writeFileSync(
    path.join(pluginsDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-web-profile',
      dsh: { profile: { bundles: ['dsh-base', 'dsh-web-app', 'test-plugin'] } },
    }),
  );

  // node_modules/test-plugin/index.js
  const pkgDir = path.join(pluginsDir, 'node_modules', 'test-plugin');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = {};\n');
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'test-plugin', version: '1.0.0' }),
  );

  // agent-presets/my-preset/config.yml
  const presetDir = path.join(pluginsDir, 'agent-presets', 'my-preset');
  fs.mkdirSync(presetDir, { recursive: true });
  fs.writeFileSync(path.join(presetDir, 'config.yml'), 'name: my-preset\n');

  return pluginsDir;
}

function makeManifest(overrides) {
  return Object.assign({
    schema: 'dsh-plugin-snapshot/v1',
    dshVersion: '0.1.0-rc.7',
    plugins: [{ name: 'test-plugin', version: '1.0.0' }],
    presets: [{ name: 'my-preset' }],
    snapshotSha: 'abc123def456',
    createdAt: '2026-01-01T00:00:00Z',
    buildMachine: 'test-machine',
  }, overrides);
}

// ---------------------------------------------------------------------------

test('isPluginsEdition: returns true when manifest.json exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-deploy-'));
  try {
    makeFakePlugins(dir, makeManifest());
    assert.equal(isPluginsEdition(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isPluginsEdition: returns false when manifest.json missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-deploy-'));
  try {
    assert.equal(isPluginsEdition(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isPluginsEdition: returns false for null resourcesPath', () => {
  assert.equal(isPluginsEdition(null), false);
});

test('readBundledManifest: returns parsed manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-deploy-'));
  try {
    const manifest = makeManifest({ snapshotSha: 'sha-test-123' });
    makeFakePlugins(dir, manifest);
    const result = readBundledManifest(dir);
    assert.equal(result.snapshotSha, 'sha-test-123');
    assert.equal(result.dshVersion, '0.1.0-rc.7');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readBundledManifest: returns null when missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-deploy-'));
  try {
    assert.equal(readBundledManifest(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deployPluginLayer: deploys on first run, writes marker', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-deploy-'));
  try {
    const resourcesPath = path.join(tmp, 'resources');
    const dshHome = path.join(tmp, 'dsh-home');
    makeFakePlugins(resourcesPath, makeManifest({ snapshotSha: 'first-run-sha' }));
    fs.mkdirSync(dshHome, { recursive: true });

    const result = await deployPluginLayer({ dshHome, resourcesPath });

    assert.equal(result.deployed, true);
    assert.equal(result.reason, 'success');
    assert.ok(result.copied > 0, 'should have copied files');

    // cordis.yml deployed
    assert.ok(fs.existsSync(path.join(dshHome, 'profiles', 'web', 'cordis.yml')));

    // package.json deployed (with dsh.profile.bundles)
    assert.ok(fs.existsSync(path.join(dshHome, 'profiles', 'web', 'package.json')));
    const pkgJson = JSON.parse(fs.readFileSync(
      path.join(dshHome, 'profiles', 'web', 'package.json'), 'utf-8'));
    assert.ok(pkgJson.dsh.profile.bundles.includes('test-plugin'));

    // plugin node_modules deployed to profiles/web/node_modules (not profiles/node_modules)
    assert.ok(fs.existsSync(path.join(dshHome, 'profiles', 'web', 'node_modules', 'test-plugin', 'index.js')));
    assert.ok(!fs.existsSync(path.join(dshHome, 'profiles', 'node_modules', 'test-plugin')));

    // agent-preset deployed
    assert.ok(fs.existsSync(path.join(dshHome, '.agent-presets', 'my-preset', 'config.yml')));

    // marker written
    const marker = readDeployedMarker(dshHome);
    assert.ok(marker);
    assert.equal(marker.snapshotSha, 'first-run-sha');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deployPluginLayer: idempotent — second run with same sha skips', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-deploy-'));
  try {
    const resourcesPath = path.join(tmp, 'resources');
    const dshHome = path.join(tmp, 'dsh-home');
    makeFakePlugins(resourcesPath, makeManifest({ snapshotSha: 'same-sha' }));
    fs.mkdirSync(dshHome, { recursive: true });

    // First deploy
    const r1 = await deployPluginLayer({ dshHome, resourcesPath });
    assert.equal(r1.deployed, true);

    // Second deploy — should skip
    const r2 = await deployPluginLayer({ dshHome, resourcesPath });
    assert.equal(r2.deployed, false);
    assert.equal(r2.reason, 'already deployed');
    assert.equal(r2.copied, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deployPluginLayer: non-destructive — does not overwrite user files', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-deploy-'));
  try {
    const resourcesPath = path.join(tmp, 'resources');
    const dshHome = path.join(tmp, 'dsh-home');
    makeFakePlugins(resourcesPath, makeManifest({ snapshotSha: 'user-test-sha' }));

    // Pre-create a user-modified cordis.yml
    const userCordis = path.join(dshHome, 'profiles', 'web', 'cordis.yml');
    fs.mkdirSync(path.dirname(userCordis), { recursive: true });
    fs.writeFileSync(userCordis, 'USER CUSTOM CONTENT');

    const result = await deployPluginLayer({ dshHome, resourcesPath });
    assert.equal(result.deployed, true);

    // User's cordis.yml should be preserved
    const content = fs.readFileSync(userCordis, 'utf-8');
    assert.equal(content, 'USER CUSTOM CONTENT');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deployPluginLayer: new sha redeploys (app upgrade)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-deploy-'));
  try {
    const resourcesPath = path.join(tmp, 'resources');
    const dshHome = path.join(tmp, 'dsh-home');
    makeFakePlugins(resourcesPath, makeManifest({ snapshotSha: 'old-sha' }));
    fs.mkdirSync(dshHome, { recursive: true });

    // First deploy with old sha
    const r1 = await deployPluginLayer({ dshHome, resourcesPath });
    assert.equal(r1.deployed, true);

    // Update manifest with new sha (simulating app upgrade)
    fs.writeFileSync(
      path.join(resourcesPath, 'plugins', 'manifest.json'),
      JSON.stringify(makeManifest({ snapshotSha: 'new-sha' })),
    );

    // Second deploy — should redeploy
    const r2 = await deployPluginLayer({ dshHome, resourcesPath });
    assert.equal(r2.deployed, true);

    // Marker updated
    const marker = readDeployedMarker(dshHome);
    assert.equal(marker.snapshotSha, 'new-sha');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deployPluginLayer: returns not-deployed when no manifest', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-deploy-'));
  try {
    const resourcesPath = path.join(tmp, 'resources');
    const dshHome = path.join(tmp, 'dsh-home');
    // No plugins dir created
    fs.mkdirSync(dshHome, { recursive: true });

    const result = await deployPluginLayer({ dshHome, resourcesPath });
    assert.equal(result.deployed, false);
    assert.equal(result.reason, 'no bundled manifest');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyIfAbsent: copies when dest missing, skips when exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-deploy-'));
  try {
    const src = path.join(tmp, 'src.txt');
    const dest1 = path.join(tmp, 'dest1.txt');
    const dest2 = path.join(tmp, 'dest2.txt');
    fs.writeFileSync(src, 'hello');

    assert.equal(copyIfAbsent(src, dest1), true);
    assert.equal(fs.readFileSync(dest1, 'utf-8'), 'hello');

    // Pre-create dest2
    fs.writeFileSync(dest2, 'existing');
    assert.equal(copyIfAbsent(src, dest2), false);
    assert.equal(fs.readFileSync(dest2, 'utf-8'), 'existing');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyDirIfAbsent: copies tree, skips existing files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-deploy-'));
  try {
    const src = path.join(tmp, 'src');
    const dest = path.join(tmp, 'dest');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a.txt'), 'A');
    fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'B');

    const r = copyDirIfAbsent(src, dest);
    assert.equal(r.copied, 2);
    assert.equal(r.skipped, 0);
    assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf-8'), 'A');
    assert.equal(fs.readFileSync(path.join(dest, 'sub', 'b.txt'), 'utf-8'), 'B');

    // Second copy — all skipped
    const r2 = copyDirIfAbsent(src, dest);
    assert.equal(r2.copied, 0);
    assert.equal(r2.skipped, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deployPluginLayer: package.json non-destructive merge — preserves user bundles', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-deploy-'));
  try {
    const resourcesPath = path.join(tmp, 'resources');
    const dshHome = path.join(tmp, 'dsh-home');
    makeFakePlugins(resourcesPath, makeManifest({ snapshotSha: 'merge-sha' }));

    // Pre-create user's package.json with existing bundles
    const userPkgPath = path.join(dshHome, 'profiles', 'web', 'package.json');
    fs.mkdirSync(path.dirname(userPkgPath), { recursive: true });
    fs.writeFileSync(userPkgPath, JSON.stringify({
      name: 'my-dsh-profile',
      dsh: { profile: { bundles: ['dsh-base', 'dsh-web-app', 'user-custom-plugin'] } },
    }));

    const result = await deployPluginLayer({ dshHome, resourcesPath });
    assert.equal(result.deployed, true);

    // User's package.json should be preserved + merged
    const merged = JSON.parse(fs.readFileSync(userPkgPath, 'utf-8'));
    assert.equal(merged.name, 'my-dsh-profile');  // user's name preserved
    assert.ok(merged.dsh.profile.bundles.includes('user-custom-plugin'));  // user's bundle kept
    assert.ok(merged.dsh.profile.bundles.includes('test-plugin'));  // bundled plugin added
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Restore original require
Module.prototype.require = origRequire;
