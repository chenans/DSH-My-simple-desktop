'use strict';

/**
 * 模拟测试：验证 startDsh pre-clean lock 逻辑
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * 模拟 startDsh 中的 pre-clean 逻辑（从 main.js 提取）
 */
function preCleanLock(dshHome) {
  const lockFile = path.join(dshHome, 'task-board', 'ledger-v2.lock');
  if (fs.existsSync(lockFile)) {
    try {
      fs.unlinkSync(lockFile);
      return { cleaned: true, method: 'unlinkSync' };
    } catch {
      try {
        require('node:child_process').execSync(
          `attrib -r "${lockFile}"`, { stdio: 'ignore', windowsHide: true, timeout: 2000 }
        );
      } catch {}
      try {
        require('node:child_process').execSync(
          `del /f /q "${lockFile}"`, { stdio: 'ignore', windowsHide: true, timeout: 2000 }
        );
        return { cleaned: true, method: 'del' };
      } catch {
        return { cleaned: false, method: 'failed' };
      }
    }
  }
  return { cleaned: true, method: 'noop' };
}

test('pre-clean: lock 文件不存在时正常通过', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pre-'));
  const result = preCleanLock(tmpDir);
  assert.strictEqual(result.cleaned, true);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('pre-clean: 正常删除存在的 lock 文件', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pre-'));
  const lockDir = path.join(tmpDir, 'task-board');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'ledger-v2.lock'), 'stale');
  assert.strictEqual(fs.existsSync(path.join(lockDir, 'ledger-v2.lock')), true);

  const result = preCleanLock(tmpDir);
  assert.strictEqual(result.cleaned, true);
  assert.strictEqual(fs.existsSync(path.join(lockDir, 'ledger-v2.lock')), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('pre-clean: 只读 lock 文件可删除（Windows）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pre-'));
  const lockDir = path.join(tmpDir, 'task-board');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, 'ledger-v2.lock');
  fs.writeFileSync(lockFile, 'stale');

  if (process.platform === 'win32') {
    try {
      require('node:child_process').execSync(
        `attrib +r "${lockFile}"`, { stdio: 'ignore', windowsHide: true, timeout: 2000 }
      );
    } catch {}
  }

  const result = preCleanLock(tmpDir);
  assert.strictEqual(result.cleaned, true);
  assert.strictEqual(fs.existsSync(lockFile), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('pre-clean: 0o600 权限文件可删除', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pre-'));
  const lockDir = path.join(tmpDir, 'task-board');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, 'ledger-v2.lock');
  // 模拟 dsh acquireLock: openSync(file, "wx", 0o600)
  const fd = fs.openSync(lockFile, 'wx', 0o600);
  fs.closeSync(fd);

  const result = preCleanLock(tmpDir);
  assert.strictEqual(result.cleaned, true);
  assert.strictEqual(fs.existsSync(lockFile), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('pre-clean: 连续两次调用（模拟重启链）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pre-'));
  const lockDir = path.join(tmpDir, 'task-board');
  fs.mkdirSync(lockDir, { recursive: true });

  // 第 1 次：有 lock 文件
  fs.writeFileSync(path.join(lockDir, 'ledger-v2.lock'), 'stale');
  let r = preCleanLock(tmpDir);
  assert.strictEqual(r.cleaned, true);

  // 第 2 次：无 lock 文件
  r = preCleanLock(tmpDir);
  assert.strictEqual(r.cleaned, true);

  // 第 3 次：又有 lock 文件（模拟上次 dsh 崩溃残留）
  fs.writeFileSync(path.join(lockDir, 'ledger-v2.lock'), 'stale2');
  r = preCleanLock(tmpDir);
  assert.strictEqual(r.cleaned, true);
  assert.strictEqual(fs.existsSync(path.join(lockDir, 'ledger-v2.lock')), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
