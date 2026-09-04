'use strict';

/**
 * 模拟测试：验证 简化方案 重启逻辑的关键部分
 * 不依赖 Electron，纯 Node 环境运行
 *
 * 简化方案 策略：
 * - isCleanExit (code=0 或 SIGTERM) → 延迟 reload（等新 dsh + reload BrowserWindow）
 *   不递增计数器，不 app.relaunch()
 * - 崩溃 (code≠0 且非 SIGTERM) → relaunch 整应用 relaunch
 *   递增计数器，APP_MAX_RELAUNCHES 次后停止
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── 1. 验证 --relaunch-count 参数解析 ──────────────────────────────────────

function parseRelaunchCount(argv) {
  const i = argv.indexOf('--relaunch-count');
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) || 0 : 0;
}

test('parseRelaunchCount: 无参数时返回 0', () => {
  assert.strictEqual(parseRelaunchCount([]), 0);
  assert.strictEqual(parseRelaunchCount(['--dev']), 0);
  assert.strictEqual(parseRelaunchCount(['--hidden', '--smoke']), 0);
});

test('parseRelaunchCount: 有参数时返回正确值', () => {
  assert.strictEqual(parseRelaunchCount(['--relaunch-count', '1']), 1);
  assert.strictEqual(parseRelaunchCount(['--relaunch-count', '2']), 2);
  assert.strictEqual(parseRelaunchCount(['--relaunch-count', '3']), 3);
});

test('parseRelaunchCount: 参数在其他 argv 中间', () => {
  assert.strictEqual(parseRelaunchCount(['--hidden', '--relaunch-count', '2', '--smoke']), 2);
});

test('parseRelaunchCount: 无效值回退为 0', () => {
  assert.strictEqual(parseRelaunchCount(['--relaunch-count', 'abc']), 0);
  assert.strictEqual(parseRelaunchCount(['--relaunch-count']), 0);
  assert.strictEqual(parseRelaunchCount(['--relaunch-count', '']), 0);
});

// ── 2. 验证 relaunch args 过滤逻辑 ─────────────────────────────────────────

function buildRelaunchArgs(argv, count) {
  const args = argv.slice(1)
    .filter((a) => a !== '--hidden')
    .filter((a, i, arr) => !(a === '--relaunch-count' || (i > 0 && arr[i - 1] === '--relaunch-count')));
  args.push('--relaunch-count', String(count));
  return args;
}

test('buildRelaunchArgs: 过滤 --hidden', () => {
  const result = buildRelaunchArgs(['app.exe', '--hidden'], 1);
  assert.ok(!result.includes('--hidden'));
  assert.ok(result.includes('--relaunch-count'));
  assert.strictEqual(result[result.indexOf('--relaunch-count') + 1], '1');
});

test('buildRelaunchArgs: 过滤旧的 --relaunch-count', () => {
  const result = buildRelaunchArgs(['app.exe', '--relaunch-count', '2', '--smoke'], 3);
  // 旧的 --relaunch-count 2 应该被过滤掉
  const countIdx = result.indexOf('--relaunch-count');
  assert.strictEqual(countIdx, result.lastIndexOf('--relaunch-count'));
  assert.strictEqual(result[countIdx + 1], '3');
});

test('buildRelaunchArgs: 同时过滤 --hidden 和旧 --relaunch-count', () => {
  const result = buildRelaunchArgs(['app.exe', '--hidden', '--relaunch-count', '1', '--smoke'], 2);
  assert.ok(!result.includes('--hidden'));
  const countIdx = result.indexOf('--relaunch-count');
  assert.strictEqual(result[countIdx + 1], '2');
  // 确保只有一个 --relaunch-count
  assert.strictEqual(result.filter(a => a === '--relaunch-count').length, 1);
});

test('buildRelaunchArgs: 无 --hidden 无 --relaunch-count 时正常追加', () => {
  const result = buildRelaunchArgs(['app.exe', '--smoke'], 1);
  assert.ok(result.includes('--smoke'));
  assert.ok(result.includes('--relaunch-count'));
  assert.strictEqual(result[result.indexOf('--relaunch-count') + 1], '1');
});

// ── 3. 验证 lock 文件删除重试逻辑 ──────────────────────────────────────────

test('lock 删除: 正常删除成功', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lock-test-'));
  const lockDir = path.join(tmpDir, 'task-board');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, 'ledger-v2.lock');
  fs.writeFileSync(lockFile, 'test');

  let removed = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
      }
      removed = true;
      break;
    } catch (e) {
      // retry
    }
  }

  assert.strictEqual(removed, true);
  assert.strictEqual(fs.existsSync(lockFile), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('lock 删除: 文件不存在时直接成功', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lock-test-'));
  const lockFile = path.join(tmpDir, 'task-board', 'ledger-v2.lock');

  let removed = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
      }
      removed = true;
      break;
    } catch (e) {
      // retry
    }
  }

  assert.strictEqual(removed, true);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('lock 删除: 只读文件可删除（Windows attrib -r 后）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lock-test-'));
  const lockDir = path.join(tmpDir, 'task-board');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, 'ledger-v2.lock');
  fs.writeFileSync(lockFile, 'test');

  // 设置只读属性
  if (process.platform === 'win32') {
    try {
      require('node:child_process').execSync(
        `attrib +r "${lockFile}"`, { stdio: 'ignore', windowsHide: true, timeout: 2000 }
      );
    } catch {}
  }

  let removed = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
      }
      removed = true;
      break;
    } catch (e) {
      if (attempt < 5 && process.platform === 'win32') {
        try { require('node:child_process').execSync(
          `attrib -r "${lockFile}"`, { stdio: 'ignore', windowsHide: true, timeout: 2000 }
        ); } catch {}
        try { require('node:child_process').execSync(
          `del /f /q "${lockFile}"`, { stdio: 'ignore', windowsHide: true, timeout: 2000 }
        ); } catch {}
      }
    }
  }

  assert.strictEqual(removed, true);
  assert.strictEqual(fs.existsSync(lockFile), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 4. 验证计数器递增逻辑（模拟 exit 回调决策） ────────────────────────────

const APP_MAX_RELAUNCHES = 3;

/**
 * 模拟 exit 回调的决策逻辑（简化方案）。
 *
 * 返回值：
   * - strategy: 'reload'（延迟 reload）| 'relaunch'（整应用重启）| 'stop'（放弃）
 * - newCount: 新的崩溃计数器值
 * - isCleanExit: 是否为插件重启（code=0 或 SIGTERM）
 */
function simulateExitDecision(code, currentCount, signal) {
  const isCleanExit = code === 0 || (code === null && signal === 'SIGTERM');
  if (isCleanExit) {
    // 延迟 reload，不递增计数器
    return { strategy: 'reload', shouldRelaunch: true, newCount: currentCount, isCleanExit: true };
  }
  // 崩溃：走 relaunch
  if (currentCount < APP_MAX_RELAUNCHES) {
    return { strategy: 'relaunch', shouldRelaunch: true, newCount: currentCount + 1, isCleanExit: false };
  }
  return { strategy: 'stop', shouldRelaunch: false, newCount: currentCount, isCleanExit: false };
}

test('exit 决策: code=0 走延迟 reload，不递增计数器', () => {
  const result = simulateExitDecision(0, 0);
  assert.strictEqual(result.strategy, 'reload');
  assert.strictEqual(result.shouldRelaunch, true);
  assert.strictEqual(result.newCount, 0);
  assert.strictEqual(result.isCleanExit, true);
});

test('exit 决策: code=0 时计数器保持不变（即使已经是 2）', () => {
  const result = simulateExitDecision(0, 2);
  assert.strictEqual(result.strategy, 'reload');
  assert.strictEqual(result.shouldRelaunch, true);
  assert.strictEqual(result.newCount, 2);
});

test('exit 决策: code=null + signal=SIGTERM 走延迟 reload（dsh-market 插件重启）', () => {
  const result = simulateExitDecision(null, 0, 'SIGTERM');
  assert.strictEqual(result.strategy, 'reload');
  assert.strictEqual(result.shouldRelaunch, true);
  assert.strictEqual(result.newCount, 0);
  assert.strictEqual(result.isCleanExit, true);
});

test('exit 决策: code=null + signal=SIGTERM 连续 5 次仍不消耗预算', () => {
  let count = 0;
  for (let i = 0; i < 5; i++) {
    const r = simulateExitDecision(null, count, 'SIGTERM');
    assert.strictEqual(r.strategy, 'reload');
    assert.strictEqual(r.shouldRelaunch, true);
    count = r.newCount;
  }
  assert.strictEqual(count, 0);
});

test('exit 决策: code=null + signal=SIGKILL 走 relaunch 递增计数器（被强杀）', () => {
  const result = simulateExitDecision(null, 0, 'SIGKILL');
  assert.strictEqual(result.strategy, 'relaunch');
  assert.strictEqual(result.shouldRelaunch, true);
  assert.strictEqual(result.newCount, 1);
  assert.strictEqual(result.isCleanExit, false);
});

test('exit 决策: code=null + 无 signal 走 relaunch 递增计数器（异常退出）', () => {
  const result = simulateExitDecision(null, 0, null);
  assert.strictEqual(result.strategy, 'relaunch');
  assert.strictEqual(result.shouldRelaunch, true);
  assert.strictEqual(result.newCount, 1);
  assert.strictEqual(result.isCleanExit, false);
});

test('exit 决策: code=1 走 relaunch 递增计数器', () => {
  const result = simulateExitDecision(1, 0);
  assert.strictEqual(result.strategy, 'relaunch');
  assert.strictEqual(result.shouldRelaunch, true);
  assert.strictEqual(result.newCount, 1);
  assert.strictEqual(result.isCleanExit, false);
});

test('exit 决策: code=1 连续崩溃 3 次后停止', () => {
  let count = 0;
  // 第 1 次崩溃
  let r = simulateExitDecision(1, count);
  assert.strictEqual(r.strategy, 'relaunch');
  assert.strictEqual(r.shouldRelaunch, true);
  count = r.newCount;
  // 第 2 次崩溃
  r = simulateExitDecision(1, count);
  assert.strictEqual(r.strategy, 'relaunch');
  assert.strictEqual(r.shouldRelaunch, true);
  count = r.newCount;
  // 第 3 次崩溃
  r = simulateExitDecision(1, count);
  assert.strictEqual(r.strategy, 'relaunch');
  assert.strictEqual(r.shouldRelaunch, true);
  count = r.newCount;
  assert.strictEqual(count, 3);
  // 第 4 次崩溃 → 应该停止
  r = simulateExitDecision(1, count);
  assert.strictEqual(r.strategy, 'stop');
  assert.strictEqual(r.shouldRelaunch, false);
});

test('exit 决策: code=0 不消耗崩溃预算（3 次 code=0 后仍可 code=1 重启）', () => {
  let count = 0;
  // 3 次 code=0（延迟 reload）
  for (let i = 0; i < 3; i++) {
    const r = simulateExitDecision(0, count);
    assert.strictEqual(r.strategy, 'reload');
    assert.strictEqual(r.shouldRelaunch, true);
    count = r.newCount;
  }
  assert.strictEqual(count, 0);
  // code=1 仍然可以走 relaunch 重启
  const r = simulateExitDecision(1, count);
  assert.strictEqual(r.strategy, 'relaunch');
  assert.strictEqual(r.shouldRelaunch, true);
  assert.strictEqual(r.newCount, 1);
});

test('exit 决策: 混合场景（code=0 和 SIGTERM 走延迟 reload不消耗预算，code=1 走 relaunch 消耗）', () => {
  let count = 0;
  // 插件更新 code=0 → 延迟 reload
  let r = simulateExitDecision(0, count);
  assert.strictEqual(r.strategy, 'reload');
  count = r.newCount;
  assert.strictEqual(count, 0);
  // 崩溃 code=1 → relaunch
  r = simulateExitDecision(1, count);
  assert.strictEqual(r.strategy, 'relaunch');
  count = r.newCount;
  assert.strictEqual(count, 1);
  // dsh-market 插件重启 SIGTERM → 延迟 reload
  r = simulateExitDecision(null, count, 'SIGTERM');
  assert.strictEqual(r.strategy, 'reload');
  count = r.newCount;
  assert.strictEqual(count, 1);
  // 又崩溃 code=1 → relaunch
  r = simulateExitDecision(1, count);
  assert.strictEqual(r.strategy, 'relaunch');
  count = r.newCount;
  assert.strictEqual(count, 2);
  // 又 dsh-market 插件重启 SIGTERM → 延迟 reload
  r = simulateExitDecision(null, count, 'SIGTERM');
  assert.strictEqual(r.strategy, 'reload');
  count = r.newCount;
  assert.strictEqual(count, 2);
  // 又崩溃 code=1 → relaunch
  r = simulateExitDecision(1, count);
  assert.strictEqual(r.strategy, 'relaunch');
  count = r.newCount;
  assert.strictEqual(count, 3);
  // 再崩溃 → 停止
  r = simulateExitDecision(1, count);
  assert.strictEqual(r.strategy, 'stop');
  assert.strictEqual(r.shouldRelaunch, false);
});

// ── 5. 端到端模拟：完整重启链 ──────────────────────────────────────────────
//
// 简化方案 E2E 模拟说明：
// - 延迟 reload (reload): Electron 不退出，argv 不变，计数器不变
// - 整应用重启 (relaunch): argv 更新（过滤 --hidden + 新 --relaunch-count），计数器递增

test('E2E 模拟: 插件更新重启链（code=0 三次，始终走延迟 reload，计数器始终 0）', () => {
  let currentArgv = ['app.exe'];
  for (let round = 0; round < 3; round++) {
    const count = parseRelaunchCount(currentArgv);
    const decision = simulateExitDecision(0, count);
    assert.strictEqual(decision.strategy, 'reload');
    assert.strictEqual(decision.newCount, 0, `round ${round}: count should stay 0`);
    // 延迟 reload不改变 argv
  }
  assert.strictEqual(parseRelaunchCount(currentArgv), 0);
});

test('E2E 模拟: 崩溃重启链（code=1 三次后停止，走 relaunch）', () => {
  let currentArgv = ['app.exe', '--hidden'];
  let shouldStop = false;
  for (let round = 0; round < 10; round++) {
    const count = parseRelaunchCount(currentArgv);
    const decision = simulateExitDecision(1, count);
    if (!decision.shouldRelaunch) {
      shouldStop = true;
      break;
    }
    assert.strictEqual(decision.strategy, 'relaunch', `round ${round} should be relaunch`);
    currentArgv = buildRelaunchArgs(currentArgv, decision.newCount);
  }
  assert.strictEqual(shouldStop, true, 'should stop after 3 crashes');
  assert.strictEqual(parseRelaunchCount(currentArgv), 3);
});

test('E2E 模拟: --hidden 被过滤，relaunch 重启后窗口正常显示', () => {
  const argv = ['app.exe', '--hidden', '--smoke'];
  const result = buildRelaunchArgs(argv, 1);
  assert.ok(!result.includes('--hidden'), '--hidden should be stripped');
  assert.ok(result.includes('--smoke'), '--smoke should be preserved');
});

test('E2E 模拟: dsh-market 插件重启链（SIGTERM 三次，始终走延迟 reload，计数器始终 0）', () => {
  let currentArgv = ['app.exe'];
  for (let round = 0; round < 3; round++) {
    const count = parseRelaunchCount(currentArgv);
    const decision = simulateExitDecision(null, count, 'SIGTERM');
    assert.strictEqual(decision.strategy, 'reload');
    assert.strictEqual(decision.newCount, 0, `round ${round}: count should stay 0`);
    // 延迟 reload不改变 argv
  }
  assert.strictEqual(parseRelaunchCount(currentArgv), 0);
});

test('E2E 模拟: 混合重启链（SIGTERM 延迟 reload + 崩溃 relaunch，预算正确消耗）', () => {
  let currentArgv = ['app.exe'];
  // 插件重启 (SIGTERM) → 延迟 reload，count=0，argv 不变
  let count = parseRelaunchCount(currentArgv);
  let decision = simulateExitDecision(null, count, 'SIGTERM');
  assert.strictEqual(decision.strategy, 'reload');
  assert.strictEqual(decision.newCount, 0);
  // 崩溃 → relaunch，count=1，argv 更新
  count = parseRelaunchCount(currentArgv);
  decision = simulateExitDecision(1, count);
  assert.strictEqual(decision.strategy, 'relaunch');
  assert.strictEqual(decision.newCount, 1);
  currentArgv = buildRelaunchArgs(currentArgv, decision.newCount);
  // 插件重启 (SIGTERM) → 延迟 reload，count 仍=1，argv 不变
  count = parseRelaunchCount(currentArgv);
  decision = simulateExitDecision(null, count, 'SIGTERM');
  assert.strictEqual(decision.strategy, 'reload');
  assert.strictEqual(decision.newCount, 1);
  // 崩溃 → relaunch，count=2，argv 更新
  count = parseRelaunchCount(currentArgv);
  decision = simulateExitDecision(1, count);
  assert.strictEqual(decision.strategy, 'relaunch');
  assert.strictEqual(decision.newCount, 2);
  currentArgv = buildRelaunchArgs(currentArgv, decision.newCount);
  // 崩溃 → relaunch，count=3，argv 更新
  count = parseRelaunchCount(currentArgv);
  decision = simulateExitDecision(1, count);
  assert.strictEqual(decision.strategy, 'relaunch');
  assert.strictEqual(decision.newCount, 3);
  currentArgv = buildRelaunchArgs(currentArgv, decision.newCount);
  // 再崩溃 → 停止
  count = parseRelaunchCount(currentArgv);
  decision = simulateExitDecision(1, count);
  assert.strictEqual(decision.strategy, 'stop');
  assert.strictEqual(decision.shouldRelaunch, false);
});

test('E2E 模拟: 延迟 reload后紧跟崩溃，计数器从 0 开始递增', () => {
  let currentArgv = ['app.exe'];
  // 5 次延迟 reload（SIGTERM），计数器始终 0
  for (let i = 0; i < 5; i++) {
    const count = parseRelaunchCount(currentArgv);
    const decision = simulateExitDecision(null, count, 'SIGTERM');
    assert.strictEqual(decision.strategy, 'reload');
    assert.strictEqual(decision.newCount, 0);
  }
  // 然后崩溃 → relaunch，count=1
  let count = parseRelaunchCount(currentArgv);
  let decision = simulateExitDecision(1, count);
  assert.strictEqual(decision.strategy, 'relaunch');
  assert.strictEqual(decision.newCount, 1);
  currentArgv = buildRelaunchArgs(currentArgv, decision.newCount);
  // 再崩溃 → relaunch，count=2
  count = parseRelaunchCount(currentArgv);
  decision = simulateExitDecision(1, count);
  assert.strictEqual(decision.strategy, 'relaunch');
  assert.strictEqual(decision.newCount, 2);
  currentArgv = buildRelaunchArgs(currentArgv, decision.newCount);
  // 再崩溃 → relaunch，count=3
  count = parseRelaunchCount(currentArgv);
  decision = simulateExitDecision(1, count);
  assert.strictEqual(decision.strategy, 'relaunch');
  assert.strictEqual(decision.newCount, 3);
  currentArgv = buildRelaunchArgs(currentArgv, decision.newCount);
  // 再崩溃 → 停止
  count = parseRelaunchCount(currentArgv);
  decision = simulateExitDecision(1, count);
  assert.strictEqual(decision.strategy, 'stop');
  assert.strictEqual(decision.shouldRelaunch, false);
});
