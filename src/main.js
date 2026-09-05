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
const updateChecker = require('./lib/update-checker');
const runtimeUpdater = require('./lib/runtime-updater');
const pluginDeployer = require('./lib/plugin-deployer');
const usageStats = require('./lib/usage-stats');

const APP_NAME = 'DSH My Simple Desktop';
const DEFAULT_PORT = 3080;
const PORT_SCAN_LIMIT = 20;
const SERVER_TIMEOUT_MS = 90_000;
const DSH_STARTUP_TIMEOUT_MS = 120_000; // 2 min for first boot (slower on some machines)
const APP_MAX_RELAUNCHES = 3; // 整应用重启上限，防死循环
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
let _downloadState = null;
// 跨实例计数（通过 CLI 参数 --relaunch-count=N 传递，env 在 Windows 上不可靠）
let appRelaunches = (() => {
  const i = process.argv.indexOf('--relaunch-count');
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) || 0 : 0;
})();
let dshPort = null;
// dsh 0.1.2-rc.1+ outputs a token-bearing URL on stdout ("dsh web: http://...?token=...").
// Older versions output a bare URL without a query string.
// We capture the full URL here so mainWindow.loadURL can use it regardless of version.
let dshReadyUrl = null;
// Cached preferSystem flag from initial bootstrap — reused on crash restart
// so we don't lose the "prefer system dsh" semantic across restarts.
let dshPreferSystem = false;
// Download state for tray convergence

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
  // Plugins edition: always set DSH_HOME to ~/.dsh, regardless of system dsh.
  // The bundled plugins expect the standard data directory.
  const isPlugins = app.isPackaged &&
    pluginDeployer.isPluginsEdition(process.resourcesPath);

  if (process.env.DSH_HOME) {
    // User explicitly set it — always respect that.
    log.info(`DSH_HOME already set: ${process.env.DSH_HOME}`);
  } else if (isPlugins) {
    const dshHome = path.join(os.homedir(), '.dsh');
    process.env.DSH_HOME = dshHome;
    log.info(`DSH_HOME set to: ${dshHome} (plugins edition)`);
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

/**
 * Clean non-symlink entries from ~/.dsh/profiles/node_modules/.
 *
 * dsh's `healProfilesModuleFallback` expects every entry in this directory to
 * be a junction it manages. If a real directory exists (e.g. from a previous
 * npm/pnpm install or a broken plugin install), dsh throws and crashes on
 * startup. We proactively remove non-symlink entries so dsh can recreate them
 * as junctions.
 */
function cleanProfilesNodeModules() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const nmDir = path.join(dshHome, 'profiles', 'node_modules');
  if (!fs.existsSync(nmDir)) return;

  let cleaned = 0;
  try {
    for (const entry of fs.readdirSync(nmDir)) {
      if (entry === '.bin' || entry === '.pnpm') continue;
      const full = path.join(nmDir, entry);

      // Scoped package directories (e.g. @anthropic-ai) are normal dirs,
      // not symlinks. Their children are the actual junctions. Skip them
      // at top level — only clean non-scoped non-symlink entries.
      if (entry.startsWith('@')) continue;

      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (!stat.isSymbolicLink() && stat.isDirectory()) {
        try {
          fs.rmSync(full, { recursive: true, force: true });
          cleaned++;
        } catch (err) {
          log.warn(`cleanProfilesNodeModules: could not remove ${full}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    log.warn(`cleanProfilesNodeModules: error scanning ${nmDir}: ${err.message}`);
  }
  if (cleaned > 0) {
    log.info(`cleanProfilesNodeModules: removed ${cleaned} non-symlink entries from ${nmDir}`);
  }
}

/**
 * Kill stale dsh processes before starting a new instance.
 * When the app crashes or is force-killed, child dsh/node processes may
 * survive and hold locks (e.g. task-board ledger), causing the next launch
 * to fail with "ledger is already owned by process XXXX".
 *
 * On Windows we use PowerShell Get-CimInstance to find node processes whose
 * command line contains "dsh" and kill their entire process tree.
 * (wmic is removed on Win11 23H2+, so we can't rely on it.)
 */
function killStaleDshProcesses() {
  if (process.platform !== 'win32') return;
  const { execSync } = require('node:child_process');

  // Step 1: Kill stale node processes running dsh (best effort)
  // Use PowerShell Get-CimInstance instead of wmic (removed on Win11 23H2+).
  try {
    const psScript =
      "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | " +
      "Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation";
    const out = execSync(
      `powershell -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"')}"`,
      { encoding: 'utf-8', timeout: 10000, windowsHide: true },
    );
    const lines = out.split('\n').filter(l => l.trim());
    let killed = 0;
    for (const line of lines) {
      // CSV from ConvertTo-Csv: "ProcessId","CommandLine" or "123","some cmd"
      // Skip header row
      if (line.toLowerCase().includes('processid') && line.toLowerCase().includes('commandline')) continue;
      // Parse CSV — values are quoted, comma-separated
      const matches = line.match(/"([^"]*)"/g);
      if (!matches || matches.length < 2) continue;
      const cmdLine = (matches[0] || '').replace(/"/g, '').toLowerCase();
      const pid = (matches[1] || '').replace(/"/g, '').trim();
      if (!pid || pid === '0') continue;
      if (cmdLine.includes('dsh') && !cmdLine.includes('dsh-my-simple-desktop') && !cmdLine.includes('electron')) {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, {
            stdio: 'ignore', timeout: 3000, windowsHide: true,
          });
          log.info(`killStaleDshProcesses: killed stale dsh pid ${pid}`);
          killed++;
        } catch (err) {
          log.error(`killStaleDshProcesses: failed to kill pid ${pid}: ${err.message}`);
        }
      }
    }
    if (killed > 0) {
      log.info(`killStaleDshProcesses: killed ${killed} stale dsh process(es)`);
    }
  } catch (err) {
    log.error(`killStaleDshProcesses: PowerShell process query failed: ${err.message}`);
  }

  // Step 2: Remove stale task-board lock file
  cleanupDshLocks();
}

/**
 * Remove stale task-board lock file if the owning process is dead.
 *
 * The lock file is at ~/.dsh/task-board/ledger-v2.lock and contains the PID
 * of the process that holds it. If that process is no longer alive, the lock
 * is stale and must be removed or dsh will crash with "ledger is already
 * owned by process XXXX".
 *
 * This is split out from killStaleDshProcesses so it can be called
 * independently on the crash-restart path (before each restart spawn).
 *
 * Safety: only removes the lock if the owner PID is dead OR is the current
 * process. Never removes a lock held by a live *different* process (which
 * would be a legitimate concurrent dsh instance).
 */
function cleanupDshLocks() {
  try {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const lockFile = path.join(dshHome, 'task-board', 'ledger-v2.lock');
    if (!fs.existsSync(lockFile)) return;

    let ownerPid = null;
    try {
      const content = fs.readFileSync(lockFile, 'utf-8');
      const parsed = JSON.parse(content);
      if (typeof parsed.pid === 'number') ownerPid = parsed.pid;
    } catch {
      // Lock file is corrupt — just delete it
    }

    let shouldRemove = true;
    if (ownerPid && ownerPid !== process.pid) {
      // Check if the owner process is still alive
      try {
        const { execSync } = require('node:child_process');
        const out = execSync(`tasklist /FI "PID eq ${ownerPid}" /NH /FO CSV`, {
          encoding: 'utf-8', timeout: 3000, windowsHide: true,
        });
        // If tasklist output contains the PID, the process is alive.
        // A live lock owned by a *different* process is legitimate — skip.
        if (out.includes(String(ownerPid))) {
          shouldRemove = false;
          log.info(`cleanupDshLocks: lock owner pid ${ownerPid} is alive, not removing`);
        }
      } catch {
        // tasklist failed — process is likely dead, safe to remove
      }
    }

    if (shouldRemove) {
      try {
        fs.unlinkSync(lockFile);
        log.info(`cleanupDshLocks: removed stale lock file ${lockFile} (owner pid: ${ownerPid})`);
      } catch (err) {
        log.error(`cleanupDshLocks: could not remove lock file: ${err.message}`);
      }
    }
  } catch (err) {
    log.error(`cleanupDshLocks: lock file cleanup failed: ${err.message}`);
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
  dshReadyUrl = null;
}

/**
 * Force-remove the dsh task-board lock file on Windows.
 * dsh uses openSync(file, "wx", 0o600) + chmodSync(0o600) for its lock.
 * When dsh is killed (taskkill /F), the lock file remains with restrictive
 * permissions.  On Windows, 0o600 maps to "owner only" ACL which can cause
 * EPERM on subsequent openSync/unlinkSync calls.
 *
 * This function uses a multi-layer approach:
 *   1. icacls to grant full control to current user
 *   2. attrib -r to clear read-only flag
 *   3. fs.unlinkSync
 *   4. del /f /q as final fallback
 *   5. Retry with increasing delays between attempts
 *
 * @param {string} lockFile - Absolute path to ledger-v2.lock
 * @param {object} [opts] - { maxRetries=5, baseDelayMs=200, log:log }
 * @returns {boolean} true if lock file is gone (or was never there)
 */
function forceRemoveLockFile(lockFile, opts) {
  const { maxRetries = 5, baseDelayMs = 200, log: logRef = log } = opts || {};
  const { execSync } = require('node:child_process');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (!fs.existsSync(lockFile)) return true;

    // Layer 1: icacls — reset ACL to grant full control
    if (process.platform === 'win32') {
      try {
        execSync(`icacls "${lockFile}" /grant "*S-1-5-32-544:F" "*S-1-1-0:F"`,
          { stdio: 'ignore', windowsHide: true, timeout: 3000 });
      } catch {}
      // Layer 2: attrib -r — clear read-only / hidden / system flags
      try {
        execSync(`attrib -r -h -s "${lockFile}"`,
          { stdio: 'ignore', windowsHide: true, timeout: 2000 });
      } catch {}
    }

    // Layer 3: fs.unlinkSync
    try {
      fs.unlinkSync(lockFile);
      logRef.info(`force-removed lock file ${lockFile} (attempt ${attempt})`);
      return true;
    } catch (e) {
      logRef.warn(`could not remove lock (attempt ${attempt}): ${e.message}`);
    }

    // Layer 4: del /f /q — Windows shell delete
    if (process.platform === 'win32') {
      try {
        execSync(`del /f /q "${lockFile}"`,
          { stdio: 'ignore', windowsHide: true, timeout: 2000 });
      } catch {}
      if (!fs.existsSync(lockFile)) {
        logRef.info(`force-removed lock file ${lockFile} via del (attempt ${attempt})`);
        return true;
      }
    }

    // Wait before next retry (increasing delay: 200ms, 400ms, 600ms, 800ms, ...)
    if (attempt < maxRetries) {
      const delay = baseDelayMs * attempt;
      try { execSync(`ping 127.0.0.1 -n 1 -w ${delay} >nul`,
        { stdio: 'ignore', windowsHide: true, timeout: delay + 1000 }); } catch {}
    }
  }

  // Final check
  return !fs.existsSync(lockFile);
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
  // Pre-clean stale lock files BEFORE spawning dsh.
  // dsh's acquireLock uses openSync(file, "wx", 0o600) + chmodSync(0o600).
  // When dsh is killed (taskkill /F), the lock file remains with restrictive
  // permissions, causing EPERM on the next launch.  We use forceRemoveLockFile
  // which resets ACLs via icacls before deleting, ensuring a clean slate.
  try {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const lockFile = path.join(dshHome, 'task-board', 'ledger-v2.lock');
    if (fs.existsSync(lockFile)) {
      const removed = forceRemoveLockFile(lockFile, { maxRetries: 3, baseDelayMs: 150 });
      if (removed) {
        log.info(`pre-cleaned stale lock file ${lockFile}`);
      } else {
        log.warn(`pre-clean lock failed: could not remove ${lockFile}`);
      }
    }
  } catch (e) {
    log.warn(`pre-clean lock failed: ${e.message}`);
  }
  // Plugins edition: always use bundled dsh, never system dsh.
  const isPlugins = app.isPackaged &&
    pluginDeployer.isPluginsEdition(process.resourcesPath);
  const forceBundled = isPlugins;

  const resolved = resolveDshCommand({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    preferSystem: preferSystem === true,
    forceBundled,
    envDir: dshEnvDir(),
  });
  const cmd = resolved.cmd;
  // --no-open prevents the system dsh CLI from auto-opening a browser.
  // Only the system dsh (rc7+) supports this flag; the bundled rc6 does not
  // and will crash with "unknown option" if it receives it. The bundled dsh
  // never auto-opens a browser anyway, so we only add --no-open when using
  // the system dsh (preferSystem = true).
  // Plugins edition always uses bundled dsh, so --no-open is never added.
  const noOpenFlag = (!forceBundled && preferSystem) ? ['--no-open'] : [];
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
  child.stdout.on('data', (d) => {
    const line = String(d).trimEnd();
    log.info(`[dsh] ${line}`);
    // Parse "dsh web: <url>" from stdout — dsh 0.1.2-rc.1+ appends ?token=...
    // Capture the full URL so the Electron window can authenticate.
    const match = line.match(/dsh web:\s*(\S+)/);
    if (match) {
      dshReadyUrl = match[1];
      log.info(`[dsh] captured ready URL: ${dshReadyUrl}`);
    }
  });

  child.on('exit', (code, signal) => {
    const wasChild = dshChild === child;
    dshChild = null;
    dshPort = null;
    dshReadyUrl = null;

    // Remove the stderr listener once the process is gone
    child.stderr.removeListener('data', stderrListener);

    const exitInfo = `code=${code}, signal=${signal}`;
    log.info(`dsh exited (${exitInfo})`);

    if (isQuitting || isSmoke || !wasChild) return;

    // Build a diagnostics message from early stderr if available
    let diagnostic = '';
    if (earlyStderr.length > 0) {
      const tail = earlyStderr.slice(-500).trim();
      diagnostic = tail ? `：${tail}` : '';
    }

    // ── 重启策略 ──────────────────────────────────────────────────────────
    //
    // 简化方案：dsh 退出时区分"正常退出"和"崩溃"。
    //
    // 1) 正常退出 (code=0 或 SIGTERM — 插件重启):
    //    dsh-market helper 会 spawn 新 dsh。Electron 不退出，
    //    延迟 3 秒后 reload 一次页面。如果此时 dsh 还没起来，
    //    页面会显示加载失败，用户按 F5 手动刷新即可。
    //
    // 2) 崩溃 (code≠0 且非 SIGTERM):
    //    app.relaunch() + app.exit(0)，整应用重启。
    //    递增计数器，APP_MAX_RELAUNCHES 次后停止。
    const isCleanExit = code === 0 || (code === null && signal === 'SIGTERM');

    if (isCleanExit) {
      log.info(`dsh exited (${exitInfo}); will reload window in 3s`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:event', {
          type: 'dsh-restarting',
          payload: { reason: 'plugin-restart' },
        });
      }
      const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const lockFile = path.join(dshHome, 'task-board', 'ledger-v2.lock');
      forceRemoveLockFile(lockFile, { maxRetries: 5, baseDelayMs: 300 });
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          log.info('reloading window after dsh restart');
          mainWindow.webContents.reload();
        }
      }, 3000);
      return;
    }

    // ── Plan A: 崩溃 → 整应用 relaunch ──
    if (appRelaunches < APP_MAX_RELAUNCHES) {
      appRelaunches += 1;
      log.warn(`dsh exited (${exitInfo}); full app relaunch ${appRelaunches}/${APP_MAX_RELAUNCHES}${diagnostic}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:event', {
          type: 'dsh-relaunching',
          payload: { attempt: appRelaunches, max: APP_MAX_RELAUNCHES, diagnostic: earlyStderr.slice(-300) },
        });
      }
      // Kill the dsh process tree FIRST so Windows releases file handles.
      killDshTree();
      // Force-remove lock file — dsh's chmodSync(0o600) makes the lock file
      // hard to delete on Windows after taskkill /F.  Use forceRemoveLockFile
      // which resets ACLs via icacls before deleting.
      const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const lockFile = path.join(dshHome, 'task-board', 'ledger-v2.lock');
      forceRemoveLockFile(lockFile, { maxRetries: 5, baseDelayMs: 300 });
      // Strip --hidden and old --relaunch-count so the new instance starts clean.
      const relaunchArgs = process.argv.slice(1)
        .filter((a) => a !== '--hidden')
        .filter((a, i, arr) => !(a === '--relaunch-count' || (i > 0 && arr[i - 1] === '--relaunch-count')));
      relaunchArgs.push('--relaunch-count', String(appRelaunches));
      // Delay relaunch to let Windows fully release file handles (crash path:
      // taskkill /F or segfault — Windows needs 2-3s to release file handles).
      setTimeout(() => {
        app.relaunch({ args: relaunchArgs });
        app.exit(0);
      }, 3000);
      return;
    }

    log.error(`dsh keeps crashing; giving up after ${APP_MAX_RELAUNCHES} app relaunches${diagnostic}`);
    const detail = earlyStderr.length > 0
      ? `\n\n最后一次崩溃的 stderr 输出（末尾）：\n${earlyStderr.slice(-500)}`
      : '';
    dialog.showErrorBox(
      APP_NAME,
      `dsh web 进程连续异常退出（已自动重启应用 ${APP_MAX_RELAUNCHES} 次），请检查日志。${detail}`,
    );
    app.quit();
  });
  return child;
}

/** Pick a free port, spawn dsh, wait for readiness. Returns the URL. */
async function bootstrapDsh(preferSystem, timeoutMs) {
  // Cache preferSystem so crash-restart can reuse the same value without
  // re-detecting (and without the caller having to pass it every time).
  dshPreferSystem = preferSystem === true;
  const port = await findFreePort(DEFAULT_PORT, PORT_SCAN_LIMIT);
  if (port === null) {
    throw new Error(
      `端口 ${DEFAULT_PORT}~${DEFAULT_PORT + PORT_SCAN_LIMIT} 均被占用，无法启动`,
    );
  }
  startDsh(port, preferSystem);
  await waitForHealthyUrl(port, timeoutMs || SERVER_TIMEOUT_MS);
  // Wait a bit for dsh to emit the "dsh web: <url>" line with token (rc.1+).
  // The HTTP health check may pass before dsh prints the token URL.
  if (!dshReadyUrl) {
    await new Promise(r => setTimeout(r, 500));
  }
  // Prefer the token-bearing URL captured from dsh stdout (rc.1+).
  // Fall back to the bare URL for older dsh versions that don't emit a token.
  return dshReadyUrl || `http://127.0.0.1:${port}`;
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

/**
 * Check if there is an active LLM generation task in the dsh web frontend.
 *
 * Uses multiple signals to detect the "stop/generating" state of the send
 * button, so it survives dsh UI text changes:
 *
 * 1. aria-label contains "停止" or "stop" (i18n resilient)
 * 2. SVG inside the button is a <rect> (stop icon) rather than <path> (send arrow)
 * 3. aria-label is NOT "发送" / "send" / "submit" (fallback: if it's neither
 *    send nor stop, treat the non-send state as potentially generating)
 *
 * Signal 1+2 together give high confidence. If only one matches, still block
 * close (safer to false-positive than to silently kill a running task).
 *
 * Returns true if a generation task appears to be in progress.
 */
async function checkActiveLlmTask() {
  if (!mainWindow || !mainWindow.webContents) return false;
  try {
    const result = await mainWindow.webContents.executeJavaScript(`
      (function() {
        var btn = document.querySelector('button.uV2eYG_primary');
        if (!btn) return false;

        var label = (btn.getAttribute('aria-label') || '').toLowerCase();
        var hasStopLabel = label.indexOf('停止') !== -1 || label.indexOf('stop') !== -1 || label.indexOf('abort') !== -1 || label.indexOf('cancel') !== -1;
        var hasSendLabel = label.indexOf('发送') !== -1 || label.indexOf('send') !== -1 || label.indexOf('submit') !== -1;

        // Check SVG shape: <rect> = stop icon, <path> = send arrow
        var svg = btn.querySelector('svg');
        var hasRect = svg ? !!svg.querySelector('rect') : false;
        var hasPath = svg ? !!svg.querySelector('path') : false;

        // Generating if: stop label OR (rect icon AND NOT send label)
        // The "AND NOT send label" avoids false positive if dsh uses rect
        // icons for other purposes.
        if (hasStopLabel) return true;
        if (hasRect && !hasPath && !hasSendLabel) return true;

        return false;
      })()
    `, true);
    return !!result;
  } catch (err) {
    log.warn(`checkActiveLlmTask: check failed: ${err.message}`);
    return false;
  }
}

/**
 * Check for active LLM tasks and prompt the user if found.
 * Returns true if safe to proceed (no task, or user confirmed force quit).
 * Returns false if the user cancelled.
 */
async function confirmActiveTaskBeforeQuit(actionLabel) {
  log.info(`guard: checking active LLM task before ${actionLabel}...`);
  let hasActiveTask = false;
  try {
    hasActiveTask = await checkActiveLlmTask();
  } catch (err) {
    log.warn(`guard: check failed: ${err.message}`);
    return true;
  }
  log.info(`guard: hasActiveTask=${hasActiveTask}`);
  if (!hasActiveTask) return true;

  const parentWin = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
  const choice = await dialog.showMessageBox(parentWin, {
    type: 'warning',
    buttons: ['仍然继续', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '有任务正在进行',
    message: '检测到大模型任务正在进行中',
    detail: `现在${actionLabel}可能导致会话中断或数据丢失。建议等待任务完成后再${actionLabel}。\n\n确定要强制${actionLabel}吗？`,
  });
  return choice.response === 0;
}

function createMainWindow(url) {
  // Build application menu
  const { Menu, dialog } = require('electron');
  const template = [
    {
      label: '文件',
      submenu: [
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '检查更新…',
          click: async () => {
            const result = await updateChecker.checkForUpdate();
            if (result.error) {
              dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: '检查更新失败',
                message: result.error,
              });
              return;
            }
            if (!result.hasUpdate) {
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: '已是最新版本',
                message: `当前版本 ${updateChecker.CURRENT_VERSION}，已是最新。`,
              });
              return;
            }
            dialog.showMessageBox(mainWindow, {
              type: 'question',
              title: `发现新版本 v${result.latestVersion}`,
              message: `发现新版本 v${result.latestVersion}，当前版本 ${updateChecker.CURRENT_VERSION}。\n是否立即下载更新？\n\n下载进度将在托盘菜单中显示。`,
              buttons: ['下载', '取消'],
              defaultId: 0,
            }).then(async ({ response }) => {
              if (response === 0 && result.downloadUrl) {
                promptDownloadUpdate(result.latestVersion, result.downloadUrl, result.assetName);
              }
            });
          },
        },
        { type: 'separator' },
        {
          label: '用量统计…',
          click: () => openUsageWindow(),
        },
        {
          label: '模型配置教程…',
          click: () => openGuideWindow(),
        },
        { type: 'separator' },
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: `DSH My Simple Desktop\n版本 ${updateChecker.CURRENT_VERSION}`,
              detail: '中国电信研发云 - CodeFree-O',
            });
          },
        },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

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
      backgroundThrottling: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!isHiddenStart) mainWindow.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // close-to-tray / quit behaviour
  let closeGuardInProgress = false;
  mainWindow.on('close', (e) => {
    if (isQuitting || isSmoke) return;
    if (settings.get('closeToTray', false)) {
      e.preventDefault();
      mainWindow.hide();
      return;
    }

    // Check if there are active LLM tasks before quitting
    if (closeGuardInProgress) return;
    e.preventDefault();
    closeGuardInProgress = true;

    log.info('close guard: checking active LLM task...');

    checkActiveLlmTask()
      .then((hasActiveTask) => {
        log.info(`close guard: hasActiveTask=${hasActiveTask}`);
        if (hasActiveTask) {
          return dialog
            .showMessageBox(mainWindow, {
              type: 'warning',
              buttons: ['仍然关闭', '取消'],
              defaultId: 1,
              cancelId: 1,
              title: '有任务正在进行',
              message: '检测到大模型任务正在进行中',
              detail: '现在关闭可能导致会话中断或数据丢失。建议等待任务完成后再关闭。\n\n确定要强制关闭吗？',
            })
            .then((choice) => {
              if (choice.response === 1) {
                // User cancelled — don't close
                closeGuardInProgress = false;
                return false;
              }
              return true;
            });
        }
        return true;
      })
      .then((shouldClose) => {
        if (shouldClose) {
          closeGuardInProgress = false;
          isQuitting = true;
          mainWindow.close();
        }
      })
      .catch((err) => {
        log.warn(`close guard check failed: ${err.message}`);
        closeGuardInProgress = false;
        isQuitting = true;
        mainWindow.close();
      });
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

  // F5 / Ctrl+R manual reload — lets user refresh after manually restarting dsh
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F5' ||
        (input.key === 'r' && (input.control || input.meta)))) {
      log.info('manual reload (F5/Ctrl+R)');
      mainWindow.webContents.reload();
    }
  });

  // Reset the renderer-crash reload flag when page finishes loading.
  // (Previously the guide button was injected here; it has been moved to
  //  the Help menu bar for a cleaner interface.)
  mainWindow.webContents.on('did-finish-load', () => {
    rendererReloaded = false;
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
  const items = [
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
      label: '用量统计…',
      click: () => openUsageWindow(),
    },
    {
      label: '模型配置教程…',
      click: () => openGuideWindow(),
    },
    {
      label: '设置…',
      click: () => openSettingsWindow(),
    },
  ];

  // Update / download state menu items (with submenu for details)
  if (_downloadState) {
    if (_downloadState.state === 'downloading') {
      const pct = _downloadState.percent || 0;
      const retry = _downloadState.retryAttempt || 0;
      const subMenu = [
        { label: `进度：${pct}%`, enabled: false },
        { label: retry > 0 ? `正在重试（第 ${retry} 次）` : '下载中…', enabled: false },
        { type: 'separator' },
        {
          label: '查看下载详情…',
          click: () => showDownloadProgressWindow(),
        },
        {
          label: '取消下载',
          click: () => {
            _downloadState.state = 'cancelled';
            updateTrayMenu();
          },
        },
      ];
      items.push({ type: 'separator' }, {
        label: `下载更新 ${pct}%${retry > 0 ? `（重试 ${retry} 次）` : ''}`,
        click: () => showDownloadProgressWindow(),
        submenu: subMenu,
      });
    } else if (_downloadState.state === 'done') {
      items.push({ type: 'separator' }, {
        label: '更新已下载，准备安装',
        enabled: false,
      }, {
        label: '安装更新并重启',
        click: async () => {
          const ok = await confirmActiveTaskBeforeQuit('安装更新');
          if (!ok) return;
          const { spawn } = require('child_process');
          spawn(_downloadState.destPath, ['--silent'], {
            detached: true,
            stdio: 'ignore',
          }).unref();
          isQuitting = true;
          app.quit();
        },
      });
    } else if (_downloadState.state === 'error') {
      items.push({ type: 'separator' }, {
        label: '下载失败',
        enabled: false,
      }, {
        label: '重试下载',
        click: async () => {
          _downloadState.state = 'downloading';
          _downloadState.retryAttempt = 0;
          _downloadState.percent = 0;
          _downloadState.downloaded = 0;
          _downloadState.total = 0;
          _downloadState.speed = 0;
          _downloadState.speedTs = 0;
          _downloadState.speedDone = 0;
          updateTrayMenu();
          try {
            const { destPath } = await updateChecker.downloadInstaller(_downloadState.downloadUrl, (done, total, retryAttempt) => {
              if (done === -1) {
                _downloadState.retryAttempt = retryAttempt || 0;
                _downloadState.speed = 0;
                _downloadState.speedTs = 0;
                _downloadState.speedDone = 0;
                updateTrayMenu();
                return;
              }
              _downloadState.downloaded = done;
              _downloadState.total = total;
              _downloadState.percent = total > 0 ? Math.round((done / total) * 100) : 0;
              _downloadState.retryAttempt = 0;
              const now = Date.now();
              if (_downloadState.speedTs === 0) {
                _downloadState.speedTs = now;
                _downloadState.speedDone = done;
              } else {
                const elapsed = (now - _downloadState.speedTs) / 1000;
                if (elapsed >= 1) {
                  _downloadState.speed = Math.round((done - _downloadState.speedDone) / elapsed);
                  _downloadState.speedTs = now;
                  _downloadState.speedDone = done;
                }
              }
              updateTrayMenu();
            });
            _downloadState.destPath = destPath;
            _downloadState.state = 'done';
            updateTrayMenu();
            await new Promise(r => setTimeout(r, 2000));
            const ok = await confirmActiveTaskBeforeQuit('安装更新');
            if (!ok) return;
            const { spawn } = require('child_process');
            spawn(destPath, ['--silent'], { detached: true, stdio: 'ignore' }).unref();
            isQuitting = true;
            app.quit();
          } catch (e) {
            _downloadState.state = 'error';
            _downloadState.errorMsg = String(e.message || e);
            updateTrayMenu();
          }
        },
      });
    } else if (_downloadState.state === 'cancelled') {
      items.push({ type: 'separator' }, {
        label: '下载已取消',
        enabled: false,
      }, {
        label: '重新下载',
        click: () => {
          if (_downloadState.downloadUrl) {
            _downloadState.state = 'downloading';
            _downloadState.retryAttempt = 0;
            _downloadState.percent = 0;
            updateTrayMenu();
            promptDownloadUpdate(_downloadState.latestVersion, _downloadState.downloadUrl, _downloadState.assetName);
          }
        },
      });
    }
  } else {
    items.push({ type: 'separator' }, {
      label: '检查更新…',
      click: async () => {
        const result = await updateChecker.checkForUpdate();
        if (result.error) {
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: '检查更新失败',
            message: result.error,
          });
          return;
        }
        if (!result.hasUpdate) {
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '已是最新版本',
            message: `当前版本 ${updateChecker.CURRENT_VERSION}，已是最新。`,
          });
          return;
        }
        promptDownloadUpdate(result.latestVersion, result.downloadUrl, result.assetName);
      },
    });
  }

  items.push({ type: 'separator' }, {
    label: '开机自启',
    type: 'checkbox',
    checked: settings.get('autoLaunch', false),
    click: (item) => {
      settings.set('autoLaunch', item.checked);
      applyAutoLaunch();
    },
  }, { type: 'separator' }, {
    label: '退出',
    click: async () => {
      const ok = await confirmActiveTaskBeforeQuit('退出');
      if (ok) {
        isQuitting = true;
        app.quit();
      }
    },
  });

  return Menu.buildFromTemplate(items);
}

function createTray() {
  tray = new Tray(TRAY_ICON_PATH);
  tray.setToolTip(APP_NAME);
  const menu = buildTrayMenu();
  tray.setContextMenu(menu);
  log.info('tray created with context menu');
  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        showMainWindow();
      }
    } else {
      tray.popUpContextMenu(buildTrayMenu());
    }
  });
  tray.on('double-click', () => showMainWindow());
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;

  if (_downloadState) {
    if (_downloadState.state === 'downloading') {
      const pct = _downloadState.percent || 0;
      const retry = _downloadState.retryAttempt || 0;
      if (retry > 0) {
        tray.setToolTip(`${APP_NAME} — 下载中断，正在重试（第 ${retry} 次）…`);
      } else {
        tray.setToolTip(`${APP_NAME} — 下载更新 ${pct}%`);
      }
    } else if (_downloadState.state === 'done') {
      tray.setToolTip(`${APP_NAME} — 更新已下载，准备安装`);
    } else if (_downloadState.state === 'error') {
      tray.setToolTip(`${APP_NAME} — 下载更新失败`);
    } else if (_downloadState.state === 'cancelled') {
      tray.setToolTip(`${APP_NAME} — 下载已取消`);
    }
  } else {
    tray.setToolTip(APP_NAME);
  }

  tray.setContextMenu(buildTrayMenu());
  sendProgressToWindow();
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
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'help', 'model-guide.html'));
}

function openUsageWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 750,
    minWidth: 700,
    minHeight: 500,
    title: '用量统计 — ' + APP_NAME,
    icon: ICON_PATH,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'usage', 'usage.html'));
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
// Auto update check (GitHub Release)
// ---------------------------------------------------------------------------

let _lastNotifiedVersion = null;
let _autoUpdateTimer = null;

/**
 * Show a native notification in the bottom-right corner.
 * On click, triggers the download flow (converged to tray menu).
 */
function showUpdateNotification(latestVersion, downloadUrl, assetName) {
  if (!Notification.isSupported()) {
    // Fallback: flash tray + set tooltip
    if (tray && !tray.isDestroyed()) {
      tray.setToolTip(`${APP_NAME} — 发现新版本 v${latestVersion}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.flashFrame(true);
      }
    }
    return;
  }

  const notif = new Notification({
    title: `发现新版本 v${latestVersion}`,
    body: `点击下载更新（当前版本 ${updateChecker.CURRENT_VERSION}）`,
    silent: false,
  });

  notif.on('click', () => {
    notif.close();
    promptDownloadUpdate(latestVersion, downloadUrl, assetName);
  });

  notif.show();
}

let _downloadProgressWin = null;

/**
 * Show a download progress window that reflects _downloadState.
 * Can be opened repeatedly; closing it does NOT cancel the download.
 */
function showDownloadProgressWindow() {
  if (_downloadProgressWin && !_downloadProgressWin.isDestroyed()) {
    _downloadProgressWin.show();
    _downloadProgressWin.focus();
    return;
  }

  _downloadProgressWin = new BrowserWindow({
    width: 460,
    height: 340,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    title: '下载更新',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  _downloadProgressWin.once('ready-to-show', () => {
    _downloadProgressWin.show();
    sendProgressToWindow();
  });
  // Minimize → hide to tray (not taskbar); clicking tray "下载更新" re-shows
  _downloadProgressWin.on('minimize', (e) => {
    e.preventDefault();
    _downloadProgressWin.hide();
  });
  _downloadProgressWin.on('closed', () => { _downloadProgressWin = null; });
  _downloadProgressWin.loadFile(path.join(__dirname, 'updater', 'download-progress.html'));
}

/**
 * Push current _downloadState to the progress window (if open).
 */
function sendProgressToWindow() {
  if (!_downloadProgressWin || _downloadProgressWin.isDestroyed()) return;
  _downloadProgressWin.webContents.send('download:state', {
    state: _downloadState ? _downloadState.state : 'idle',
    percent: _downloadState ? _downloadState.percent : 0,
    retryAttempt: _downloadState ? _downloadState.retryAttempt : 0,
    latestVersion: _downloadState ? _downloadState.latestVersion : null,
    errorMsg: _downloadState ? _downloadState.errorMsg : null,
    downloaded: _downloadState ? _downloadState.downloaded : 0,
    total: _downloadState ? _downloadState.total : 0,
    speed: _downloadState ? _downloadState.speed : 0,
    assetName: _downloadState ? _downloadState.assetName : null,
  });
}

/**
 * Prompt user to download and install the update.
 * Reuses the same flow as the menu "检查更新" action.
 */
async function promptDownloadUpdate(latestVersion, downloadUrl, assetName) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }

  _downloadState = {
    latestVersion,
    downloadUrl,
    assetName,
    percent: 0,
    state: 'downloading',
    retryAttempt: 0,
    downloaded: 0,
    total: 0,
    speed: 0,
    speedTs: 0,
    speedDone: 0,
  };
  updateTrayMenu();
  showDownloadProgressWindow();

  try {
    const { destPath } = await updateChecker.downloadInstaller(downloadUrl, (done, total, retryAttempt) => {
      // Special retry signal: done=-1, retryAttempt=attempt
      if (done === -1) {
        _downloadState.retryAttempt = retryAttempt || 0;
        _downloadState.speed = 0;
        _downloadState.speedTs = 0;
        _downloadState.speedDone = 0;
        updateTrayMenu();
        return;
      }
      _downloadState.downloaded = done;
      _downloadState.total = total;
      _downloadState.percent = total > 0 ? Math.round((done / total) * 100) : 0;
      _downloadState.retryAttempt = 0;

      // Calculate speed (bytes/sec) over a 1s window
      const now = Date.now();
      if (_downloadState.speedTs === 0) {
        _downloadState.speedTs = now;
        _downloadState.speedDone = done;
      } else {
        const elapsed = (now - _downloadState.speedTs) / 1000;
        if (elapsed >= 1) {
          _downloadState.speed = Math.round((done - _downloadState.speedDone) / elapsed);
          _downloadState.speedTs = now;
          _downloadState.speedDone = done;
        }
      }
      updateTrayMenu();
    });

    _downloadState.destPath = destPath;
    _downloadState.state = 'done';
    updateTrayMenu();
    await new Promise(r => setTimeout(r, 2000));

    const ok = await confirmActiveTaskBeforeQuit('安装更新');
    if (!ok) return;
    const { spawn } = require('child_process');
    spawn(destPath, ['--silent'], { detached: true, stdio: 'ignore' }).unref();
    isQuitting = true;
    app.quit();
  } catch (e) {
    _downloadState.state = 'error';
    _downloadState.errorMsg = String(e.message || e);
    updateTrayMenu();
  }
}

/**
 * Auto check for updates on startup + periodic poll.
 * - First check: 30s after startup
 * - Periodic: every 4 hours
 * - Only notifies once per version (avoids repeated notifications)
 */
function autoCheckUpdate() {
  if (!settings.get('checkUpdatesOnStart', true)) return;

  const doCheck = async () => {
    try {
      const result = await updateChecker.checkForUpdate();
      if (result.hasUpdate && result.downloadUrl && result.latestVersion !== _lastNotifiedVersion) {
        _lastNotifiedVersion = result.latestVersion;
        log.info(`[auto-update] new version found: v${result.latestVersion}`);
        showUpdateNotification(result.latestVersion, result.downloadUrl, result.assetName);
      }
    } catch (e) {
      log.warn('[auto-update] check failed: ' + (e.message || e));
    }
  };

  // First check after 30s
  setTimeout(doCheck, 30_000);

  // Periodic check every 4 hours
  _autoUpdateTimer = setInterval(doCheck, 4 * 60 * 60 * 1000);
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
  ipcMain.handle('updater:check', async () => {
    const result = await updateChecker.checkForUpdate();
    return result;
  });
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
    updateEnabled: true,
    updateUrl: 'github://chenans/DSH-My-simple-desktop',
  }));
  ipcMain.handle('app:log', (_e, level, message) => {
    const fn = typeof log[level] === 'function' ? log[level] : log.info;
    fn(`[renderer] ${message}`);
  });
  ipcMain.handle('app:open-guide', () => openGuideWindow());
  ipcMain.handle('usage:get-stats', (_e, granularity, range) => {
    return usageStats.getUsageStats(granularity, range);
  });
  ipcMain.handle('download:install', async () => {
    if (_downloadState && _downloadState.state === 'done' && _downloadState.destPath) {
      const ok = await confirmActiveTaskBeforeQuit('安装更新');
      if (!ok) return;
      const { spawn } = require('child_process');
      spawn(_downloadState.destPath, ['--silent'], { detached: true, stdio: 'ignore' }).unref();
      isQuitting = true;
      app.quit();
    }
  });
  ipcMain.handle('download:retry', () => {
    if (_downloadState && _downloadState.downloadUrl) {
      _downloadState.state = 'downloading';
      _downloadState.retryAttempt = 0;
      _downloadState.percent = 0;
      updateTrayMenu();
      promptDownloadUpdate(_downloadState.latestVersion, _downloadState.downloadUrl, _downloadState.assetName);
    }
  });
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

  // ── GPU throttling ───────────────────────────────────────────────────────
  // This is a thin shell that loads localhost — no need for GPU acceleration.
  // disable-gpu kills the GPU process entirely (~150 MB saved, no fan spin).
  // Software rendering still handles CSS animations (e.g. Deep Current's
  // background-position keyframes) just fine.
  if (app.isPackaged) {
    app.commandLine.appendSwitch('disable-gpu');
  }

  app.whenReady().then(async () => {
    initSettings();

    // Detect Plugins edition early — affects DSH_HOME, update checks, and
    // whether system dsh is considered at all.
    const resourcesPath0 = app.isPackaged ? process.resourcesPath : null;
    const isPluginsEdition = resourcesPath0 &&
      pluginDeployer.isPluginsEdition(resourcesPath0);

    if (isPluginsEdition) {
      // Plugins edition: lock to offline mode (no kernel auto-update).
      // The bundled kernel + plugins are a matched set.
      process.env.DSH_DESKTOP_OFFLINE = '1';
      log.info('[plugins-edition] offline mode enabled (DSH_DESKTOP_OFFLINE=1)');
    }

    // Determine whether system dsh is available early, so DSH_HOME can
    // be left at the system default when system dsh is used (preserving
    // plugins/skills installed via `dsh install skill`).
    // Plugins edition ignores system dsh entirely.
    const hasSystemDsh = isPluginsEdition ? false : detectSystemDsh();
    ensureDshHome(hasSystemDsh);

    log.info(`=== ${APP_NAME} ${app.getVersion()} starting (packaged=${app.isPackaged}) ===`);
    log.info(`electron ${process.versions.electron} / node ${process.versions.node} / platform ${process.platform}`);
    if (isPluginsEdition) {
      log.info('[plugins-edition] running in Plugins edition mode');
    }

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

    // Kill stale dsh processes that may hold locks from a previous crash.
    killStaleDshProcesses();

    // Clean stale non-symlink entries in profiles/node_modules so dsh's
    // healProfilesModuleFallback won't crash on startup.
    cleanProfilesNodeModules();

    // ── Plugins edition: deploy bundled plugin snapshot to ~/.dsh ──────
    // Idempotent: skips if marker sha matches. Non-destructive: never
    // overwrites user files. Failure is logged but does not block startup.
    if (isPluginsEdition) {
      sendSplashProgress('正在部署插件…', { sub: '首次启动需要初始化插件环境', progress: 45 });
      try {
        const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
        const result = await pluginDeployer.deployPluginLayer({
          dshHome,
          resourcesPath: process.resourcesPath,
        });
        if (result.deployed) {
          log.info(`[plugins-edition] plugin layer deployed (copied=${result.copied}, skipped=${result.skipped})`);
          sendSplashProgress('插件部署完成', { type: 'done', sub: `已安装 ${result.copied} 个文件`, progress: 48 });
        } else if (result.reason === 'already deployed') {
          log.info('[plugins-edition] plugin layer already deployed, skipping');
        } else {
          log.warn(`[plugins-edition] plugin layer not deployed: ${result.reason}`);
        }
      } catch (err) {
        log.error('[plugins-edition] plugin deployment error: ' + err.message);
        // Don't block startup — dsh will launch bare without plugins
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // 步骤 3：启动 DSH web 服务
    sendSplashProgress('正在启动 DSH 引擎…', { sub: '启动 Web 服务，请稍候', progress: 50 });

    let appUrl = null;
    try {
      if (isPluginsEdition) {
        // Plugins edition: always use bundled dsh (forceBundled in startDsh)
        sendSplashProgress('正在启动内置 DSH 引擎…', { sub: '插件版使用内置引擎', progress: 55 });
        appUrl = await bootstrapDsh(false);
        log.info(`dsh web ready at ${appUrl} (plugins edition, bundled dsh)`);
      } else if (hasSystemDsh) {
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
    // 主窗口就绪后延迟关闭 splash，让用户能看到 splash 完成态
    mainWindow.once('ready-to-show', () => {
      // 先更新 splash 为完成状态，1.5 秒后再关闭
      sendSplashProgress('启动完成！', { type: 'done', progress: 100 });
      setTimeout(() => { closeSplashWindow(); }, 1500);
      // 稳定运行后重置整应用重启计数，防止长期使用中一次偶发崩溃消耗重启预算
      setTimeout(() => {
        appRelaunches = 0;
        log.info('app stable for 60s — relaunch counter reset');
      }, 60_000);
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

    // ── GitHub Release auto-update check ───────────────────────────────
    // Check on startup (delayed) + periodic poll every 4 hours.
    // Shows a native notification in the bottom-right corner when a new
    // version is found. User can click the notification to download.
    autoCheckUpdate();

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
