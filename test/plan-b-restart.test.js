/**
 * 壳内重启模拟测试（简化版）
 *
 * dsh 退出时的决策逻辑：
 * 1. 正常退出 (code=0 或 SIGTERM) → 延迟 3s 后 reload 窗口
 * 2. 崩溃 (code≠0 且非 SIGTERM) → app.relaunch()，计数器递增
 *
 * 不再轮询端口健康度——reload 后如果 dsh 没起来，用户按 F5 手动刷新。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const APP_MAX_RELAUNCHES = 3;
const RELOAD_DELAY_MS = 3000;

function simulateExitDecision(code, currentCount, signal) {
  const isCleanExit = code === 0 || (code === null && signal === 'SIGTERM');
  if (isCleanExit) {
    return { strategy: 'reload', shouldRelaunch: true, newCount: currentCount, isCleanExit: true };
  }
  if (currentCount < APP_MAX_RELAUNCHES) {
    return { strategy: 'relaunch', shouldRelaunch: true, newCount: currentCount + 1, isCleanExit: false };
  }
  return { strategy: 'stop', shouldRelaunch: false, newCount: currentCount, isCleanExit: false };
}

// ── 测试 ──────────────────────────────────────────────────────────────────

test('SIGTERM → 走 reload 策略，不消耗崩溃预算', () => {
  const d = simulateExitDecision(null, 0, 'SIGTERM');
  assert.strictEqual(d.strategy, 'reload');
  assert.strictEqual(d.newCount, 0);
  assert.strictEqual(d.isCleanExit, true);
});

test('code=0 → 走 reload 策略，不消耗崩溃预算', () => {
  const d = simulateExitDecision(0, 0);
  assert.strictEqual(d.strategy, 'reload');
  assert.strictEqual(d.newCount, 0);
  assert.strictEqual(d.isCleanExit, true);
});

test('code=1 → 走 relaunch 策略，计数器递增', () => {
  const d = simulateExitDecision(1, 0);
  assert.strictEqual(d.strategy, 'relaunch');
  assert.strictEqual(d.newCount, 1);
  assert.strictEqual(d.isCleanExit, false);
});

test('连续 3 次 SIGTERM 都走 reload，计数器始终 0', () => {
  let count = 0;
  for (let i = 0; i < 3; i++) {
    const d = simulateExitDecision(null, count, 'SIGTERM');
    assert.strictEqual(d.strategy, 'reload');
    assert.strictEqual(d.newCount, count);
    count = d.newCount;
  }
  assert.strictEqual(count, 0);
});

test('reload 后崩溃，计数器从 0 开始递增', () => {
  let count = 0;

  // 2 次 reload
  for (let i = 0; i < 2; i++) {
    const d = simulateExitDecision(null, count, 'SIGTERM');
    assert.strictEqual(d.strategy, 'reload');
    count = d.newCount;
  }
  assert.strictEqual(count, 0);

  // 崩溃 → relaunch
  let d = simulateExitDecision(1, count);
  assert.strictEqual(d.strategy, 'relaunch');
  assert.strictEqual(d.newCount, 1);
  count = d.newCount;

  // 再崩溃
  d = simulateExitDecision(1, count);
  assert.strictEqual(d.strategy, 'relaunch');
  assert.strictEqual(d.newCount, 2);
  count = d.newCount;

  // 再崩溃
  d = simulateExitDecision(1, count);
  assert.strictEqual(d.strategy, 'relaunch');
  assert.strictEqual(d.newCount, 3);
  count = d.newCount;

  // 再崩溃 → 停止
  d = simulateExitDecision(1, count);
  assert.strictEqual(d.strategy, 'stop');
  assert.strictEqual(d.shouldRelaunch, false);
});

test('SIGTERM 走 reload，code=1 走 relaunch，策略不同', () => {
  const sigtermDecision = simulateExitDecision(null, 0, 'SIGTERM');
  assert.strictEqual(sigtermDecision.strategy, 'reload');

  const crashDecision = simulateExitDecision(1, 0);
  assert.strictEqual(crashDecision.strategy, 'relaunch');

  assert.notStrictEqual(sigtermDecision.strategy, crashDecision.strategy);
});

test('崩溃达到上限后停止', () => {
  let count = 0;
  for (let i = 0; i < APP_MAX_RELAUNCHES; i++) {
    const d = simulateExitDecision(1, count);
    assert.strictEqual(d.strategy, 'relaunch');
    count = d.newCount;
  }
  assert.strictEqual(count, APP_MAX_RELAUNCHES);

  const d = simulateExitDecision(1, count);
  assert.strictEqual(d.strategy, 'stop');
  assert.strictEqual(d.shouldRelaunch, false);
});

test('reload 延迟为 3 秒', () => {
  assert.strictEqual(RELOAD_DELAY_MS, 3000);
});
