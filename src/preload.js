'use strict';

/**
 * Preload script: exposes a minimal, read-only bridge to renderers.
 * Used by the dsh SPA window, the shell settings window, and the splash window.
 */

const { contextBridge, ipcRenderer } = require('electron');

// ── Splash window bridge ───────────────────────────────────────────────────
contextBridge.exposeInMainWorld('electronAPI', {
  onSplashProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('splash:progress', handler);
    return () => ipcRenderer.removeListener('splash:progress', handler);
  },
});

// ── Main window / settings window bridge ───────────────────────────────────
contextBridge.exposeInMainWorld('dshDesktop', {
  platform: process.platform,
  appName: 'DSH My Simple Desktop',
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  settings: {
    getAll: () => ipcRenderer.invoke('settings:get'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    chooseWorkspace: () => ipcRenderer.invoke('settings:choose-workspace'),
    openLogDir: () => ipcRenderer.invoke('shell:open-log-dir'),
    openWorkspace: () => ipcRenderer.invoke('shell:open-workspace'),
  },

  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    onEvent: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('updater:event', handler);
      return () => ipcRenderer.removeListener('updater:event', handler);
    },
  },

  app: {
    info: () => ipcRenderer.invoke('app:info'),
    quit: () => ipcRenderer.invoke('app:quit'),
    onEvent: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('app:event', handler);
      return () => ipcRenderer.removeListener('app:event', handler);
    },
    /** Log a message to the Electron main process log */
    log: (level, message) => ipcRenderer.invoke('app:log', level, message),
    /** Open the model configuration guide window */
    openGuide: () => ipcRenderer.invoke('app:open-guide'),
  },

  theme: {
    onChanged: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('theme:changed', handler);
      return () => ipcRenderer.removeListener('theme:changed', handler);
    },
  },

  usage: {
    getStats: (granularity, range) =>
      ipcRenderer.invoke('usage:get-stats', granularity, range),
  },
});
