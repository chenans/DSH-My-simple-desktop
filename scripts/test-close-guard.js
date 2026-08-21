'use strict';

/**
 * Simulated test for close guard logic (v0.1.17+).
 *
 * Tests the checkActiveLlmTask() logic which detects the send button's
 * aria-label: "停止生成" means a task is running, "发送消息" means idle.
 *
 * Run: node scripts/test-close-guard.js
 */

// ── Minimal DOM shim ───────────────────────────────────────────────────────

function createFakeButton(ariaLabel, disabled, visible) {
  return {
    className: 'uV2eYG_primary',
    _ariaLabel: ariaLabel,
    _disabled: disabled,
    offsetParent: visible ? {} : null,
    getAttribute: function (name) {
      if (name === 'aria-label') return this._ariaLabel;
      if (name === 'title') return null;
      return null;
    },
    get disabled() {
      return this._disabled;
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
// This mirrors the exact JS injected in main.js checkActiveLlmTask()

function checkActiveLlmTask(doc) {
  var btn = doc.querySelector('button.uV2eYG_primary');
  if (!btn) return false;
  var label = btn.getAttribute('aria-label') || '';
  return label === '停止生成';
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

console.log('\n=== Close Guard Simulated Tests (v0.1.17 — aria-label) ===\n');

// Test 1: Idle — button not found → should NOT block close
console.log('Test 1: Button not found (should NOT block close)');
(function () {
  var doc = createFakeDocument(null);
  var result = checkActiveLlmTask(doc);
  assert(result === false, 'No button → checkActiveLlmTask returns false');
})();

// Test 2: Idle — aria-label="发送消息", disabled=true (no text) → should NOT block
console.log('\nTest 2: Idle — aria-label="发送消息", disabled (no text)');
(function () {
  var btn = createFakeButton('发送消息', true, true);
  var doc = createFakeDocument(btn);
  var result = checkActiveLlmTask(doc);
  assert(result === false, 'Idle send button → checkActiveLlmTask returns false');
})();

// Test 3: Ready — aria-label="发送消息", disabled=false (text entered) → should NOT block
console.log('\nTest 3: Ready — aria-label="发送消息", enabled (text entered)');
(function () {
  var btn = createFakeButton('发送消息', false, true);
  var doc = createFakeDocument(btn);
  var result = checkActiveLlmTask(doc);
  assert(result === false, 'Ready send button → checkActiveLlmTask returns false');
})();

// Test 4: Generating — aria-label="停止生成", disabled=false → SHOULD block
console.log('\nTest 4: Generating — aria-label="停止生成" (SHOULD block close)');
(function () {
  var btn = createFakeButton('停止生成', false, true);
  var doc = createFakeDocument(btn);
  var result = checkActiveLlmTask(doc);
  assert(result === true, 'Generating → checkActiveLlmTask returns true');
})();

// Test 5: Generating — aria-label="停止生成" with different disabled state → SHOULD block
console.log('\nTest 5: Generating — aria-label="停止生成", disabled=true (edge case)');
(function () {
  var btn = createFakeButton('停止生成', true, true);
  var doc = createFakeDocument(btn);
  var result = checkActiveLlmTask(doc);
  assert(result === true, 'Generating (disabled) → checkActiveLlmTask returns true');
})();

// Test 6: Button invisible but aria-label="停止生成" → SHOULD block (label is the signal, not visibility)
console.log('\nTest 6: Generating but button invisible (label still says 停止生成)');
(function () {
  var btn = createFakeButton('停止生成', false, false);
  var doc = createFakeDocument(btn);
  var result = checkActiveLlmTask(doc);
  assert(result === true, 'Invisible generating button → checkActiveLlmTask returns true');
})();

// Test 7: Empty aria-label → should NOT block
console.log('\nTest 7: Empty aria-label');
(function () {
  var btn = createFakeButton('', false, true);
  var doc = createFakeDocument(btn);
  var result = checkActiveLlmTask(doc);
  assert(result === false, 'Empty aria-label → checkActiveLlmTask returns false');
})();

// Test 8: null aria-label → should NOT block
console.log('\nTest 8: null aria-label');
(function () {
  var btn = createFakeButton(null, false, true);
  var doc = createFakeDocument(btn);
  var result = checkActiveLlmTask(doc);
  assert(result === false, 'null aria-label → checkActiveLlmTask returns false');
})();

// Test 9: Different aria-label (e.g. "重新生成") → should NOT block
console.log('\nTest 9: aria-label="重新生成" (not generating, just regenerate option)');
(function () {
  var btn = createFakeButton('重新生成', false, true);
  var doc = createFakeDocument(btn);
  var result = checkActiveLlmTask(doc);
  assert(result === false, '"重新生成" → checkActiveLlmTask returns false');
})();

// Test 10: Case sensitivity — "停止生成" exact match only
console.log('\nTest 10: Case/whitespace sensitivity');
(function () {
  var btn1 = createFakeButton('停止生成 ', false, true); // trailing space
  var doc1 = createFakeDocument(btn1);
  assert(checkActiveLlmTask(doc1) === false, 'Trailing space → false (exact match)');

  var btn2 = createFakeButton(' 停止生成', false, true); // leading space
  var doc2 = createFakeDocument(btn2);
  assert(checkActiveLlmTask(doc2) === false, 'Leading space → false (exact match)');

  var btn3 = createFakeButton('停止生成', false, true); // exact
  var doc3 = createFakeDocument(btn3);
  assert(checkActiveLlmTask(doc3) === true, 'Exact "停止生成" → true');
})();

// Test 11: State transitions — idle → generating → idle
console.log('\nTest 11: State transitions (idle → generating → idle)');
(function () {
  var btn = createFakeButton('发送消息', true, true);
  var doc = createFakeDocument(btn);

  // Idle
  assert(checkActiveLlmTask(doc) === false, 'Initial idle → false');

  // User types text
  btn._ariaLabel = '发送消息';
  btn._disabled = false;
  assert(checkActiveLlmTask(doc) === false, 'Text entered → false');

  // User sends, generation starts
  btn._ariaLabel = '停止生成';
  btn._disabled = false;
  assert(checkActiveLlmTask(doc) === true, 'Generation started → true');

  // Generation continues
  assert(checkActiveLlmTask(doc) === true, 'Still generating → true');

  // Generation ends
  btn._ariaLabel = '发送消息';
  btn._disabled = true;
  assert(checkActiveLlmTask(doc) === false, 'Generation ended → false');
})();

// Test 12: Button with different className → not found
console.log('\nTest 12: Button with different className (not found)');
(function () {
  var doc = {
    querySelector: function (sel) {
      if (sel === 'button.uV2eYG_primary') return null; // different class
      return null;
    },
  };
  var result = checkActiveLlmTask(doc);
  assert(result === false, 'Wrong className → checkActiveLlmTask returns false');
})();

// Test 13: Multiple buttons with same class — querySelector returns first match
console.log('\nTest 13: querySelector returns first match');
(function () {
  var generatingBtn = createFakeButton('停止生成', false, true);
  var doc = createFakeDocument(generatingBtn);
  var result = checkActiveLlmTask(doc);
  assert(result === true, 'First match is generating → true');
})();

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n=== Summary ===');
console.log(`  PASS: ${passCount}`);
console.log(`  FAIL: ${failCount}`);
console.log(failCount === 0 ? '\n  All tests passed!' : `\n  ${failCount} test(s) failed!`);
process.exit(failCount === 0 ? 0 : 1);
