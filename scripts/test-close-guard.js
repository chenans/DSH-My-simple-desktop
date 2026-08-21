'use strict';

/**
 * Simulated test for close guard logic (v0.1.17+).
 *
 * Tests checkActiveLlmTask() which uses multiple signals:
 * 1. aria-label contains "停止"/"stop"/"abort"/"cancel"
 * 2. SVG has <rect> (stop icon) and no <path> (send arrow)
 * 3. aria-label does NOT contain "发送"/"send"/"submit"
 *
 * Run: node scripts/test-close-guard.js
 */

// ── Minimal DOM shim ───────────────────────────────────────────────────────

function createFakeSvg(hasRect, hasPath) {
  var rects = hasRect ? [{}] : [];
  var paths = hasPath ? [{}] : [];
  return {
    querySelector: function (tag) {
      if (tag === 'rect') return rects[0] || null;
      if (tag === 'path') return paths[0] || null;
      return null;
    },
  };
}

function createFakeButton(ariaLabel, opts) {
  opts = opts || {};
  var svg = createFakeSvg(opts.hasRect !== false, opts.hasPath !== false);
  return {
    className: 'uV2eYG_primary',
    _ariaLabel: ariaLabel,
    _svg: opts.noSvg ? null : svg,
    offsetParent: opts.visible === false ? null : {},
    getAttribute: function (name) {
      if (name === 'aria-label') return this._ariaLabel;
      return null;
    },
    querySelector: function (sel) {
      if (sel === 'svg') return this._svg;
      return null;
    },
  };
}

function createFakeDocument(btn) {
  return {
    querySelector: function (sel) {
      if (sel === 'button.uV2eYG_primary') return btn;
      return null;
    },
  };
}

// ── Extract the checkActiveLlmTask logic ───────────────────────────────────

function checkActiveLlmTask(doc) {
  var btn = doc.querySelector('button.uV2eYG_primary');
  if (!btn) return false;

  var label = (btn.getAttribute('aria-label') || '').toLowerCase();
  var hasStopLabel = label.indexOf('停止') !== -1 || label.indexOf('stop') !== -1 || label.indexOf('abort') !== -1 || label.indexOf('cancel') !== -1;
  var hasSendLabel = label.indexOf('发送') !== -1 || label.indexOf('send') !== -1 || label.indexOf('submit') !== -1;

  var svg = btn.querySelector('svg');
  var hasRect = svg ? !!svg.querySelector('rect') : false;
  var hasPath = svg ? !!svg.querySelector('path') : false;

  if (hasStopLabel) return true;
  if (hasRect && !hasPath && !hasSendLabel) return true;

  return false;
}

// ── Test framework ──────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  [PASS] ${name}`);
    passCount++;
  } else {
    console.log(`  [FAIL] ${name}`);
    failCount++;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

console.log('\n=== Close Guard Simulated Tests (v0.1.17 — multi-signal) ===\n');

// ── Group 1: Button not found ──────────────────────────────────────────────

console.log('Group 1: Button not found');
(function () {
  var doc = createFakeDocument(null);
  assert(checkActiveLlmTask(doc) === false, 'No button → false');
})();

// ── Group 2: Idle states (should NOT block) ────────────────────────────────

console.log('\nGroup 2: Idle states (should NOT block)');

(function () {
  // Idle: 发送消息 + path icon (arrow), no rect
  var btn = createFakeButton('发送消息', { hasRect: false, hasPath: true });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === false, 'Idle 发送消息 + path → false');
})();

(function () {
  // Ready: 发送消息 + path, enabled
  var btn = createFakeButton('发送消息', { hasRect: false, hasPath: true });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === false, 'Ready 发送消息 + path → false');
})();

(function () {
  // English: "Send message" + path
  var btn = createFakeButton('Send message', { hasRect: false, hasPath: true });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === false, 'English "Send" + path → false');
})();

(function () {
  // Empty label + path
  var btn = createFakeButton('', { hasRect: false, hasPath: true });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === false, 'Empty label + path → false');
})();

(function () {
  // Null label + path
  var btn = createFakeButton(null, { hasRect: false, hasPath: true });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === false, 'Null label + path → false');
})();

// ── Group 3: Generating states (SHOULD block) ──────────────────────────────

console.log('\nGroup 3: Generating states (SHOULD block)');

(function () {
  // 停止生成 + rect icon (stop square)
  var btn = createFakeButton('停止生成', { hasRect: true, hasPath: false });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, '停止生成 + rect → true');
})();

(function () {
  // English: "Stop generating" + rect
  var btn = createFakeButton('Stop generating', { hasRect: true, hasPath: false });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, 'English "Stop" + rect → true');
})();

(function () {
  // "停止" only (shorter label) + rect
  var btn = createFakeButton('停止', { hasRect: true, hasPath: false });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, '停止 + rect → true');
})();

(function () {
  // "abort" label + rect
  var btn = createFakeButton('Abort', { hasRect: true, hasPath: false });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, 'Abort + rect → true');
})();

(function () {
  // "cancel" label + rect
  var btn = createFakeButton('Cancel generation', { hasRect: true, hasPath: false });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, 'Cancel + rect → true');
})();

// ── Group 4: SVG-only detection (label changed but icon is rect) ───────────

console.log('\nGroup 4: SVG-only detection (label changed, rect icon)');

(function () {
  // Unknown label + rect + no path + no send keyword → should block
  var btn = createFakeButton('生成中', { hasRect: true, hasPath: false });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, 'Unknown label "生成中" + rect → true (SVG fallback)');
})();

(function () {
  // Unknown label + rect + no path + no send keyword → should block
  var btn = createFakeButton('Generating...', { hasRect: true, hasPath: false });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, 'Unknown label "Generating" + rect → true (SVG fallback)');
})();

(function () {
  // No label at all + rect → should block
  var btn = createFakeButton('', { hasRect: true, hasPath: false });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, 'Empty label + rect → true (SVG fallback)');
})();

// ── Group 5: Label-only detection (SVG changed but label says stop) ────────

console.log('\nGroup 5: Label-only detection (SVG changed, stop label)');

(function () {
  // 停止生成 + path icon (dsh changed SVG but kept label) → should block
  var btn = createFakeButton('停止生成', { hasRect: false, hasPath: true });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, '停止生成 + path (SVG changed) → true (label fallback)');
})();

(function () {
  // Stop + path icon → should block
  var btn = createFakeButton('Stop', { hasRect: false, hasPath: true });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, 'Stop + path (SVG changed) → true (label fallback)');
})();

// ── Group 6: Edge cases — rect + send label (should NOT block) ─────────────

console.log('\nGroup 6: Edge cases — rect + send label (should NOT block)');

(function () {
  // 发送 + rect (weird case: dsh uses rect for send icon) → should NOT block
  var btn = createFakeButton('发送', { hasRect: true, hasPath: false });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === false, '发送 + rect → false (send label takes priority)');
})();

(function () {
  // Send + rect → should NOT block
  var btn = createFakeButton('Send', { hasRect: true, hasPath: false });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === false, 'Send + rect → false (send label takes priority)');
})();

// ── Group 7: Edge cases — both rect and path ───────────────────────────────

console.log('\nGroup 7: Edge cases — both rect and path present');

(function () {
  // 停止生成 + both rect and path → should block (stop label wins)
  var btn = createFakeButton('停止生成', { hasRect: true, hasPath: true });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, '停止生成 + rect+path → true (stop label)');
})();

(function () {
  // 发送消息 + both rect and path → should NOT block (send label, and hasPath so SVG fallback doesn't trigger)
  var btn = createFakeButton('发送消息', { hasRect: true, hasPath: true });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === false, '发送消息 + rect+path → false');
})();

// ── Group 8: No SVG at all ─────────────────────────────────────────────────

console.log('\nGroup 8: No SVG in button');

(function () {
  // 停止生成 + no SVG → should block (label only)
  var btn = createFakeButton('停止生成', { noSvg: true });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, '停止生成 + no SVG → true (label only)');
})();

(function () {
  // 发送消息 + no SVG → should NOT block
  var btn = createFakeButton('发送消息', { noSvg: true });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === false, '发送消息 + no SVG → false');
})();

(function () {
  // Unknown label + no SVG → should NOT block (no signal)
  var btn = createFakeButton('未知', { noSvg: true });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === false, 'Unknown label + no SVG → false (no signal)');
})();

// ── Group 9: State transitions ─────────────────────────────────────────────

console.log('\nGroup 9: State transitions (idle → generating → idle)');

(function () {
  var btn = createFakeButton('发送消息', { hasRect: false, hasPath: true });
  var doc = createFakeDocument(btn);

  // Idle
  assert(checkActiveLlmTask(doc) === false, 'Initial idle → false');

  // Generation starts: label + SVG change
  btn._ariaLabel = '停止生成';
  btn._svg = createFakeSvg(true, false);
  assert(checkActiveLlmTask(doc) === true, 'Generation started → true');

  // Generation ends: label + SVG revert
  btn._ariaLabel = '发送消息';
  btn._svg = createFakeSvg(false, true);
  assert(checkActiveLlmTask(doc) === false, 'Generation ended → false');
})();

// ── Group 10: i18n resilience — dsh changes all text ───────────────────────

console.log('\nGroup 10: i18n resilience — dsh switches to English');

(function () {
  // dsh switches to English: "Stop generating" + rect
  var btn = createFakeButton('Stop generating', { hasRect: true, hasPath: false });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, 'English "Stop generating" + rect → true');
})();

(function () {
  // dsh switches to English: "Send" + path
  var btn = createFakeButton('Send message', { hasRect: false, hasPath: true });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === false, 'English "Send" + path → false');
})();

// ── Group 11: dsh changes text to something unexpected ─────────────────────

console.log('\nGroup 11: dsh changes text to unexpected values');

(function () {
  // Label becomes "中断" (abort synonym) + rect → should block
  var btn = createFakeButton('中断生成', { hasRect: true, hasPath: false });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, '中断 + rect → true');
})();

(function () {
  // Label becomes "中断" + path (no rect) → should NOT block (中断 not in keyword list, no rect)
  // This is a known limitation — if dsh uses a completely new synonym without rect
  var btn = createFakeButton('中断', { hasRect: false, hasPath: true });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === false, '中断 + path → false (limitation: unknown synonym)');
})();

(function () {
  // Label becomes "中断" + rect (no path) → should block via SVG fallback
  var btn = createFakeButton('中断', { hasRect: true, hasPath: false });
  assert(checkActiveLlmTask(createFakeDocument(btn)) === true, '中断 + rect → true (SVG fallback catches it)');
})();

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n=== Summary ===');
console.log(`  PASS: ${passCount}`);
console.log(`  FAIL: ${failCount}`);
console.log(failCount === 0 ? '\n  All tests passed!' : `\n  ${failCount} test(s) failed!`);
process.exit(failCount === 0 ? 0 : 1);
