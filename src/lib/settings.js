'use strict';

/**
 * Minimal persistent settings store — pure Node, unit-testable.
 * JSON file with atomic writes (tmp + rename). No Electron dependency:
 * pass the file path explicitly (caller resolves userData).
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  /** @type {boolean} close the window → keep running in tray instead of quitting */
  closeToTray: false,
  /** @type {boolean} launch the app at Windows login */
  autoLaunch: false,
  /** @type {boolean} silently check for updates a few seconds after startup */
  checkUpdatesOnStart: true,
  /** @type {string|null} workspace directory passed as cwd to the dsh process */
  workspace: null,
};

let file = null;
let data = {};

function init(filePath) {
  file = filePath;
  load();
}

function load() {
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = {};
  }
}

/** @returns {{[k:string]: any}} merged defaults + persisted values */
function getAll() {
  return { ...DEFAULTS, ...data };
}

function get(key, fallback) {
  return Object.prototype.hasOwnProperty.call(data, key)
    ? data[key]
    : fallback !== undefined
      ? fallback
      : DEFAULTS[key];
}

function set(key, value) {
  data[key] = value;
  save();
}

function save() {
  if (!file) return;
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { DEFAULTS, init, load, getAll, get, set, save };
