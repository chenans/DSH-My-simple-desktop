'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  compareVersions,
  ensureRuntime,
  installShim,
  addEnvDirToPath,
  removeEnvDirFromPath,
  parseUserPath,
  formatUserPath,
  pathEntry,
  deployDir,
  readDeployedVersion,
} = require('../src/lib/runtime-updater.js');

test('compareVersions: equal versions return 0', () => {
  assert.strictEqual(compareVersions('0.1.0', '0.1.0'), 0);
  assert.strictEqual(compareVersions('1.2.3', '1.2.3'), 0);
});

test('compareVersions: older vs newer returns negative', () => {
  assert.strictEqual(compareVersions('0.1.0', '0.1.1'), -1);
  assert.strictEqual(compareVersions('0.9.9', '1.0.0'), -1);
  assert.strictEqual(compareVersions('0.1.9', '0.2.0'), -1);
});

test('compareVersions: newer vs older returns positive', () => {
  assert.strictEqual(compareVersions('0.1.1', '0.1.0'), 1);
  assert.strictEqual(compareVersions('1.0.0', '0.9.9'), 1);
  assert.strictEqual(compareVersions('0.2.0', '0.1.9'), 1);
});

test('ensureRuntime: deploys from resources when environment missing', () => {
  // Build a fake "resources/dsh" source tree in a temp dir
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ru-test-'));
  const fakeResources = path.join(tmpRoot, 'resources');
  const fakeSrc = path.join(fakeResources, 'dsh');
  const fakePkg = path.join(fakeSrc, 'node_modules', '@deepseek-ai', 'dsh');

  fs.mkdirSync(path.join(fakePkg, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(fakeSrc, 'node.exe'), 'FAKE-NODE');
  fs.writeFileSync(path.join(fakePkg, 'lib', 'bin.js'), 'FAKE-BIN');
  fs.writeFileSync(
    path.join(fakePkg, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }),
  );
  // commander package.json is required by isRuntimeIntact
  fs.mkdirSync(path.join(fakeSrc, 'node_modules', 'commander'), { recursive: true });
  fs.writeFileSync(
    path.join(fakeSrc, 'node_modules', 'commander', 'package.json'),
    '{}',
  );

  const envDir = path.join(tmpRoot, 'env');

  try {
    const nodeExe = ensureRuntime({ envDir, resourcesPath: fakeResources });

    // Deployment should return the path to the deployed node.exe
    assert.ok(nodeExe, 'ensureRuntime should return a node.exe path');
    assert.ok(fs.existsSync(nodeExe), 'deployed node.exe should exist');
    assert.ok(
      fs.existsSync(path.join(envDir, 'node.exe')),
      'node.exe copied to env dir',
    );
    assert.ok(
      fs.existsSync(
        path.join(envDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      ),
      'bin.js copied to env dir',
    );

    // Version marker should be written
    assert.strictEqual(readDeployedVersion(envDir), '9.9.9');

    // Second call should be a fast path (still returns the path)
    const again = ensureRuntime({ envDir, resourcesPath: fakeResources });
    assert.strictEqual(again, nodeExe);

    // deployDir helper should resolve to the env dir itself
    assert.strictEqual(deployDir(envDir), envDir);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('ensureRuntime: returns null when no resources provided', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ru-null-'));
  try {
    const result = ensureRuntime({ envDir: path.join(tmpRoot, 'env'), resourcesPath: undefined });
    assert.strictEqual(result, null);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('installShim: creates a dsh.cmd that launches node + bin.js', () => {
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shim-'));
  try {
    const shim = installShim(envDir);
    assert.ok(shim, 'installShim should return the shim path');
    assert.ok(fs.existsSync(path.join(envDir, 'dsh.cmd')), 'dsh.cmd created');

    const content = fs.readFileSync(path.join(envDir, 'dsh.cmd'), 'utf8');
    assert.ok(content.includes('node.exe'), 'shim references node.exe');
    assert.ok(
      content.includes('@deepseek-ai\\dsh\\lib\\bin.js'),
      'shim references dsh bin.js',
    );
    assert.ok(content.includes('%~dp0'), 'shim uses %~dp0 relative paths');
  } finally {
    fs.rmSync(envDir, { recursive: true, force: true });
  }
});

test('parseUserPath: extracts Path value from reg query output', () => {
  const out = [
    'HKEY_CURRENT_USER\\Environment',
    '    Path    REG_EXPAND_SZ    C:\\foo;%USERPROFILE%\\bar',
    '    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp',
  ].join('\r\n');
  assert.strictEqual(parseUserPath(out), 'C:\\foo;%USERPROFILE%\\bar');
  assert.strictEqual(parseUserPath(''), '');
  assert.strictEqual(parseUserPath('no path key here'), '');
});

test('formatUserPath: joins parts and drops empties', () => {
  assert.strictEqual(formatUserPath(['a', 'b', '']), 'a;b');
  assert.strictEqual(formatUserPath([]), '');
  assert.strictEqual(formatUserPath(['a']), 'a');
});

test('pathEntry: uses %USERPROFILE% for home-relative dirs', () => {
  const home = os.homedir();
  const entry = pathEntry(path.join(home, '.dsh-desktop'));
  assert.ok(entry.startsWith('%USERPROFILE%'), 'home dirs use %USERPROFILE%');
  assert.ok(!entry.includes(home), 'absolute home path not embedded');
});

test('addEnvDirToPath: appends entry when absent (mock reg)', () => {
  const calls = [];
  const mockReg = (args) => {
    calls.push(args);
    if (args[0] === 'query') {
      return 'HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\existing;%USERPROFILE%\\x\r\n';
    }
    return '';
  };

  const home = os.homedir();
  const envDir = path.join(home, '.dsh-desktop');
  const ok = addEnvDirToPath(envDir, { reg: mockReg });

  assert.strictEqual(ok, true);
  // One query + one add
  const add = calls.find((a) => a[0] === 'add');
  assert.ok(add, 'reg add called');
  const value = add[add.indexOf('/d') + 1];
  assert.ok(value.includes('%USERPROFILE%\\.dsh-desktop'), 'entry appended');
  assert.ok(value.startsWith('C:\\existing;%USERPROFILE%\\x;'), 'existing preserved');
});

test('addEnvDirToPath: no-op when entry already present (mock reg)', () => {
  const calls = [];
  const mockReg = (args) => {
    calls.push(args);
    if (args[0] === 'query') {
      return 'HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\existing;%USERPROFILE%\\.dsh-desktop\r\n';
    }
    return '';
  };

  const home = os.homedir();
  const envDir = path.join(home, '.dsh-desktop');
  const ok = addEnvDirToPath(envDir, { reg: mockReg });

  assert.strictEqual(ok, true);
  assert.ok(!calls.some((a) => a[0] === 'add'), 'no reg add when already present');
});

test('removeEnvDirFromPath: removes entry (mock reg)', () => {
  const calls = [];
  const mockReg = (args) => {
    calls.push(args);
    if (args[0] === 'query') {
      return 'HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\existing;%USERPROFILE%\\.dsh-desktop;D:\\other\r\n';
    }
    return '';
  };

  const home = os.homedir();
  const envDir = path.join(home, '.dsh-desktop');
  const ok = removeEnvDirFromPath(envDir, { reg: mockReg });

  assert.strictEqual(ok, true);
  const add = calls.find((a) => a[0] === 'add');
  assert.ok(add, 'reg add called');
  const value = add[add.indexOf('/d') + 1];
  assert.strictEqual(value, 'C:\\existing;D:\\other');
  assert.ok(!value.includes('.dsh-desktop'), 'entry removed');
});
