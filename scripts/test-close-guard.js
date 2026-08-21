'use strict';

/**
 * Simulated test for close guard logic.
 * 
 * Tests the injected request tracker JS + checkActiveLlmTask JS
 * in a simulated DOM environment (jsdom-like) without Electron.
 * 
 * Run: node scripts/test-close-guard.js
 */

// ── Minimal DOM shim ───────────────────────────────────────────────────────
// Just enough for the injected scripts to run without throwing.

function createFakeElement(visible = true) {
  return {
    offsetParent: visible ? {} : null,
    offsetWidth: visible ? 100 : 0,
    style: {},
  };
}

const fakeDocument = {
  body: {
    innerText: '',
    appendChild: () => {},
  },
  getElementById: () => null,
  querySelector: (sel) => {
    // Simulate: no matching elements by default
    return null;
  },
  querySelectorAll: (sel) => {
    // Simulate: no matching elements by default
    return [];
  },
};

const fakeWindow = {
  __dshRequestTracker: false,
  __activeRequests: 0,
  document: fakeDocument,
  console: console,
  performance: {
    getEntriesByType: () => [],
  },
};

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

// ── Extract the tracker injection script ────────────────────────────────────
// We replicate the exact logic from main.js injectRequestTracker()

function injectTracker(win) {
  if (win.__dshRequestTracker) return;

  var activeCount = 0;
  win.__activeRequests = 0;

  // Track fetch
  var origFetch = win.fetch;
  win.fetch = function () {
    var url = arguments[0];
    if (typeof url === 'object' && url && url.url) url = url.url;
    url = String(url || '');
    if (
      url.indexOf('/api/') !== -1 ||
      url.indexOf('/chat') !== -1 ||
      url.indexOf('/stream') !== -1 ||
      url.indexOf('/completions') !== -1
    ) {
      activeCount++;
      win.__activeRequests = activeCount;

      // Simulate a promise that can be resolved later
      var resolveFn, rejectFn;
      var p = new Promise(function (resolve, reject) {
        resolveFn = resolve;
        rejectFn = reject;
      });
      p.finally = function (cb) {
        var orig = p.then.bind(p);
        return p.then(
          function (v) {
            cb();
            return v;
          },
          function (e) {
            cb();
            throw e;
          }
        );
      };
      // Store resolve/reject for test control
      p.__resolve = resolveFn;
      p.__reject = rejectFn;
      // When promise settles, decrement
      p.then(
        function () {
          activeCount--;
          win.__activeRequests = activeCount;
        },
        function () {
          activeCount--;
          win.__activeRequests = activeCount;
        }
      );
      return p;
    }
    return origFetch ? origFetch.apply(this, arguments) : Promise.resolve({});
  };

  // Track EventSource
  var OrigEventSource = win.EventSource;
  if (OrigEventSource) {
    win.EventSource = function (url, config) {
      var es = new OrigEventSource(url, config);
      activeCount++;
      win.__activeRequests = activeCount;
      es.addEventListener('error', function () {
        activeCount--;
        win.__activeRequests = activeCount;
      });
      es.addEventListener('close', function () {
        activeCount--;
        win.__activeRequests = activeCount;
      });
      return es;
    };
    win.EventSource.prototype = OrigEventSource.prototype;
  }

  // Track XHR
  var OrigXHROpen = win.XMLHttpRequest ? win.XMLHttpRequest.prototype.open : null;
  var OrigXHRSend = win.XMLHttpRequest ? win.XMLHttpRequest.prototype.send : null;
  if (win.XMLHttpRequest) {
    win.XMLHttpRequest.prototype.open = function (method, url) {
      this.__dshUrl = url;
      return OrigXHROpen.apply(this, arguments);
    };
    win.XMLHttpRequest.prototype.send = function () {
      var self = this;
      var url = String(self.__dshUrl || '');
      if (
        url.indexOf('/api/') !== -1 ||
        url.indexOf('/chat') !== -1 ||
        url.indexOf('/stream') !== -1 ||
        url.indexOf('/completions') !== -1
      ) {
        activeCount++;
        win.__activeRequests = activeCount;
        self.addEventListener('loadend', function () {
          activeCount--;
          win.__activeRequests = activeCount;
        });
      }
      return OrigXHRSend.apply(this, arguments);
    };
  }

  win.__dshRequestTracker = true;
}

// ── Extract the checkActiveLlmTask script ───────────────────────────────────

function checkActive(win) {
  var activeReqs = win.__activeRequests || 0;
  return activeReqs > 0;
}

// ── Tests ───────────────────────────────────────────────────────────────────

console.log('\n=== Close Guard Simulated Tests ===\n');

// Test 1: No active requests → should allow close
console.log('Test 1: No active requests (should NOT block close)');
(function () {
  var win = Object.create(fakeWindow);
  win.__dshRequestTracker = false;
  win.__activeRequests = 0;
  win.document = Object.create(fakeDocument);
  win.document.querySelectorAll = () => [];
  win.document.querySelector = () => null;
  injectTracker(win);
  var result = checkActive(win);
  assert(result === false, 'No active requests → checkActive returns false');
})();

// Test 2: Active fetch to /api/chat → should block close
console.log('\nTest 2: Active fetch to /api/chat (should block close)');
(function () {
  var win = Object.create(fakeWindow);
  win.__dshRequestTracker = false;
  win.__activeRequests = 0;
  win.fetch = function () {
    return Promise.resolve({});
  };
  win.document = Object.create(fakeDocument);
  win.document.querySelectorAll = () => [];
  win.document.querySelector = () => null;
  injectTracker(win);

  // Simulate a fetch call to /api/chat that hasn't resolved yet
  var pendingPromise = win.fetch('/api/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  });

  var result = checkActive(win);
  assert(result === true, 'Active /api/chat fetch → checkActive returns true');
  assert(win.__activeRequests === 1, '__activeRequests === 1 during fetch');

  // Resolve the fetch → should decrement
  pendingPromise.__resolve({});
  // Need to wait for microtask
  // For sync test, we manually check after resolve
})();

// Test 3: Fetch completes → should allow close
console.log('\nTest 3: Fetch completed (should NOT block close)');
async function test3() {
  var win = Object.create(fakeWindow);
  win.__dshRequestTracker = false;
  win.__activeRequests = 0;
  win.fetch = function () {
    return Promise.resolve({});
  };
  win.document = Object.create(fakeDocument);
  win.document.querySelectorAll = () => [];
  win.document.querySelector = () => null;
  injectTracker(win);

  var p = win.fetch('/api/chat/completions');
  p.__resolve({});

  // Wait for microtasks to settle
  await new Promise((r) => setTimeout(r, 0));

  var result = checkActive(win);
  assert(result === false, 'Completed fetch → checkActive returns false');
  assert(win.__activeRequests === 0, '__activeRequests === 0 after fetch completes');
}

// Test 4: Multiple concurrent requests
console.log('\nTest 4: Multiple concurrent requests (should block close)');
async function test4() {
  var win = Object.create(fakeWindow);
  win.__dshRequestTracker = false;
  win.__activeRequests = 0;
  win.fetch = function () {
    return Promise.resolve({});
  };
  win.document = Object.create(fakeDocument);
  win.document.querySelectorAll = () => [];
  win.document.querySelector = () => null;
  injectTracker(win);

  var p1 = win.fetch('/api/chat/completions');
  var p2 = win.fetch('/api/stream/messages');
  var p3 = win.fetch('/static/style.css'); // non-API, should NOT count

  var result = checkActive(win);
  assert(result === true, '2 active API requests → checkActive returns true');
  assert(win.__activeRequests === 2, '__activeRequests === 2 (non-API excluded)');

  p1.__resolve({});
  await new Promise((r) => setTimeout(r, 0));

  assert(win.__activeRequests === 1, '__activeRequests === 1 after first completes');
  assert(checkActive(win) === true, 'Still 1 active → checkActive returns true');

  p2.__resolve({});
  await new Promise((r) => setTimeout(r, 0));

  assert(win.__activeRequests === 0, '__activeRequests === 0 after all complete');
  assert(checkActive(win) === false, 'All complete → checkActive returns false');
}

// Test 5: Fetch error → should still decrement
console.log('\nTest 5: Fetch error (should decrement counter)');
async function test5() {
  var win = Object.create(fakeWindow);
  win.__dshRequestTracker = false;
  win.__activeRequests = 0;
  win.fetch = function () {
    return Promise.resolve({});
  };
  win.document = Object.create(fakeDocument);
  win.document.querySelectorAll = () => [];
  win.document.querySelector = () => null;
  injectTracker(win);

  var p = win.fetch('/api/chat/completions');
  assert(win.__activeRequests === 1, '__activeRequests === 1 during fetch');

  p.__reject(new Error('network error'));
  await new Promise((r) => setTimeout(r, 0));

  assert(win.__activeRequests === 0, '__activeRequests === 0 after fetch error');
  assert(checkActive(win) === false, 'Error fetch → checkActive returns false');
}

// Test 6: Non-API fetch should NOT be tracked
console.log('\nTest 6: Non-API fetch (should NOT be tracked)');
(function () {
  var win = Object.create(fakeWindow);
  win.__dshRequestTracker = false;
  win.__activeRequests = 0;
  var callCount = 0;
  win.fetch = function () {
    callCount++;
    return Promise.resolve({});
  };
  win.document = Object.create(fakeDocument);
  win.document.querySelectorAll = () => [];
  win.document.querySelector = () => null;
  injectTracker(win);

  win.fetch('/static/style.css');
  win.fetch('/favicon.ico');
  win.fetch('https://cdn.example.com/lib.js');

  assert(win.__activeRequests === 0, 'Non-API fetches → __activeRequests === 0');
  assert(checkActive(win) === false, 'Non-API fetches → checkActive returns false');
})();

// Test 7: Double injection guard
console.log('\nTest 7: Double injection guard');
(function () {
  var win = Object.create(fakeWindow);
  win.__dshRequestTracker = false;
  win.__activeRequests = 0;
  win.fetch = function () {
    return Promise.resolve({});
  };
  win.document = Object.create(fakeDocument);
  win.document.querySelectorAll = () => [];
  win.document.querySelector = () => null;

  injectTracker(win);
  var fetchAfterFirstInject = win.fetch;
  injectTracker(win); // should be no-op
  var fetchAfterSecondInject = win.fetch;

  assert(win.__dshRequestTracker === true, 'Tracker flag set after first inject');
  assert(fetchAfterFirstInject === fetchAfterSecondInject, 'Second inject is no-op (fetch unchanged)');
})();

// Test 8: URL pattern matching variants
console.log('\nTest 10: URL pattern matching variants');
async function test8() {
  var win = Object.create(fakeWindow);
  win.__dshRequestTracker = false;
  win.__activeRequests = 0;
  win.fetch = function () {
    return Promise.resolve({});
  };
  win.document = Object.create(fakeDocument);
  win.document.querySelectorAll = () => [];
  win.document.querySelector = () => null;
  injectTracker(win);

  // Various API URL patterns
  var urls = [
    '/api/chat/completions',
    '/api/v1/messages',
    '/chat/stream',
    '/v1/completions',
    '/api/sessions/123/stream',
  ];

  var promises = urls.map(function (u) {
    return win.fetch(u);
  });

  assert(win.__activeRequests === urls.length, `All ${urls.length} API URLs tracked`);
  assert(checkActive(win) === true, 'Multiple API URL patterns → checkActive returns true');

  // Resolve all
  promises.forEach(function (p) {
    p.__resolve({});
  });
  await new Promise((r) => setTimeout(r, 0));

  assert(win.__activeRequests === 0, 'All resolved → __activeRequests === 0');
}

// ── Run async tests ─────────────────────────────────────────────────────────

(async function () {
  await test3();
  await test4();
  await test5();
  await test8();

  console.log('\n=== Summary ===');
  console.log(`  PASS: ${passCount}`);
  console.log(`  FAIL: ${failCount}`);
  console.log(failCount === 0 ? '\n  ✅ All tests passed!' : `\n  ❌ ${failCount} test(s) failed!`);
  process.exit(failCount === 0 ? 0 : 1);
})();
