'use strict';

/**
 * Usage statistics reader for dsh data files.
 * Reads from ~/.dsh/storages/session_projcache.json,
 * ~/.dsh/storages/session_projcache/sessions/*.json,
 * ~/.dsh/storages/workspace.json and ~/.dsh/dsh-usage/usage-ledger.json
 * to aggregate token usage, sessions, interactions by workspace/model/time.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

/**
 * Read JSON file safely.
 */
function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Normalize a single session record into flat stats.
 * @param {string} sessionId
 * @param {object} identity - { cwd, createdAt, ... }
 * @param {object} rows - raw rows map { sessionStats: { val }, tokenUsage: { val: { totals } }, ... }
 */
function normalizeSession(sessionId, identity, rows) {
  const stats = (rows && rows.sessionStats && rows.sessionStats.val) || {};
  const tokens =
    (rows && rows.tokenUsage && rows.tokenUsage.val && rows.tokenUsage.val.totals) || {};

  return {
    sessionId,
    cwd: (identity && identity.cwd) || 'unknown',
    createdAt: (identity && identity.createdAt) || 0,
    turns: stats.turns || 0,
    steps: stats.steps || 0,
    llmMs: stats.llmMs || 0,
    toolMs: stats.toolMs || 0,
    ttftMs: stats.ttftMs || 0,
    decodeTokens: stats.decodeTokens || 0,
    uncachedInputTokens: tokens.uncachedInputTokens || 0,
    outputTokens: tokens.outputTokens || 0,
    cacheReadTokens: tokens.cacheReadTokens || 0,
    cacheWriteTokens: tokens.cacheWriteTokens || 0,
  };
}

/**
 * Extract session stats from session_projcache.json AND from the per-session
 * files under session_projcache/sessions/*.json (which hold the most complete
 * data; the aggregate file only mirrors the most recent sessions).
 * Returns array of session objects with normalized fields.
 */
function extractSessions() {
  const byId = {};

  // 1) Aggregate file (older/partial snapshot: { identity, rows } per session)
  const cacheFile = path.join(DSH_HOME, 'storages', 'session_projcache.json');
  const data = readJson(cacheFile);
  if (data && data.tables && data.tables.sessions) {
    for (const [sessionId, sessData] of Object.entries(data.tables.sessions)) {
      if (!sessData || !sessData.rows) continue;
      byId[sessionId] = normalizeSession(sessionId, sessData.identity || {}, sessData.rows);
    }
  }

  // 2) Per-session files (full data: { record: { identity, rows } })
  const sessionsDir = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
  let files = [];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  for (const file of files) {
    const raw = readJson(path.join(sessionsDir, file));
    if (!raw) continue;
    // New layout wraps everything under `record`; older layout is flat.
    const record = raw.record || raw;
    if (!record || !record.rows) continue;
    const sessionId = path.basename(file, '.json');
    byId[sessionId] = normalizeSession(sessionId, record.identity || {}, record.rows);
  }

  return Object.values(byId);
}

/**
 * Extract usage ledger from dsh-usage/usage-ledger.json.
 * Returns aggregated stats by provider/model/day.
 */
function extractUsageLedger() {
  const ledgerFile = path.join(DSH_HOME, 'dsh-usage', 'usage-ledger.json');
  const data = readJson(ledgerFile);
  if (!data || !data.days) return [];

  const records = [];
  for (const [date, providers] of Object.entries(data.days)) {
    for (const [providerId, models] of Object.entries(providers)) {
      for (const [modelId, stats] of Object.entries(models)) {
        records.push({
          date,
          provider: providerId,
          model: modelId,
          inputTokens: stats.inputTokens || 0,
          outputTokens: stats.outputTokens || 0,
          cacheReadTokens: stats.cacheReadTokens || 0,
          cacheWriteTokens: stats.cacheWriteTokens || 0,
          reasoningTokens: stats.reasoningTokens || 0,
          calls: stats.calls || 0,
          cost: stats.cost || 0,
        });
      }
    }
  }
  return records;
}

/**
 * Extract workspace/project info from workspace.json.
 * Returns map of workspaceId -> { path, title, sessionIds, createdAt, updatedAt }
 */
function extractWorkspaces() {
  const wsFile = path.join(DSH_HOME, 'storages', 'workspace.json');
  const data = readJson(wsFile);
  if (!data || !data.tables || !data.tables.workspaces) return {};

  const workspaces = {};
  for (const [wsId, wsData] of Object.entries(data.tables.workspaces)) {
    workspaces[wsId] = {
      path: wsData.path || '',
      title: wsData.title || path.basename(wsData.path || 'unknown'),
      sessionIds: wsData.sessionIds || [],
      createdAt: wsData.createdAt || '',
      updatedAt: wsData.updatedAt || '',
    };
  }
  return workspaces;
}

/**
 * Get project name from cwd path.
 */
function projectFromCwd(cwd) {
  if (!cwd || cwd === 'unknown') return '未知项目';
  return path.basename(cwd) || cwd;
}

/**
 * Get time period key based on granularity.
 * @param {number} ts - timestamp
 * @param {string} granularity - 'day' | 'week' | 'month' | 'year'
 */
function periodKey(ts, granularity) {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return 'unknown';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  switch (granularity) {
    case 'week': {
      // ISO week: get Monday of the week
      const tmp = new Date(d);
      const dayOfWeek = tmp.getDay() || 7; // Sunday=7
      tmp.setDate(tmp.getDate() - dayOfWeek + 1);
      const wy = tmp.getFullYear();
      const wm = String(tmp.getMonth() + 1).padStart(2, '0');
      const wd = String(tmp.getDate()).padStart(2, '0');
      return `${wy}-${wm}-${wd}（周）`;
    }
    case 'month':
      return `${y}-${m}`;
    case 'year':
      return `${y}`;
    default:
      return `${y}-${m}-${day}`;
  }
}

/**
 * Return a Date at the start of the period containing ts.
 */
function startOfPeriod(ts, granularity) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  if (granularity === 'week') {
    const dayOfWeek = d.getDay() || 7;
    d.setDate(d.getDate() - dayOfWeek + 1);
  } else if (granularity === 'month') {
    d.setDate(1);
  } else if (granularity === 'year') {
    d.setMonth(0, 1);
  }
  return d;
}

/**
 * Advance a period-start Date by one period.
 */
function addPeriod(d, granularity) {
  const next = new Date(d);
  if (granularity === 'week') next.setDate(next.getDate() + 7);
  else if (granularity === 'month') next.setMonth(next.getMonth() + 1);
  else if (granularity === 'year') next.setFullYear(next.getFullYear() + 1);
  else next.setDate(next.getDate() + 1);
  return next;
}

/**
 * Build a continuous, gap-free list of period keys from startTs to endTs.
 */
function buildPeriodSeries(startTs, endTs, granularity) {
  if (!(startTs > 0) || !(endTs > 0) || endTs < startTs) return [];
  const list = [];
  let cur = startOfPeriod(startTs, granularity);
  const end = new Date(endTs);
  let guard = 0;
  while (cur.getTime() <= end.getTime() && guard < 5000) {
    list.push(periodKey(cur.getTime(), granularity));
    cur = addPeriod(cur, granularity);
    guard++;
  }
  return list;
}

/**
 * Aggregate usage statistics.
 * @param {string} granularity - 'day' | 'week' | 'month' | 'year' | 'auto'
 * @param {object} range - optional { start, end } timestamps
 * @returns {object} aggregated stats
 */
function getUsageStats(granularity = 'day', range = null) {
  const sessions = extractSessions();
  const workspaces = extractWorkspaces();
  const ledger = extractUsageLedger();

  // Build cwd -> project name map
  const projectMap = {};
  for (const ws of Object.values(workspaces)) {
    if (ws.path) projectMap[ws.path] = ws.title;
  }

  // Filter ledger by date range if provided.
  // A day counts when its interval OVERLAPS the requested range
  // (previously a day was dropped unless it was fully contained, which
  //  removed "today" and the range's first day for presets like "last 7 days").
  let filteredLedger = ledger;
  if (range && range.start && range.end) {
    filteredLedger = ledger.filter((r) => {
      const dateStart = new Date(r.date + 'T00:00:00').getTime();
      const dateEnd = new Date(r.date + 'T23:59:59.999').getTime();
      return dateStart <= range.end && dateEnd >= range.start;
    });
  }

  const filteredSessions = sessions.filter((s) => {
    if (range && range.start && range.end) {
      return s.createdAt >= range.start && s.createdAt <= range.end;
    }
    return true;
  });

  // Time span from both sources (for auto granularity + continuous period series)
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const s of filteredSessions) {
    if (s.createdAt > 0) {
      if (s.createdAt < minTs) minTs = s.createdAt;
      if (s.createdAt > maxTs) maxTs = s.createdAt;
    }
  }
  for (const r of filteredLedger) {
    const ts = new Date(r.date + 'T00:00:00').getTime();
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
  }
  if (!isFinite(minTs)) {
    minTs = 0;
    maxTs = 0;
  }

  // Determine auto granularity based on date span
  let actualGranularity = granularity;
  if (granularity === 'auto') {
    if (minTs > 0 && maxTs >= minTs) {
      const days = (maxTs - minTs) / (24 * 60 * 60 * 1000);
      if (days <= 31) actualGranularity = 'day';
      else if (days <= 180) actualGranularity = 'week';
      else if (days <= 730) actualGranularity = 'month';
      else actualGranularity = 'year';
    } else {
      actualGranularity = 'day';
    }
  }

  // Aggregate by time period (from ledger + sessions)
  const byPeriod = {};
  // Aggregate by model (from ledger)
  const byModel = {};
  // Aggregate by provider
  const byProvider = {};

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCalls = 0;

  for (const r of filteredLedger) {
    const ts = new Date(r.date + 'T00:00:00').getTime();
    const period = periodKey(ts, actualGranularity);
    const modelKey = `${r.provider}/${r.model}`;

    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalCacheRead += r.cacheReadTokens;
    totalCacheWrite += r.cacheWriteTokens;
    totalCalls += r.calls;

    // By period
    if (!byPeriod[period]) {
      byPeriod[period] = {
        period,
        inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
        calls: 0, sessions: 0, turns: 0, steps: 0, totalTokens: 0,
      };
    }
    const p = byPeriod[period];
    p.inputTokens += r.inputTokens;
    p.outputTokens += r.outputTokens;
    p.cacheRead += r.cacheReadTokens;
    p.cacheWrite += r.cacheWriteTokens;
    p.calls += r.calls;
    p.totalTokens = p.inputTokens + p.outputTokens + p.cacheRead + p.cacheWrite;

    // By model
    if (!byModel[modelKey]) {
      byModel[modelKey] = {
        model: r.model,
        provider: r.provider,
        inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
        calls: 0, totalTokens: 0,
      };
    }
    const m = byModel[modelKey];
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
    m.cacheRead += r.cacheReadTokens;
    m.cacheWrite += r.cacheWriteTokens;
    m.calls += r.calls;
    m.totalTokens = m.inputTokens + m.outputTokens + m.cacheRead + m.cacheWrite;

    // By provider
    if (!byProvider[r.provider]) {
      byProvider[r.provider] = {
        provider: r.provider,
        inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
        calls: 0, totalTokens: 0,
      };
    }
    const pr = byProvider[r.provider];
    pr.inputTokens += r.inputTokens;
    pr.outputTokens += r.outputTokens;
    pr.cacheRead += r.cacheReadTokens;
    pr.cacheWrite += r.cacheWriteTokens;
    pr.calls += r.calls;
    pr.totalTokens = pr.inputTokens + pr.outputTokens + pr.cacheRead + pr.cacheWrite;
  }

  // Try to read balance info from provider-snapshots
  const snapshotsFile = path.join(DSH_HOME, 'dsh-usage', 'provider-snapshots.json');
  const snapshots = readJson(snapshotsFile);
  if (snapshots && snapshots.providers) {
    for (const [providerId, providerData] of Object.entries(snapshots.providers)) {
      if (byProvider[providerId]) {
        byProvider[providerId].balance = providerData.balance?.totalBalance || null;
        byProvider[providerId].currency = providerData.balance?.currency || null;
      }
    }
  }

  // Session stats: totals + per-period + per-project + per-workspace
  let totalSessions = 0;
  let totalTurns = 0;
  let totalSteps = 0;
  let totalLlmMs = 0;
  const byProject = {};
  const byWorkspace = {};

  // Map session -> workspace (by sessionIds, then by cwd path)
  const wsBySession = {};
  const wsByCwd = {};
  for (const [wsId, ws] of Object.entries(workspaces)) {
    for (const sid of ws.sessionIds) {
      if (!wsBySession[sid]) wsBySession[sid] = { wsId, title: ws.title, path: ws.path };
    }
    if (ws.path) wsByCwd[ws.path] = { wsId, title: ws.title, path: ws.path };
  }

  for (const s of filteredSessions) {
    const period = s.createdAt > 0 ? periodKey(s.createdAt, actualGranularity) : 'unknown';
    const projName = projectMap[s.cwd] || projectFromCwd(s.cwd);
    const wsInfo = wsBySession[s.sessionId] || wsByCwd[s.cwd] || {
      wsId: 'unknown',
      title: '未知工作区',
      path: s.cwd === 'unknown' ? '' : s.cwd,
    };

    totalSessions++;
    totalTurns += s.turns;
    totalSteps += s.steps;
    totalLlmMs += s.llmMs;

    // Period (sessions/turns/steps merged into the ledger-based series)
    if (!byPeriod[period]) {
      byPeriod[period] = {
        period,
        inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
        calls: 0, sessions: 0, turns: 0, steps: 0, totalTokens: 0,
      };
    }
    const p = byPeriod[period];
    p.sessions++;
    p.turns += s.turns;
    p.steps += s.steps;

    // By project
    if (!byProject[projName]) {
      byProject[projName] = {
        project: projName, cwd: s.cwd, sessions: 0, turns: 0, steps: 0,
        inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
        llmMs: 0, lastUsed: 0,
      };
    }
    const pr = byProject[projName];
    pr.sessions++;
    pr.turns += s.turns;
    pr.steps += s.steps;
    pr.inputTokens += s.uncachedInputTokens;
    pr.outputTokens += s.outputTokens;
    pr.cacheRead += s.cacheReadTokens;
    pr.cacheWrite += s.cacheWriteTokens;
    pr.llmMs += s.llmMs;
    if (s.createdAt > pr.lastUsed) pr.lastUsed = s.createdAt;

    // By workspace
    if (!byWorkspace[wsInfo.wsId]) {
      byWorkspace[wsInfo.wsId] = {
        wsId: wsInfo.wsId,
        title: wsInfo.title,
        path: wsInfo.path,
        sessions: 0, turns: 0, steps: 0,
        inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
        llmMs: 0, lastUsed: 0,
      };
    }
    const w = byWorkspace[wsInfo.wsId];
    w.sessions++;
    w.turns += s.turns;
    w.steps += s.steps;
    w.inputTokens += s.uncachedInputTokens;
    w.outputTokens += s.outputTokens;
    w.cacheRead += s.cacheReadTokens;
    w.cacheWrite += s.cacheWriteTokens;
    w.llmMs += s.llmMs;
    if (s.createdAt > w.lastUsed) w.lastUsed = s.createdAt;
  }

  // Continuous period series (covers the whole requested window, zero-filled)
  const seriesStart = range && range.start ? range.start : minTs;
  const seriesEnd = range && range.end ? range.end : maxTs;
  const periodKeys = buildPeriodSeries(seriesStart, seriesEnd, actualGranularity);
  const periods = periodKeys.map((k) => {
    const p = byPeriod[k];
    return p || {
      period: k,
      inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
      calls: 0, sessions: 0, turns: 0, steps: 0, totalTokens: 0,
    };
  });

  // Convert to sorted arrays
  const models = Object.values(byModel).sort((a, b) => b.totalTokens - a.totalTokens);
  const providers = Object.values(byProvider).sort((a, b) => b.totalTokens - a.totalTokens);
  const projects = Object.values(byProject).sort((a, b) => b.sessions - a.sessions);
  const workspacesOut = Object.values(byWorkspace).sort((a, b) => b.sessions - a.sessions);

  return {
    granularity: actualGranularity,
    summary: {
      totalSessions,
      totalTurns,
      totalSteps,
      totalInputTokens,
      totalOutputTokens,
      totalCacheRead,
      totalCacheWrite,
      totalTokens: totalInputTokens + totalOutputTokens + totalCacheRead + totalCacheWrite,
      totalCalls,
      totalLlmMs,
      avgLlmMs: totalSessions > 0 ? Math.round(totalLlmMs / totalSessions) : 0,
    },
    periods,
    projects,
    workspaces: workspacesOut,
    models,
    providers,
    rawSessionCount: sessions.length,
    ledgerRecordCount: ledger.length,
  };
}

module.exports = {
  getUsageStats,
  extractSessions,
  extractWorkspaces,
};
