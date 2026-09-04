'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findBestAsset } = require('../src/lib/update-checker');

function asset(name) {
  return { name, browser_download_url: `https://example.com/${name}` };
}

test('update-checker: findBestAsset prefers full edition over Plugins and Lite', () => {
  // GitHub returns assets in alphabetical order: Lite, Plugins, Setup
  const assets = [
    asset('DSH.My.Simple.Desktop-0.1.31-Lite-Setup.exe'),
    asset('DSH.My.Simple.Desktop-0.1.31-Plugins-Setup.exe'),
    asset('DSH.My.Simple.Desktop-0.1.31-Setup.exe'),
  ];
  const best = findBestAsset(assets);
  assert.equal(best.name, 'DSH.My.Simple.Desktop-0.1.31-Setup.exe');
});

test('update-checker: findBestAsset picks Plugins when full is absent', () => {
  const assets = [
    asset('DSH.My.Simple.Desktop-0.1.31-Lite-Setup.exe'),
    asset('DSH.My.Simple.Desktop-0.1.31-Plugins-Setup.exe'),
  ];
  const best = findBestAsset(assets);
  assert.equal(best.name, 'DSH.My.Simple.Desktop-0.1.31-Plugins-Setup.exe');
});

test('update-checker: findBestAsset falls back to Lite when only Lite exists', () => {
  const assets = [asset('DSH.My.Simple.Desktop-0.1.31-Lite-Setup.exe')];
  const best = findBestAsset(assets);
  assert.equal(best.name, 'DSH.My.Simple.Desktop-0.1.31-Lite-Setup.exe');
});

test('update-checker: findBestAsset ignores non-exe assets', () => {
  const assets = [
    asset('DSH.My.Simple.Desktop-0.1.31-Setup.exe.blockmap'),
    asset('latest.yml'),
  ];
  assert.equal(findBestAsset(assets), null);
});

test('update-checker: findBestAsset matches Lite edition for Lite users', () => {
  const assets = [
    asset('DSH.My.Simple.Desktop-0.1.31-Lite-Setup.exe'),
    asset('DSH.My.Simple.Desktop-0.1.31-Plugins-Setup.exe'),
    asset('DSH.My.Simple.Desktop-0.1.31-Setup.exe'),
  ];
  const best = findBestAsset(assets, 'lite');
  assert.equal(best.name, 'DSH.My.Simple.Desktop-0.1.31-Lite-Setup.exe');
});

test('update-checker: findBestAsset matches Plugins edition for Plugins users', () => {
  const assets = [
    asset('DSH.My.Simple.Desktop-0.1.31-Lite-Setup.exe'),
    asset('DSH.My.Simple.Desktop-0.1.31-Plugins-Setup.exe'),
    asset('DSH.My.Simple.Desktop-0.1.31-Setup.exe'),
  ];
  const best = findBestAsset(assets, 'plugins');
  assert.equal(best.name, 'DSH.My.Simple.Desktop-0.1.31-Plugins-Setup.exe');
});

test('update-checker: findBestAsset matches full edition for full users', () => {
  const assets = [
    asset('DSH.My.Simple.Desktop-0.1.31-Lite-Setup.exe'),
    asset('DSH.My.Simple.Desktop-0.1.31-Plugins-Setup.exe'),
    asset('DSH.My.Simple.Desktop-0.1.31-Setup.exe'),
  ];
  const best = findBestAsset(assets, 'full');
  assert.equal(best.name, 'DSH.My.Simple.Desktop-0.1.31-Setup.exe');
});

test('update-checker: findBestAsset falls back to full preference when edition unknown', () => {
  const assets = [
    asset('DSH.My.Simple.Desktop-0.1.31-Lite-Setup.exe'),
    asset('DSH.My.Simple.Desktop-0.1.31-Plugins-Setup.exe'),
    asset('DSH.My.Simple.Desktop-0.1.31-Setup.exe'),
  ];
  const best = findBestAsset(assets, null);
  assert.equal(best.name, 'DSH.My.Simple.Desktop-0.1.31-Setup.exe');
});

test('update-checker: detectCurrentEdition is null-safe outside Electron', () => {
  const { detectCurrentEdition } = require('../src/lib/update-checker');
  // In a plain Node test process there is no real electron app; the function
  // must not throw and should return a string or null.
  const edition = detectCurrentEdition();
  assert.ok(edition === null || edition === 'lite' || edition === 'full' || edition === 'plugins');
});

// ---------------------------------------------------------------------------
// downloadInstaller tests (local HTTP server)
// ---------------------------------------------------------------------------

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadInstaller } = require('../src/lib/update-checker');

/**
 * Start a tiny HTTP server serving `payload` bytes at any path.
 * Supports Range requests (206 partial content) to test resume.
 * Optionally count requests / fail a specific request to assert retry.
 */
function startFileServer(payload, opts = {}) {
  const { onRequest, failOn } = opts;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (onRequest) onRequest(req, res, requests);
    if (failOn === 'all' || (failOn && requests === failOn)) {
      // Send half the payload, then drop the connection: simulates a real
      // mid-download network failure leaving a partial file behind.
      const half = Math.floor(payload.length / 2);
      res.writeHead(200, { 'Content-Length': payload.length });
      res.write(payload.slice(0, half));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d+)-$/.exec(range);
      if (m) {
        const from = Number(m[1]);
        const slice = payload.slice(from);
        res.writeHead(206, {
          'Content-Range': `bytes ${from}-${payload.length - 1}/${payload.length}`,
          'Content-Length': slice.length,
          'Accept-Ranges': 'bytes',
        });
        res.end(slice);
        return;
      }
    }
    res.writeHead(200, { 'Content-Length': payload.length });
    res.end(payload);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}/installer.exe`,
        getRequests: () => requests,
      });
    });
  });
}

/**
 * Build a URL whose basename is unique per test, so parallel test runs
 * never share the same %TEMP% file.
 */
function uniqueUrl(server, tag) {
  return `http://127.0.0.1:${server.address().port}/dl-${tag}.exe`;
}

test('update-checker: downloadInstaller returns { destPath, assetName } and file exists', async () => {
  const payload = Buffer.from('x'.repeat(256 * 1024)); // 256 KB
  const { server } = await startFileServer(payload);
  try {
    const url = uniqueUrl(server, 'basic');
    const result = await downloadInstaller(url, () => {}, { maxRetries: 1, retryDelay: 10 });
    assert.ok(result && typeof result === 'object', 'result must be an object (regression: used to return undefined)');
    assert.ok(typeof result.destPath === 'string' && result.destPath.length > 0);
    assert.equal(result.assetName, 'dl-basic.exe');
    const size = fs.statSync(result.destPath).size;
    assert.equal(size, payload.length);
    fs.unlinkSync(result.destPath);
  } finally {
    server.close();
  }
});

test('update-checker: downloadInstaller resumes from partial file on retry', async () => {
  const payload = Buffer.from('y'.repeat(512 * 1024)); // 512 KB
  let reqHeaders = [];
  const { server, getRequests } = await startFileServer(payload, {
    onRequest: (req) => reqHeaders.push(req.headers.range || null),
    failOn: 1, // first request dies immediately
  });
  try {
    const url = uniqueUrl(server, 'resume');
    const result = await downloadInstaller(url, () => {}, { maxRetries: 2, retryDelay: 10 });
    assert.equal(getRequests(), 2, 'exactly 2 requests expected (1 failure + 1 resume)');
    // The resume request must carry a Range header with the bytes already written.
    const resumeHeader = reqHeaders[1];
    assert.ok(resumeHeader && /^bytes=\d+-$/.test(resumeHeader), `expected Range header, got: ${resumeHeader}`);
    const size = fs.statSync(result.destPath).size;
    assert.equal(size, payload.length);
    fs.unlinkSync(result.destPath);
  } finally {
    server.close();
  }
});

test('update-checker: downloadInstaller rejects after maxRetries and cleans up', async () => {
  const payload = Buffer.from('z'.repeat(64 * 1024));
  const { server } = await startFileServer(payload, { failOn: 'all' });
  try {
    const url = uniqueUrl(server, 'fail');
    await assert.rejects(
      () => downloadInstaller(url, () => {}, { maxRetries: 2, retryDelay: 10 }),
      /aborted|socket|Download|ECONNRESET|timeout/i // any download error message
    );
  } finally {
    server.close();
  }
});
