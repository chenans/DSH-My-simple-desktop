'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const settings = require('../src/lib/settings');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-settings-'));
  return path.join(dir, 'settings.json');
}

test('settings: defaults when file is missing', () => {
  const file = tmpFile();
  settings.init(file);
  assert.equal(settings.get('closeToTray'), false);
  assert.equal(settings.get('autoLaunch'), false);
  assert.equal(settings.get('checkUpdatesOnStart'), true);
  assert.equal(settings.get('workspace'), null);
  assert.equal(settings.get('nope', 'fallback'), 'fallback');
});

test('settings: set → get roundtrip persists to disk (atomic write)', () => {
  const file = tmpFile();
  settings.init(file);
  settings.set('closeToTray', true);
  settings.set('workspace', 'C:\\work');
  assert.equal(settings.get('closeToTray'), true);
  assert.equal(settings.get('workspace'), 'C:\\work');

  // re-init from disk (simulates app restart)
  settings.init(file);
  assert.equal(settings.get('closeToTray'), true);
  assert.equal(settings.get('workspace'), 'C:\\work');
  // defaults still merge
  assert.equal(settings.get('autoLaunch'), false);
  assert.equal(settings.getAll().checkUpdatesOnStart, true);
});

test('settings: corrupt file falls back to defaults', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'not json {{{');
  settings.init(file);
  assert.equal(settings.get('closeToTray'), false);
  settings.set('autoLaunch', true); // must still be writable
  assert.equal(settings.get('autoLaunch'), true);
});

test('settings: no tmp files left behind', () => {
  const file = tmpFile();
  settings.init(file);
  settings.set('autoLaunch', true);
  const dir = path.dirname(file);
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
