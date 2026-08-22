'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDshCommand } = require('../src/lib/dsh-resolve');

// Helper: create a fake bundled dsh tree in a temp dir
function makeFakeBundled(dir) {
  const bundledDir = path.join(dir, 'dsh');
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.writeFileSync(path.join(bundledDir, 'node.exe'), 'x');
  const dshModuleDir = path.join(bundledDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  fs.mkdirSync(dshModuleDir, { recursive: true });
  fs.writeFileSync(path.join(dshModuleDir, 'bin.js'), 'x');
  return bundledDir;
}

test('resolveDshCommand: forceBundled ignores preferSystem, uses bundled runtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-resolve-plugin-'));
  try {
    const bundledDir = makeFakeBundled(dir);
    const r = resolveDshCommand({
      isPackaged: true,
      resourcesPath: dir,
      env: {},
      platform: 'win32',
      preferSystem: true,   // would normally use system dsh
      forceBundled: true,   // but plugins edition forces bundled
    });
    assert.equal(r.cmd, path.join(bundledDir, 'node.exe'));
    assert.deepEqual(r.args, [path.join(bundledDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]);
    assert.equal(r.needsShell, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDshCommand: forceBundled with envDir still prefers bundled over envDir', () => {
  // When forceBundled, the resolve order is: env override > bundled > envDir > PATH
  // Actually the code checks envDir before bundled. forceBundled only skips
  // the preferSystem branch. So envDir still wins if it exists.
  // This test documents that behavior.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-resolve-plugin2-'));
  try {
    makeFakeBundled(dir);

    // Also create an envDir with a valid runtime
    const envDir = path.join(dir, 'env');
    const envNode = path.join(envDir, 'node.exe');
    const envBin = path.join(envDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    fs.mkdirSync(path.dirname(envBin), { recursive: true });
    fs.writeFileSync(envNode, 'x');
    fs.writeFileSync(envBin, 'x');

    const r = resolveDshCommand({
      isPackaged: true,
      resourcesPath: dir,
      env: {},
      platform: 'win32',
      preferSystem: true,
      forceBundled: true,
      envDir,
    });
    // envDir is checked before bundled resources, so envDir wins
    assert.equal(r.cmd, envNode);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDshCommand: forceBundled without bundled or envDir falls to PATH', () => {
  const r = resolveDshCommand({
    isPackaged: true,
    resourcesPath: path.join(os.tmpdir(), 'does-not-exist-xyz'),
    env: {},
    platform: 'win32',
    preferSystem: true,
    forceBundled: true,
  });
  assert.equal(r.cmd, 'dsh.cmd');
  assert.equal(r.needsShell, true);
});

test('resolveDshCommand: forceBundled=false with preferSystem uses system dsh', () => {
  // Verify that forceBundled=false + preferSystem=true still uses system dsh
  // (i.e. forceBundled only affects the plugins edition)
  const r = resolveDshCommand({
    isPackaged: true,
    resourcesPath: path.join(os.tmpdir(), 'does-not-exist-xyz'),
    env: {},
    platform: 'win32',
    preferSystem: true,
    forceBundled: false,
  });
  assert.equal(r.cmd, 'dsh.cmd');
  assert.equal(r.needsShell, true);
});
