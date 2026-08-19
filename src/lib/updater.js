'use strict';

/**
 * Auto-update wrapper around electron-updater.
 *
 * The update feed is only enabled when DSH_DESKTOP_UPDATE_URL points at a
 * generic update server (or the packaged app ships an app-update.yml, e.g.
 * built for GitHub Releases by the CI pipeline). Without a feed, every call
 * degrades gracefully: `check()` reports a descriptive error event.
 */

const { autoUpdater } = require('electron-updater');
const log = require('electron-log/main');

let enabled = false;
const listeners = [];

function emit(type, payload) {
  for (const cb of listeners) {
    try {
      cb({ type, payload });
    } catch {
      /* a listener must never break the updater */
    }
  }
}

/** @param {{ url?: string }} opts */
function init({ url }) {
  if (!url) {
    log.info('[updater] 未配置更新源（DSH_DESKTOP_UPDATE_URL），自动更新停用');
    return;
  }
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const events = [
      'checking-for-update',
      'update-available',
      'update-not-available',
      'error',
      'download-progress',
      'update-downloaded',
    ];
    for (const ev of events) {
      autoUpdater.on(ev, (payload) => {
        // Error payloads are Error objects; serialize before forwarding.
        if (payload instanceof Error) {
          emit(ev, { message: payload.message });
        } else {
          emit(ev, payload);
        }
      });
    }
    enabled = true;
    log.info(`[updater] 更新源已启用: ${url}`);
  } catch (e) {
    log.error('[updater] init 失败', e);
  }
}

function isEnabled() {
  return enabled;
}

function check() {
  if (!enabled) {
    emit('error', {
      message: '未配置更新源（设置 DSH_DESKTOP_UPDATE_URL 或由 CI 发布）',
    });
    return;
  }
  autoUpdater.checkForUpdates().catch((e) => {
    log.error('[updater] checkForUpdates 失败', e);
    emit('error', { message: String((e && e.message) || e) });
  });
}

function quitAndInstall() {
  if (enabled) autoUpdater.quitAndInstall();
}

function onEvent(cb) {
  listeners.push(cb);
}

module.exports = { init, isEnabled, check, quitAndInstall, onEvent };
