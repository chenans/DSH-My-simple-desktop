'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// usage-stats.js resolves DSH_HOME at module load time, so each test must
// set the env var BEFORE requiring the module (and drop the require cache).
const MODULE = path.resolve(__dirname, '..', 'src', 'lib', 'usage-stats.js');

function withDshHome(home, fn) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    delete require.cache[require.resolve(MODULE)];
    const mod = require(MODULE);
    return fn(mod);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    delete require.cache[require.resolve(MODULE)];
  }
}

const DAY = 24 * 60 * 60 * 1000;

function buildFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-test-'));
  const storages = path.join(home, 'storages');
  const sessionsDir = path.join(storages, 'session_projcache', 'sessions');
  const usageDir = path.join(home, 'dsh-usage');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(usageDir, { recursive: true });

  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const yest = new Date(now - DAY).toISOString().slice(0, 10);

  // Aggregate snapshot file: contains a STALE blank session (this is the
  // shape that previously made totalSessions/totalSteps always 0).
  fs.writeFileSync(
    path.join(storages, 'session_projcache.json'),
    JSON.stringify({
      tables: {
        sessions: {
          'session-stale': {
            identity: { createdAt: now - 2 * DAY, cwd: 'D:\\proj\\old' },
            rows: {
              sessionStats: { val: { turns: 0, steps: 0, llmMs: 0 } },
              tokenUsage: { val: { totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
            },
          },
        },
      },
    })
  );

  // Real per-session files (the data the aggregate file does NOT reflect).
  fs.writeFileSync(
    path.join(sessionsDir, 'session-aaa.json'),
    JSON.stringify({
      version: 5,
      record: {
        identity: { createdAt: now - 1 * DAY, cwd: 'D:\\proj\\alpha' },
        rows: {
          sessionStats: { val: { turns: 3, steps: 12, llmMs: 30000 } },
          tokenUsage: { val: { totals: { uncachedInputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 0 } } },
        },
      },
    })
  );
  fs.writeFileSync(
    path.join(sessionsDir, 'session-bbb.json'),
    JSON.stringify({
      version: 5,
      record: {
        identity: { createdAt: now - 3 * 3600 * 1000, cwd: 'D:\\proj\\beta' },
        rows: {
          sessionStats: { val: { turns: 5, steps: 20, llmMs: 50000 } },
          tokenUsage: { val: { totals: { uncachedInputTokens: 4000, outputTokens: 5000, cacheReadTokens: 6000, cacheWriteTokens: 0 } } },
        },
      },
    })
  );

  // Workspace registry.
  fs.writeFileSync(
    path.join(storages, 'workspace.json'),
    JSON.stringify({
      tables: {
        workspaces: {
          'ws-alpha': { path: 'D:\\proj\\alpha', title: 'alpha', sessionIds: ['session-aaa'] },
          'ws-beta': { path: 'D:\\proj\\beta', title: 'beta', sessionIds: ['session-bbb'] },
        },
      },
    })
  );

  // Usage ledger: yesterday + today (today is the case that used to be
  // dropped by "last N days" because range.end was not end-of-day).
  fs.writeFileSync(
    path.join(usageDir, 'usage-ledger.json'),
    JSON.stringify({
      days: {
        [yest]: { 'prov-a': { 'model-x': { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0, calls: 2, cost: 0 } } },
        [today]: { 'prov-a': { 'model-x': { inputTokens: 200, outputTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 0, calls: 3, cost: 0 } } },
      },
    })
  );

  return { home, today, yest };
}

test('usage: extractSessions merges per-session files (totals no longer 0)', () => {
  const fx = buildFixture();
  withDshHome(fx.home, (US) => {
    const sessions = US.extractSessions();
    // stale blank + two real sessions
    assert.equal(sessions.length, 3);
    const aaa = sessions.find((s) => s.sessionId === 'session-aaa');
    assert.equal(aaa.turns, 3);
    assert.equal(aaa.steps, 12);
    assert.equal(aaa.outputTokens, 2000);
  });
  fs.rmSync(fx.home, { recursive: true, force: true });
});

test('usage: getUsageStats includes today for "last 7 days" range', () => {
  const fx = buildFixture();
  withDshHome(fx.home, (US) => {
    const range = { start: Date.now() - 7 * DAY, end: Date.now() };
    const stats = US.getUsageStats('day', range);
    // Ledger records must survive the range filter (today must be included).
    assert.ok(stats.summary.totalCalls >= 5, `totalCalls=${stats.summary.totalCalls}`);
    assert.ok(stats.summary.totalTokens > 0, 'totalTokens should be > 0');
    const todayPeriod = stats.periods.find((p) => p.period === fx.today);
    assert.ok(todayPeriod, `period ${fx.today} missing in ${stats.periods.map((p) => p.period)}`);
    assert.ok(todayPeriod.totalTokens >= 300, `today tokens=${todayPeriod.totalTokens}`);
    // Session counts merged into periods (for the chart line).
    assert.ok(stats.periods.some((p) => p.sessions > 0), 'some period should have sessions');
  });
  fs.rmSync(fx.home, { recursive: true, force: true });
});

test('usage: getUsageStats without range returns everything', () => {
  const fx = buildFixture();
  withDshHome(fx.home, (US) => {
    const stats = US.getUsageStats('auto', null);
    assert.equal(stats.summary.totalSessions, 3); // stale + aaa + bbb
    assert.ok(stats.summary.totalTurns >= 8, `turns=${stats.summary.totalTurns}`);
    assert.ok(stats.summary.totalSteps >= 32, `steps=${stats.summary.totalSteps}`);
    assert.ok(stats.summary.totalTokens > 0);
    assert.ok(stats.periods.length >= 2, 'continuous periods from both days');
  });
  fs.rmSync(fx.home, { recursive: true, force: true });
});

test('usage: workspace aggregation groups sessions by workspace', () => {
  const fx = buildFixture();
  withDshHome(fx.home, (US) => {
    const stats = US.getUsageStats('auto', null);
    const byTitle = Object.fromEntries(stats.workspaces.map((w) => [w.title, w]));
    assert.ok(byTitle.alpha, 'workspace alpha missing');
    assert.ok(byTitle.beta, 'workspace beta missing');
    assert.equal(byTitle.alpha.sessions, 1);
    assert.equal(byTitle.alpha.turns, 3);
    assert.equal(byTitle.beta.turns, 5);
    // stale session (unknown cwd) falls back to "未知工作区"
    assert.ok(stats.workspaces.some((w) => w.title === '未知工作区'), 'fallback workspace missing');
  });
  fs.rmSync(fx.home, { recursive: true, force: true });
});

test('usage: week granularity buckets ledger into week periods', () => {
  const fx = buildFixture();
  withDshHome(fx.home, (US) => {
    const stats = US.getUsageStats('week', null);
    assert.equal(stats.granularity, 'week');
    assert.ok(stats.periods.length >= 1);
    assert.ok(stats.periods.every((p) => p.period.includes('（周）')));
    const tot = stats.periods.reduce((acc, p) => acc + p.totalTokens, 0);
    assert.equal(tot, stats.summary.totalTokens);
  });
  fs.rmSync(fx.home, { recursive: true, force: true });
});
