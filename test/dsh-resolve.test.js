'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDshCommand } = require('../src/lib/dsh-resolve');

test('resolveDshCommand: env override wins', () => {
  const r = resolveDshCommand({
    isPackaged: true,
    resourcesPath: 'C:\\app\\resources',
    env: { DSH_DESKTOP_DSH_BIN: 'C:\\tools\\dsh.exe' },
    platform: 'win32',
  });
  assert.deepEqual(r, { cmd: 'C:\\tools\\dsh.exe', needsShell: false });
});

test('resolveDshCommand: bundled runtime (node.exe + bin.js) used when present (packaged)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-resolve-'));
  const bundledDir = path.join(dir, 'dsh');
  fs.mkdirSync(bundledDir, { recursive: true });
  // Create node.exe
  fs.writeFileSync(path.join(bundledDir, 'node.exe'), 'x');
  // Create the dsh bin.js path
  const dshModuleDir = path.join(bundledDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  fs.mkdirSync(dshModuleDir, { recursive: true });
  fs.writeFileSync(path.join(dshModuleDir, 'bin.js'), 'x');
  const r = resolveDshCommand({
    isPackaged: true,
    resourcesPath: dir,
    env: {},
    platform: 'win32',
  });
  assert.equal(r.cmd, path.join(bundledDir, 'node.exe'));
  assert.deepEqual(r.args, [path.join(bundledDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]);
  assert.equal(r.needsShell, false);
});

test('resolveDshCommand: PATH fallback when bundled runtime missing', () => {
  const r = resolveDshCommand({
    isPackaged: true,
    resourcesPath: path.join(os.tmpdir(), 'does-not-exist-xyz'),
    env: {},
    platform: 'win32',
  });
  assert.equal(r.cmd, 'dsh.cmd');
  assert.equal(r.needsShell, true);
});

test('resolveDshCommand: PATH fallback with long name on posix', () => {
  const r = resolveDshCommand({
    isPackaged: true,
    resourcesPath: path.join(os.tmpdir(), 'does-not-exist-xyz'),
    env: {},
    platform: 'linux',
  });
  assert.equal(r.cmd, 'dsh');
  assert.equal(r.needsShell, false);
});

test('resolveDshCommand: packaged but partial bundle falls through to PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-resolve-'));
  const bundledDir = path.join(dir, 'dsh');
  fs.mkdirSync(bundledDir, { recursive: true });
  // Only node.exe, no dsh bin.js — should fall through
  fs.writeFileSync(path.join(bundledDir, 'node.exe'), 'x');
  const r = resolveDshCommand({
    isPackaged: true,
    resourcesPath: dir,
    env: {},
    platform: 'win32',
  });
  assert.equal(r.cmd, 'dsh.cmd');
});
