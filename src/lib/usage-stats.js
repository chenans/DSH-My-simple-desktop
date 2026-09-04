'use strict';

/**
 * Usage statistics reader for dsh data files.
 * Reads from ~/.dsh/storages/session_projcache.json and workspace.json
 * to aggregate token usage, sessions, interactions by project/model/time.
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
 * Extract session stats from session_projcache.json.
 * Returns array of session objects with normalized fields.
 */
function extractSessions() {
  const cacheFile = path.join(DSH_HOME, 'storages', 'session_projcache.json');
  const data = readJson(cacheFile);
  if (!data || !data.tables || !data.tables.sessions) return [];

  const sessions = [];
  const sessTable = data.tables.sessions;

  for (const [sessionId, sessData] of Object.entries(sessTable)) {
    if (!sessData || !sessData.rows) continue;

    const stats = sessData.rows.sessionStats?.val || {};
    const tokens = sessData.rows.tokenUsage?.val?.totals || {};
    const identity = sessData.identity || {};

    sessions.push({
      sessionId,
      cwd: identity.cwd || 'unknown',
      createdAt: identity.createdAt || 0,
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
    });
  }

  return sessions;
}

/**
 * Extract workspace/project info from workspace.json.
 * Returns map of workspaceId -> { path, title, sessionIds }
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
 * Convert timestamp to date string (YYYY-MM-DD).
 */
function dateStr(ts) {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return 'unknown';
  return d.toISOString().slice(0, 10);
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
    case 'day':
      return `${y}-${m}-${day}`;
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
 * Aggregate usage statistics.
 * @param {string} granularity - 'day' | 'week' | 'month' | 'year' | 'auto'
 * @param {object} range - optional { start, end } timestamps
 * @returns {object} aggregated stats
 */
function getUsageStats(granularity = 'day', range = null) {
  const sessions = extractSessions();
  const workspaces = extractWorkspaces();

  // Build cwd -> project name map
  const projectMap = {};
  for (const ws of Object.values(workspaces)) {
    if (ws.path) projectMap[ws.path] = ws.title;
  }

  // Filter by date range if provided
  let filtered = sessions;
  if (range && range.start && range.end) {
    filtered = sessions.filter(s => s.createdAt >= range.start && s.createdAt <= range.end);
  }

  // Determine auto granularity based on date span
  let actualGranularity = granularity;
  if (granularity === 'auto' && filtered.length > 0) {
    const times = filtered.map(s => s.createdAt).filter(t => t > 0).sort((a, b) => a - b);
    if (times.length > 0) {
      const span = times[times.length - 1] - times[0];
      const days = span / (24 * 60 * 60 * 1000);
      if (days <= 1) actualGranularity = 'day';
      else if (days <= 14) actualGranularity = 'day';
      else if (days <= 90) actualGranularity = 'week';
      else if (days <= 730) actualGranularity = 'month';
      else actualGranularity = 'year';
    }
  }

  // Aggregate by time period
  const byPeriod = {};
  // Aggregate by project
  const byProject = {};
  // Aggregate by model (from session stats - dsh doesn't store model per session
  // in projcache, so we approximate from provider-snapshots if available)
  const byModel = {};

  let totalSessions = 0;
  let totalTurns = 0;
  let totalSteps = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalLlmMs = 0;

  for (const s of filtered) {
    const projName = projectMap[s.cwd] || projectFromCwd(s.cwd);
    const period = periodKey(s.createdAt, actualGranularity);
    const date = dateStr(s.createdAt);

    // Skip empty sessions (no turns and no tokens)
    if (s.turns === 0 && s.outputTokens === 0 && s.uncachedInputTokens === 0) continue;

    totalSessions++;
    totalTurns += s.turns;
    totalSteps += s.steps;
    totalInputTokens += s.uncachedInputTokens;
    totalOutputTokens += s.outputTokens;
    totalCacheRead += s.cacheReadTokens;
    totalCacheWrite += s.cacheWriteTokens;
    totalLlmMs += s.llmMs;

    // By period
    if (!byPeriod[period]) {
      byPeriod[period] = {
        period, sessions: 0, turns: 0, steps: 0,
        inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
        llmMs: 0,
      };
    }
    const p = byPeriod[period];
    p.sessions++;
    p.turns += s.turns;
    p.steps += s.steps;
    p.inputTokens += s.uncachedInputTokens;
    p.outputTokens += s.outputTokens;
    p.cacheRead += s.cacheReadTokens;
    p.cacheWrite += s.cacheWriteTokens;
    p.llmMs += s.llmMs;

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
  }

  // Try to read model info from provider-snapshots (for display)
  const snapshotsFile = path.join(DSH_HOME, 'dsh-usage', 'provider-snapshots.json');
  const snapshots = readJson(snapshotsFile);
  if (snapshots && snapshots.providers) {
    for (const [providerId, providerData] of Object.entries(snapshots.providers)) {
      const displayName = providerData.displayName || providerId;
      byModel[displayName] = {
        model: displayName,
        provider: providerId,
        balance: providerData.balance?.totalBalance || null,
        currency: providerData.balance?.currency || null,
        // Note: per-model token usage is not available in dsh data files
        // We show provider info instead
      };
    }
  }

  // Convert to sorted arrays
  const periods = Object.values(byPeriod).sort((a, b) => a.period.localeCompare(b.period));
  const projects = Object.values(byProject).sort((a, b) => b.sessions - a.sessions);
  const models = Object.values(byModel).sort((a, b) => a.model.localeCompare(b.model));

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
      totalLlmMs,
      avgLlmMs: totalSessions > 0 ? Math.round(totalLlmMs / totalSessions) : 0,
    },
    periods,
    projects,
    models,
    rawSessionCount: sessions.length,
  };
}

module.exports = {
  getUsageStats,
  extractSessions,
  extractWorkspaces,
};
