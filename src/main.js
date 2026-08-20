'use strict';

/**
 * DeepSeek Harness Desktop — Electron main process (production build).
 *
 * Features:
 *   • spawns `dsh web` on a free port, waits for readiness, opens the GUI
 *   • Win11 native look: hidden title bar + overlay window controls, Mica
 *     background, rounded corners, follows the system dark/light theme
 *   • system tray with menu (show/hide, workspace, settings, updates, quit)
 *   • close-to-tray behaviour + launch at Windows login (--hidden)
 *   • taskbar Jump List (new session, open workspace)
 *   • auto-update via electron-updater (feed from DSH_DESKTOP_UPDATE_URL)
 *   • crash resilience: dsh child restart with backoff, renderer reload,
 *     uncaught exception logging
 *   • shell settings window (src/settings/settings.html) over IPC
 *   • single-instance lock; navigation confined to the local dsh origin
 *
 * Flags:
 *   --dev             don't spawn dsh; load DSH_DESKTOP_URL (default :3080)
 *   --smoke           print SMOKE_OK after load and exit 0 (CI smoke test)
 *   --hidden          start without showing the main window (auto-launch)
 *   --screenshot <d>  (with --smoke) save a window screenshot to <d>
 *   --jump=<action>   Jump List activation: new-session | open-workspace
 *
 * Env:
 *   DSH_DESKTOP_DSH_BIN, DSH_DESKTOP_URL, DSH_DESKTOP_WORKSPACE,
 *   DSH_DESKTOP_UPDATE_URL
 */

const {
  app,
  BrowserWindow,
  dialog,
  shell,
  Tray,
  Menu,
  nativeTheme,
  ipcMain,
} = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const log = require('electron-log/main');
const { findFreePort } = require('./lib/port');
const { resolveDshCommand } = require('./lib/dsh-resolve');
const settings = require('./lib/settings');
const updater = require('./lib/updater');
const runtimeUpdater = require('./lib/runtime-updater');

const APP_NAME = 'DSH My Simple Desktop';
const DEFAULT_PORT = 3080;
const PORT_SCAN_LIMIT = 20;
const SERVER_TIMEOUT_MS = 90_000;
const DSH_MAX_RESTARTS = 5;
const DSH_STARTUP_TIMEOUT_MS = 120_000; // 2 min for first boot (slower on some machines)
const DSH_RESTART_TIMEOUT_MS = 90_000;  // 90s for restarts
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const TRAY_ICON_PATH = path.join(__dirname, '..', 'assets', 'tray-icon.png');

const isDevMode = process.argv.includes('--dev');
const isSmoke = process.argv.includes('--smoke');
const isHiddenStart = process.argv.includes('--hidden');
const screenshotArg = (() => {
  const i = process.argv.indexOf('--screenshot');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

// Dev/smoke runs must not collide with an installed production instance:
// separate userData (single-instance lock, settings, logs, update state).
// DSH_DESKTOP_USER_DATA overrides for any mode (CI packaged smoke tests).
if (!app.isPackaged || process.env.DSH_DESKTOP_USER_DATA) {
  app.setPath(
    'userData',
    process.env.DSH_DESKTOP_USER_DATA ||
      path.join(app.getPath('appData'), 'DeepSeek Harness Desktop (dev)'),
  );
}

log.initialize();
log.transports.file.level = 'info';
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.console.level = isSmoke ? 'info' : 'warn';

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let mainWindow = null;
let settingsWindow = null;
let splashWindow = null;
let tray = null;
let dshChild = null;
let isQuitting = false;
let dshRestarts = 0;
let dshPort = null;

// ── splash / boot progress ──────────────────────────────────────────────────

/**
 * Send a progress update to the splash window (if open).
 * @param {string} status - main status text
 * @param {object} [opts]
 * @param {string} [opts.type] - '' (default), 'done', 'err'
 * @param {string} [opts.sub] - secondary text
 * @param {number} [opts.progress] - 0..100
 */
function sendSplashProgress(status, opts = {}) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash:progress', { status, ...opts });
  }
  log.info(`[boot] ${status}${opts.sub ? ' — ' + opts.sub : ''}`);
}

/**
 * Show the boot-progress splash window.
 */
function showSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) return;
  splashWindow = new BrowserWindow({
    width: 480,
    height: 320,
    resizable: false,
    frame: false,
    transparent: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff',
    center: true,
    show: false,
    title: APP_NAME,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash', 'splash.html'));
  splashWindow.once('ready-to-show', () => { splashWindow.show(); });
  splashWindow.on('closed', () => { splashWindow = null; });
  // prevent accidental close
  splashWindow.on('close', (e) => { if (!isQuitting) e.preventDefault(); });
}

/**
 * Close the splash window and allow normal window operations.
 */
function closeSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.destroy();
    splashWindow = null;
  }
}

/**
 * Detect whether a working `dsh` command is available on the host system
 * (via PATH). Returns true if `dsh.cmd` (or `dsh` on POSIX) can be found.
 */
function detectSystemDsh() {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const cmd = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
    const r = require('node:child_process').spawnSync(which, [cmd], {
      stdio: 'pipe',
      windowsHide: true,
    });
    return r.status === 0 && r.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

function initSettings() {
  const file = path.join(app.getPath('userData'), 'settings.json');
  settings.init(file);
  log.info(`settings: ${file}`);
}

/**
 * Ensure $DSH_HOME exists.
 *
 * DSH_HOME is the dsh *data* directory (sessions, plugins, credentials).
 * We always point it at the standard %USERPROFILE%\.dsh so that:
 *   - with a system dsh, plugins/skills installed via `dsh install skill`
 *     are visible in the desktop app too (inherits the same default);
 *   - with the bundled user-level environment, data lives in exactly the
 *     same place the CLI would use, so sessions follow the user across
 *     environments.
 */
function ensureDshHome(hasSystemDsh) {
  if (process.env.DSH_HOME) {
    // User explicitly set it — always respect that.
    log.info(`DSH_HOME already set: ${process.env.DSH_HOME}`);
  } else if (hasSystemDsh) {
    // System dsh is available — don't override DSH_HOME.
    // The process will inherit the system default (%USERPROFILE%\.dsh).
    log.info('system dsh detected — DSH_HOME not overridden, inheriting system default');
  } else {
    // Bundled user-level environment: use the same standard location so the
    // CLI (added to PATH) and the desktop app share data.
    const dshHome = path.join(os.homedir(), '.dsh');
    process.env.DSH_HOME = dshHome;
    log.info(`DSH_HOME set to: ${dshHome}`);
  }

  // Ensure the directory exists.
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  try {
    fs.mkdirSync(dshHome, { recursive: true });
    const profilesDir = path.join(dshHome, 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
  } catch (err) {
    log.warn(`ensureDshHome: could not create DSH_HOME (${err.message})`);
  }
}

/** The user-level dsh environment dir (independent of the app install). */
function dshEnvDir() {
  return path.join(os.homedir(), '.dsh-desktop');
}

function workspaceDir() {
  return settings.get('workspace') || process.env.DSH_DESKTOP_WORKSPACE || os.homedir();
}

// ---------------------------------------------------------------------------
// dsh child process
// ---------------------------------------------------------------------------

function killDshTree() {
  if (dshPort) {
    log.info(`stopping dsh child on port ${dshPort} (tree)`);
    // Find and kill the process listening on our port — most reliable way
    // on Windows, since the child may have been detached from dshChild.
    if (process.platform === 'win32') {
      const { execSync } = require('node:child_process');
      try {
        // netstat -ano finds PID listening on dshPort
        const netstatOut = execSync(
          `netstat -ano | findstr "127.0.0.1:${dshPort}"`,
          { encoding: 'utf-8', timeout: 5000, windowsHide: true },
        );
        const lines = netstatOut.split('\n').filter(l => l.includes('LISTENING'));
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== '0') {
            try {
              execSync(`taskkill /PID ${pid} /T /F`, {
                stdio: 'ignore', timeout: 3000, windowsHide: true,
              });
              log.info(`killed pid ${pid} (port ${dshPort})`);
            } catch (e) {
              log.warn(`failed to kill pid ${pid}: ${e.message}`);
            }
          }
        }
      } catch (e) {
        log.warn(`netstat lookup failed: ${e.message}`);
      }
    }
  }

  // Also try the standard child-process kill as a fallback
  if (dshChild && !dshChild.killed) {
    log.info('fallback: killing dshChild directly');
    try {
      if (process.platform === 'win32' && dshChild.pid) {
        spawn('taskkill', ['/pid', String(dshChild.pid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true,
        });
      } else {
        dshChild.kill('SIGKILL');
      }
    } catch { dshChild.kill(); }
  }

  dshChild = null;
  dshPort = null;
}

/**
 * Healthy-url check: attempts a HEAD / to confirm the server is alive.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForHealthyUrl(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const startTime = Date.now();
    let lastErrMsg = '';
    let retryCount = 0;
    const tryOnce = () => {
      retryCount++;
      // Update splash every ~2s with a pseudo-progress
      const elapsed = Date.now() - startTime;
      const pct = Math.min(50 + Math.round((elapsed / timeoutMs) * 35), 85);
      if (retryCount % 5 === 0) {
        sendSplashProgress('正在启动 DSH 引擎…', {
          sub: `等待服务就绪（${Math.round(elapsed / 1000)}s / ${Math.round(timeoutMs / 1000)}s）`,
          progress: pct,
        });
      }
      const req = http.get(
        { host: '127.0.0.1', port, path: '/', timeout: 3000 },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on('timeout', () => {
        req.destroy();
        lastErrMsg = '连接超时';
        scheduleRetry();
      });
      req.on('error', (err) => {
        req.destroy();
        lastErrMsg = err.message;
        scheduleRetry();
      });
      function scheduleRetry() {
        if (Date.now() > deadline) {
          reject(new Error(`dsh 服务在 ${Math.round(timeoutMs / 1000)}s 内未就绪（端口 ${port}）：${lastErrMsg}`));
        } else {
          setTimeout(tryOnce, 400);
        }
      }
    };
    tryOnce();
  });
}

function startDsh(port, preferSystem) {
  const resolved = resolveDshCommand({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    preferSystem: preferSystem === true,
    envDir: dshEnvDir(),
  });
  const cmd = resolved.cmd;
  // --no-open prevents the system dsh CLI from auto-opening a browser.
  // Only the system dsh (rc7+) supports this flag; the bundled rc6 does not
  // and will crash with "unknown option" if it receives it. The bundled dsh
  // never auto-opens a browser anyway, so we only add --no-open when using
  // the system dsh (preferSystem = true).
  const noOpenFlag = preferSystem ? ['--no-open'] : [];
  // Support both resolved.args (bundled: [node, bin.js]) and legacy {cmd, needsShell}
  const args = resolved.args
    ? [...resolved.args, '--profile', 'web', '--port', String(port), ...noOpenFlag]
    : ['--profile', 'web', '--port', String(port), ...noOpenFlag];
  const needsShell = resolved.needsShell || false;
  const cwd = workspaceDir();
  log.info(`spawning: ${cmd} ${args.join(' ')}  (cwd: ${cwd})`);

  const child = spawn(cmd, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: needsShell,
    windowsHide: true,
  });
  dshChild = child;
  dshPort = port;

  // Collect early stderr output for diagnostics on startup failure
  let earlyStderr = '';
  const earlyStderrMax = 4096;
  const stderrListener = (d) => {
    const s = String(d);
    if (earlyStderr.length < earlyStderrMax) {
      earlyStderr += s.slice(0, earlyStderrMax - earlyStderr.length);
    }
    log.warn(`[dsh-err] ${s.trimEnd()}`);
  };
  child.stderr.on('data', stderrListener);
  child.stdout.on('data', (d) => log.info(`[dsh] ${String(d).trimEnd()}`));

  child.on('exit', (code, signal) => {
    const wasChild = dshChild === child;
    dshChild = null;
    dshPort = null;

    // Remove the stderr listener once the process is gone
    child.stderr.removeListener('data', stderrListener);

    const exitInfo = `code=${code}, signal=${signal}`;
    log.info(`dsh exited (${exitInfo})`);

    if (isQuitting || isSmoke || !wasChild) return;

    // Build a diagnostics message from early stderr if available
    let diagnostic = '';
    if (earlyStderr.length > 0) {
      // Trim to last ~500 chars for a concise error reason
      const tail = earlyStderr.slice(-500).trim();
      diagnostic = tail ? `：${tail}` : '';
    }

    if (code === 0) {
      // Clean exit (e.g. server asked to stop) — nothing to restart.
      app.quit();
      return;
    }

    // Crash: restart with backoff (1s, 2s, 4s, 8s, 16s → give up).
    // 首次启动超时时间更长，后续重启用较短超时
    const isFirstBoot = !mainWindow;
    const startupTimeout = isFirstBoot ? DSH_STARTUP_TIMEOUT_MS : DSH_RESTART_TIMEOUT_MS;

    if (dshRestarts < DSH_MAX_RESTARTS) {
      dshRestarts += 1;
      const delay = Math.min(2 ** (dshRestarts - 1), 16) * 1000;
      log.warn(`dsh crashed (${exitInfo}); restart ${dshRestarts}/${DSH_MAX_RESTARTS} in ${delay}ms${diagnostic}`);
      sendSplashProgress('DSH 引擎正在重启…', {
        sub: `第 ${dshRestarts}/${DSH_MAX_RESTARTS} 次重启（${Math.round(delay / 1000)}s 后）`,
        progress: 50 + Math.round((dshRestarts / DSH_MAX_RESTARTS) * 30),
        type: 'warn',
      });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:event', {
          type: 'dsh-restarting',
          payload: { attempt: dshRestarts, max: DSH_MAX_RESTARTS, delay, diagnostic: earlyStderr.slice(-300) },
        });
      }
      setTimeout(() => {
        if (isQuitting) return;
        bootstrapDsh(startupTimeout).catch((err) => {
          log.error('dsh restart failed', err);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('app:event', {
              type: 'dsh-fatal',
              payload: { message: String(err.message || err) },
            });
          }
        });
      }, delay);
    } else {
      log.error(`dsh keeps crashing; giving up${diagnostic}`);
      const detail = earlyStderr.length > 0
        ? `\n\n最后一次崩溃的 stderr 输出（末尾）：\n${earlyStderr.slice(-500)}`
        : '';
      dialog.showErrorBox(
        APP_NAME,
        `dsh web 进程连续崩溃（${DSH_MAX_RESTARTS} 次），请检查日志。${detail}`,
      );
      app.quit();
    }
  });
  return child;
}

/** Pick a free port, spawn dsh, wait for readiness. Returns the URL. */
async function bootstrapDsh(preferSystem, timeoutMs) {
  const port = await findFreePort(DEFAULT_PORT, PORT_SCAN_LIMIT);
  if (port === null) {
    throw new Error(
      `端口 ${DEFAULT_PORT}~${DEFAULT_PORT + PORT_SCAN_LIMIT} 均被占用，无法启动`,
    );
  }
  startDsh(port, preferSystem);
  await waitForHealthyUrl(port, timeoutMs || SERVER_TIMEOUT_MS);
  return `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------------------
// window chrome (Win11 look & theme following)
// ---------------------------------------------------------------------------
//
// IMPORTANT (verified by DOM probe): the dsh SPA's top toolbar (model
// selector, mode switcher…) sits at y≈0..40 across the full width. A hidden
// title bar with overlay window controls would cover those interactive
// elements. Production therefore uses the native Windows title bar (Win11
// rounded corners, system dark/light title bar, zero overlap risk).

function applyChromeTheme() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('theme:changed', {
      dark: nativeTheme.shouldUseDarkColors,
    });
  }
}

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    icon: ICON_PATH,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
    // NOTE: do NOT set backgroundMaterial:'mica' — on Electron 33 + Win11 it
    // flips isMaximizable() to false (greyed-out maximize button), verified by
    // A/B probe. Win11's native title bar already applies its own mica, so
    // there is no visible loss.
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!isHiddenStart) mainWindow.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // close-to-tray / quit behaviour
  mainWindow.on('close', (e) => {
    if (isQuitting || isSmoke) return;
    if (settings.get('closeToTray', false)) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // stay inside the dsh origin; anything else goes to the system browser
  mainWindow.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) {
      e.preventDefault();
      openExternalSafe(target);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternalSafe(target);
    return { action: 'deny' };
  });

  // crash resilience: reload once on renderer crash
  let rendererReloaded = false;
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error(`renderer gone (${details.reason})`);
    if (!rendererReloaded && !isQuitting) {
      rendererReloaded = true;
      mainWindow.webContents.reload();
    }
  });

  // Inject a floating "📖 教程" button into the dsh SPA once it finishes loading.
  // The preload script exposes dshDesktop.app.openGuide() to the page.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      (function() {
        // Avoid duplicate injection on reload
        if (document.getElementById('dsh-desktop-guide-btn')) return;

        var btn = document.createElement('button');
        btn.id = 'dsh-desktop-guide-btn';
        btn.textContent = '📖 教程';
        btn.title = '打开模型配置教程';
        Object.assign(btn.style, {
          position: 'fixed',
          zIndex: '99999',
          right: '16px',
          bottom: '16px',
          padding: '6px 14px',
          fontSize: '13px',
          fontWeight: '600',
          fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
          background: 'rgba(77, 107, 254, 0.85)',
          color: '#fff',
          border: 'none',
          borderRadius: '8px',
          cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          backdropFilter: 'blur(4px)',
          WebkitAppRegion: 'no-drag',
          transition: 'opacity 0.2s, transform 0.2s',
          opacity: '0.85',
        });
        btn.onmouseenter = function() { this.style.opacity = '1'; this.style.transform = 'scale(1.05)'; };
        btn.onmouseleave = function() { this.style.opacity = '0.85'; this.style.transform = 'scale(1)'; };
        btn.onclick = function() {
          if (window.dshDesktop && window.dshDesktop.app && window.dshDesktop.app.openGuide) {
            window.dshDesktop.app.openGuide();
          }
        };
        document.body.appendChild(btn);

        // Re-apply after SPA navigation (dsh SPA uses client-side routing)
        var observer = new MutationObserver(function() {
          if (!document.getElementById('dsh-desktop-guide-btn')) {
            document.body.appendChild(btn);
          }
        });
        observer.observe(document.body, { childList: true, subtree: false });
      })();
    `).catch(function(err) {
      // ignore injection errors (e.g. restricted context)
      log.warn('[inject] guide button injection failed: ' + err.message);
    });
  });

  mainWindow.loadURL(url);
  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openExternalSafe(target) {
  try {
    if (/^https?:\/\//.test(target)) shell.openExternal(target);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------

function buildTrayMenu() {
  const visible = !!(mainWindow && mainWindow.isVisible());
  return Menu.buildFromTemplate([
    {
      label: visible ? '隐藏主窗口' : '显示主窗口',
      click: () => (visible ? mainWindow.hide() : showMainWindow()),
    },
    { type: 'separator' },
    {
      label: '打开工作区',
      click: () => shell.openPath(workspaceDir()),
    },
    {
      label: '设置…',
      click: () => openSettingsWindow(),
    },
    {
      label: '检查更新…',
      click: () => updater.check(),
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: settings.get('autoLaunch', false),
      click: (item) => {
        settings.set('autoLaunch', item.checked);
        applyAutoLaunch();
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  tray = new Tray(TRAY_ICON_PATH);
  tray.setToolTip(APP_NAME);
  tray.on('click', () => tray.popUpContextMenu(buildTrayMenu()));
  tray.on('double-click', () => showMainWindow());
}

// ---------------------------------------------------------------------------
// auto launch (Windows login)
// ---------------------------------------------------------------------------

function applyAutoLaunch() {
  const openAtLogin = settings.get('autoLaunch', false);
  log.info(`auto-launch: ${openAtLogin}`);
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin,
      path: process.execPath,
      args: ['--hidden'],
    });
  }
}

// ---------------------------------------------------------------------------
// jump list (taskbar)
// ---------------------------------------------------------------------------

function setupJumpList() {
  if (!app.isPackaged) return; // dev: execPath is electron.exe — meaningless
  const tasks = [
    {
      program: process.execPath,
      arguments: '--jump=new-session',
      title: '新建会话',
      description: '打开一个全新会话',
      iconPath: process.execPath,
      iconIndex: 0,
    },
    {
      program: process.execPath,
      arguments: '--jump=open-workspace',
      title: '打开工作区',
      description: '打开工作区目录',
      iconPath: process.execPath,
      iconIndex: 0,
    },
  ];
  app.setUserTasks(tasks);
}

// ---------------------------------------------------------------------------
// settings window
// ---------------------------------------------------------------------------

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 620,
    minWidth: 420,
    minHeight: 520,
    title: '设置 — ' + APP_NAME,
    icon: ICON_PATH,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings', 'settings.html'));
}

/**
 * Open the model configuration guide window (help/modal).
 */
function openGuideWindow() {
  const win = new BrowserWindow({
    width: 700,
    height: 800,
    minWidth: 500,
    minHeight: 500,
    title: '模型配置教程 — ' + APP_NAME,
    icon: ICON_PATH,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'help', 'model-guide.html'));
}

// ---------------------------------------------------------------------------
// CLI / jump-list actions
// ---------------------------------------------------------------------------

function handleCliArgs(argv) {
  const args = argv || process.argv;
  if (args.includes('--jump=new-session')) {
    showMainWindow();
  }
  if (args.includes('--jump=open-workspace')) {
    shell.openPath(workspaceDir());
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('settings:get', () => settings.getAll());
  ipcMain.handle('settings:set', (_e, key, value) => {
    settings.set(key, value);
    if (key === 'autoLaunch') applyAutoLaunch();
    return settings.getAll();
  });
  ipcMain.handle('settings:choose-workspace', async () => {
    const win = settingsWindow || mainWindow;
    const result = await dialog.showOpenDialog(win, {
      title: '选择工作区目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!result.canceled && result.filePaths[0]) {
      settings.set('workspace', result.filePaths[0]);
    }
    return settings.get('workspace', null);
  });
  ipcMain.handle('shell:open-log-dir', () => {
    shell.openPath(path.dirname(log.transports.file.getFile().path));
  });
  ipcMain.handle('shell:open-workspace', () => shell.openPath(workspaceDir()));
  ipcMain.handle('updater:check', () => updater.check());
  ipcMain.handle('app:quit', () => {
    isQuitting = true;
    app.quit();
  });
  ipcMain.handle('app:info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
    updateEnabled: updater.isEnabled(),
    updateUrl: process.env.DSH_DESKTOP_UPDATE_URL || null,
  }));
  ipcMain.handle('app:log', (_e, level, message) => {
    const fn = typeof log[level] === 'function' ? log[level] : log.info;
    fn(`[renderer] ${message}`);
  });
  ipcMain.handle('app:open-guide', () => openGuideWindow());
}

// ---------------------------------------------------------------------------
// smoke mode helpers
// ---------------------------------------------------------------------------

async function runSmoke(url) {
  // optional screenshot for visual verification
  if (screenshotArg) {
    try {
      await new Promise((r) => setTimeout(r, 3000)); // let the SPA settle
      const image = await mainWindow.webContents.capturePage();
      const outDir = path.resolve(screenshotArg);
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, 'window.png');
      fs.writeFileSync(file, image.toPNG());
      console.log(`SMOKE_SCREENSHOT ${file}`);
    } catch (e) {
      console.error(`SMOKE_SCREENSHOT_FAIL ${e.message}`);
    }
  }

  // optional DOM probe: reports the top bar layout so CI can check whether a
  // hidden title bar + overlay controls would cover interactive SPA elements.
  if (process.env.DSH_DESKTOP_PROBE === '1') {
    try {
      console.log(`SMOKE_WIN ${JSON.stringify({
        maximizable: mainWindow.isMaximizable(),
        resizable: mainWindow.isResizable(),
        maximized: mainWindow.isMaximized(),
        fullscreenable: mainWindow.isFullScreenable(),
        minSize: mainWindow.getMinimumSize(),
        maxSize: mainWindow.getMaximumSize(),
      })}`);
    } catch (e) {
      console.error(`SMOKE_WIN_FAIL ${e.message}`);
    }
    try {
      const info = await mainWindow.webContents.executeJavaScript(`(() => {
        const r = (el) => el ? { tag: el.tagName, cls: (el.className||'').toString().slice(0,80), role: el.getAttribute('role'), text: (el.textContent||'').trim().slice(0,40) } : null;
        const pts = [[window.innerWidth-140, 20], [window.innerWidth-60, 20], [window.innerWidth-140, 60], [40, 20]];
        const els = {};
        for (const [x, y] of pts) els[x+','+y] = r(document.elementFromPoint(x, y));
        let header = null;
        const cand = document.querySelector('header, [class*="header"], [class*="topbar"], [class*="titlebar"], [class*="navbar"]');
        if (cand) { const b = cand.getBoundingClientRect(); header = { tag: cand.tagName, top: Math.round(b.top), height: Math.round(b.height) }; }
        return {
          title: document.title,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          bodyPadTop: getComputedStyle(document.body).paddingTop,
          htmlPadTop: getComputedStyle(document.documentElement).paddingTop,
          viewport: [window.innerWidth, window.innerHeight],
          elementsAtPoints: els,
          header,
          appRoot: !!document.querySelector('#app, [data-root], #root'),
        };
      })()`);
      console.log(`SMOKE_PROBE ${JSON.stringify(info)}`);
    } catch (e) {
      console.error(`SMOKE_PROBE_FAIL ${e.message}`);
    }
  }

  // optional settings-window check: open it, verify IPC-driven UI, screenshot
  if (process.env.DSH_DESKTOP_PROBE === '1') {
    try {
      openSettingsWindow();
      const sw = settingsWindow;
      await new Promise((resolve, reject) => {
        if (!sw || sw.isDestroyed()) return reject(new Error('设置窗口未创建'));
        sw.webContents.once('did-finish-load', () => setTimeout(resolve, 800));
        setTimeout(() => reject(new Error('设置窗口加载超时')), 15_000);
      });
      const st = await sw.webContents.executeJavaScript(`(() => {
        const val = (id) => { const el = document.getElementById(id); return el ? el.textContent : null; };
        const chk = (id) => { const el = document.getElementById(id); return el ? el.checked : null; };
        return {
          title: document.title,
          appMeta: val('appMeta'),
          workspace: val('workspace'),
          closeToTray: chk('closeToTray'),
          autoLaunch: chk('autoLaunch'),
          updateStatus: val('updateStatus'),
        };
      })()`);
      console.log(`SMOKE_SETTINGS ${JSON.stringify(st)}`);
      if (screenshotArg) {
        const image = await sw.webContents.capturePage();
        fs.writeFileSync(
          path.join(path.resolve(screenshotArg), 'settings.png'),
          image.toPNG(),
        );
        console.log(`SMOKE_SETTINGS_SCREENSHOT ${path.join(path.resolve(screenshotArg), 'settings.png')}`);
      }
      sw.destroy();
    } catch (e) {
      console.error(`SMOKE_SETTINGS_FAIL ${e.message}`);
    }
  }

  console.log('SMOKE_OK');
  killDshTree();
  setTimeout(() => app.exit(0), 300);
}

// ---------------------------------------------------------------------------
// app lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    handleCliArgs(argv);
    showMainWindow();
  });

  app.whenReady().then(async () => {
    initSettings();

    // Determine whether system dsh is available early, so DSH_HOME can
    // be left at the system default when system dsh is used (preserving
    // plugins/skills installed via `dsh install skill`).
    const hasSystemDsh = detectSystemDsh();
    ensureDshHome(hasSystemDsh);

    log.info(`=== ${APP_NAME} ${app.getVersion()} starting (packaged=${app.isPackaged}) ===`);
    log.info(`electron ${process.versions.electron} / node ${process.versions.node} / platform ${process.platform}`);

    registerIpc();

    const targetUrl = process.env.DSH_DESKTOP_URL || `http://127.0.0.1:${DEFAULT_PORT}`;

    if (isDevMode) {
      log.info(`DEV mode: loading ${targetUrl} without spawning dsh`);
      createMainWindow(targetUrl);
      if (isSmoke) {
        mainWindow.webContents.once('did-finish-load', () => runSmoke(targetUrl));
      }
      return;
    }

    // ── production path: splash → deploy → bootstrap ─────────────────────
    showSplashWindow();
    sendSplashProgress('正在初始化…', { sub: '准备启动环境', progress: 5 });
    await new Promise((r) => setTimeout(r, 200));

    // 步骤 1：检测环境
    sendSplashProgress('正在检测 DSH 环境…', { sub: '检查系统是否已安装 DSH', progress: 15 });
    await new Promise((r) => setTimeout(r, 300));

    const resourcesPath = app.isPackaged ? process.resourcesPath : null;

    // 如果有内置运行时，检查是否可以安装到用户级环境（没有系统 dsh 时才需要）
    const bundledDshAvailable = (() => {
      if (!resourcesPath) return false;
      const nodeExe = path.join(resourcesPath, 'dsh', 'node.exe');
      const dshBin = path.join(
        resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
      );
      return fs.existsSync(nodeExe) && fs.existsSync(dshBin);
    })();

    let dshSource;

    if (!hasSystemDsh && !bundledDshAvailable) {
      // ── 没有系统 DSH，也没有内置运行时 → 错误 ──────────────
      sendSplashProgress('未找到 DSH 环境', { type: 'err', sub: '系统未安装 DSH，且本安装包未携带内置引擎', progress: 30 });
      closeSplashWindow();
      dialog.showErrorBox(APP_NAME,
        '未找到 DSH 运行环境。\n\n' +
        '请安装 DeepSeek Harness（dsh），或改用包含内置 DSH 引擎的完整版安装包。',
      );
      app.exit(1);
      return;
    }

    // ── 始终部署内置运行时到用户级环境（.dsh-desktop/）──────────────
    // 设计目标：无论用户有没有系统 dsh，都把内置 node+dsh 部署到
    // %USERPROFILE%\.dsh-desktop\，并加入 PATH，这样：
    //   1. cmd 里始终可用 `dsh` 命令（install plugin / update 等）
    //   2. 有系统 dsh 时优先用系统版本启动（保留用户插件/技能）
    //   3. 无系统 dsh 时用 .dsh-desktop/ 版本启动
    //   4. .dsh-desktop/ 始终可用作 fallback
    if (bundledDshAvailable) {
      dshSource = hasSystemDsh ? 'system' : 'bundled';
      const envDir = dshEnvDir();

      const runtimeNodeExe = runtimeUpdater.ensureRuntime({ envDir, resourcesPath });
      if (runtimeNodeExe) {
        sendSplashProgress('检测到 DSH 环境', { sub: '已就绪，直接启动', progress: 35 });
      } else {
        sendSplashProgress('正在安装 DSH 环境', { sub: '将内置引擎安装到用户目录，请稍候…', progress: 30 });
        await new Promise((r) => setTimeout(r, 100));

        sendSplashProgress('正在安装 DSH 环境（首次安装）', { sub: '复制运行时文件…', progress: 30 });

        const deployed = runtimeUpdater.ensureRuntime({ envDir, resourcesPath });
        if (!deployed) {
          log.warn('user-level env install failed, will use bundled resources directly');
          sendSplashProgress('使用内置引擎', { sub: '直接运行安装包中的 DSH', progress: 35 });
        } else {
          sendSplashProgress('DSH 环境安装完成', { type: 'done', sub: '准备启动', progress: 35 });
        }
      }

      // 无论首次安装还是已存在，都确保 CLI shim 和 PATH 可用
      if (runtimeUpdater.ensureRuntime({ envDir, resourcesPath })) {
        runtimeUpdater.installShim(envDir);
        runtimeUpdater.addEnvDirToPath(envDir);
      }

      if (hasSystemDsh) {
        sendSplashProgress('检测到系统 DSH', { type: 'done', sub: '优先使用系统版本（保留插件/技能）', progress: 35 });
      }
    } else {
      // 有系统 dsh 但无内置运行时（精简版安装包）
      dshSource = 'system';
      sendSplashProgress('检测到系统 DSH', { type: 'done', sub: '使用系统已安装版本', progress: 35 });
    }

    // 步骤 2：准备数据目录
    sendSplashProgress('正在准备数据目录…', { progress: 40 });

    // 步骤 3：启动 DSH web 服务
    sendSplashProgress('正在启动 DSH 引擎…', { sub: '启动 Web 服务，请稍候', progress: 50 });

    let appUrl = null;
    try {
      if (hasSystemDsh) {
        // 优先用系统 DSH
        sendSplashProgress('正在启动系统 DSH…', { sub: '使用系统已安装版本', progress: 55 });
        appUrl = await bootstrapDsh(true); // preferSystem = true
        log.info(`dsh web ready at ${appUrl} (system dsh)`);
      } else {
        appUrl = await bootstrapDsh(false);
        log.info(`dsh web ready at ${appUrl} (bundled dsh)`);
      }
      sendSplashProgress('DSH 引擎已就绪', { type: 'done', sub: '正在打开界面…', progress: 90 });
    } catch (err) {
      // 如果系统 DSH 启动失败，回退到内置 DSH（如果有的话）
      if (hasSystemDsh && bundledDshAvailable) {
        log.warn(`系统 DSH 启动失败，回退到内置 DSH: ${err.message}`);
        dshSource = 'bundled';
        sendSplashProgress('系统 DSH 未就绪，正在切换到内置引擎…', {
          type: 'warn',
          sub: '尝试使用安装包自带的 DSH',
          progress: 50,
        });
        try {
          killDshTree();
          appUrl = await bootstrapDsh(false);
          log.info(`dsh web ready at ${appUrl} (bundled dsh, after system fallback)`);
          sendSplashProgress('DSH 引擎已就绪（内置引擎）', { type: 'done', sub: '正在打开界面…', progress: 90 });
        } catch (err2) {
          log.error('bundled dsh also failed after system fallback', err2);
          closeSplashWindow();
          killDshTree();
          if (isSmoke) {
            console.error(`SMOKE_FAIL ${err2.message}`);
            app.exit(1);
          } else {
            dialog.showErrorBox(APP_NAME,
              `DSH 服务启动失败。\n\n系统 DSH 和内置 DSH 均无法启动。\n\n${err2.message || err2}`,
            );
            app.exit(1);
          }
          return;
        }
      } else {
        log.error('bootstrap failed', err);
        closeSplashWindow();
        killDshTree();
        if (isSmoke) {
          console.error(`SMOKE_FAIL ${err.message}`);
          logPortInfo();
          app.exit(1);
        } else {
          dialog.showErrorBox(APP_NAME, `DSH 服务启动失败。\n\n${err.message || err}`);
          app.exit(1);
        }
        return;
      }
    }

    // 步骤 4：创建主窗口
    createMainWindow(appUrl);
    dshRestarts = 0;
    // 主窗口就绪后延迟关闭 splash，让用户能看到 splash 完成态
    mainWindow.once('ready-to-show', () => {
      // 先更新 splash 为完成状态，1.5 秒后再关闭
      sendSplashProgress('启动完成！', { type: 'done', progress: 100 });
      setTimeout(() => { closeSplashWindow(); }, 1500);
    });

    if (isSmoke) {
      const watchdog = setTimeout(() => {
        console.error('SMOKE_TIMEOUT');
        killDshTree();
        app.exit(1);
      }, 150_000);
      mainWindow.webContents.once('did-finish-load', async () => {
        try {
          await runSmoke(appUrl);
        } finally {
          clearTimeout(watchdog);
        }
      });
      return;
    }

    // non-smoke, non-dev: desktop integrations
    handleCliArgs(process.argv);
    createTray();
    setupJumpList();
    applyAutoLaunch();
    if (process.env.DSH_DESKTOP_UPDATE_URL) {
      updater.init({ url: process.env.DSH_DESKTOP_UPDATE_URL });
    }
    updater.onEvent((ev) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:event', ev);
      }
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('updater:event', ev);
      }
    });
    if (settings.get('checkUpdatesOnStart', true)) {
      setTimeout(() => updater.check(), 30_000);
    }

    // Background check for dsh environment updates (non-blocking)
    runtimeUpdater.checkForUpdates({ envDir: dshEnvDir() });

    // Also try to auto-update the electron app (desktop auto-updater)
    // already handled above via updater.check()
  });

  nativeTheme.on('updated', applyChromeTheme);

  app.on('window-all-closed', () => {
    if (!isQuitting && settings.get('closeToTray', false)) return; // keep tray alive
    app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    killDshTree();
    if (tray) tray.destroy();
  });

  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', err);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', reason);
  });
}
