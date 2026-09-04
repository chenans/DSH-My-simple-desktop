'use strict';

/**
 * Lightweight GitHub Release updater.
 * - Checks https://api.github.com/repos/{owner}/{repo}/releases/latest
 * - Compares versions using semver-like logic
 * - Downloads installer to %TEMP%
 * - Returns { hasUpdate, latestVersion, downloadUrl, releaseNotes, error }
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_OWNER = 'chenans';
const REPO_NAME = 'DSH-My-simple-desktop';
let CURRENT_VERSION = '0.0.0';

try {
  const { app } = require('electron');
  CURRENT_VERSION = app.getVersion() || process.env.npm_package_version || '0.0.0';
} catch {
  CURRENT_VERSION = process.env.npm_package_version || '0.0.0';
}

/**
 * Simple semver comparison.
 * @returns {number} -1 if a<b, 0 if a==b, 1 if a>b
 */
function compareVersions(a, b) {
  const partsA = a.replace(/^v/, '').split('.').map(Number);
  const partsB = b.replace(/^v/, '').split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const va = partsA[i] || 0;
    const vb = partsB[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Fetch latest release from GitHub API.
 * @returns {Promise<{ version: string, tagName: string, htmlUrl: string, assets: Array<{name, browser_download_url}> }>}
 */
function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
    const options = {
      hostname: 'api.github.com',
      path: url,
      method: 'GET',
      headers: {
        'User-Agent': 'DSH-My-Simple-Desktop',
        'Accept': 'application/vnd.github+json',
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GitHub API returned ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({
            version: json.tag_name.replace(/^v/, ''),
            tagName: json.tag_name,
            htmlUrl: json.html_url,
            assets: json.assets || [],
          });
        } catch (e) {
          reject(new Error('Failed to parse GitHub release JSON'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('GitHub API request timeout'));
    });
    req.end();
  });
}

/**
 * Detect which edition the currently running app is, so an update downloads
 * a matching installer (Lite users get the ~81MB Lite installer, not the
 * 278MB Plugins bundle).
 * @returns {'full' | 'plugins' | 'lite' | null} null when undetectable (dev/CI)
 */
function detectCurrentEdition() {
  try {
    const { app } = require('electron');
    if (!app.isPackaged) return null; // dev mode — fall back to full preference
    const resourcesPath = process.resourcesPath;
    if (!resourcesPath) return null;
    const fs2 = require('fs');
    const path2 = require('path');
    // Plugins edition bundles both the runtime and the plugin snapshot.
    if (fs2.existsSync(path2.join(resourcesPath, 'plugins', 'manifest.json'))) {
      return 'plugins';
    }
    // Full edition bundles the dsh runtime.
    if (fs2.existsSync(path2.join(resourcesPath, 'dsh', 'node.exe'))) {
      return 'full';
    }
    // Nothing bundled → Lite edition.
    return 'lite';
  } catch {
    return null;
  }
}

/**
 * Find the installer asset that best matches the current edition.
 * When the running edition is known (detectCurrentEdition), the matching
 * installer wins (Lite → *-Lite-Setup.exe, Plugins → *-Plugins-Setup.exe,
 * Full → *-Setup.exe). Otherwise the priority is full > plugins > lite.
 * @param {Array<{name, browser_download_url}>} assets
 * @param {string|null} [currentEdition]
 * @returns {{name: string, url: string} | null}
 */
function findBestAsset(assets, currentEdition = null) {
  const exes = assets
    .filter((a) => a.name.endsWith('.exe') && !a.name.includes('Portable'))
    .map((a) => {
      const isLite = a.name.includes('-Lite-');
      const isPlugins = a.name.includes('-Plugins-');
      let score;
      if (currentEdition === 'lite') {
        score = isLite ? 3 : (isPlugins ? 1 : 2);
      } else if (currentEdition === 'plugins') {
        score = isPlugins ? 3 : (isLite ? 1 : 2);
      } else if (currentEdition === 'full') {
        score = isLite ? 1 : (isPlugins ? 2 : 3);
      } else {
        // unknown edition → full preferred, then plugins, then lite
        score = isLite ? 0 : (isPlugins ? 1 : 2);
      }
      return { a, score };
    })
    .sort((x, y) => y.score - x.score || x.a.name.localeCompare(y.a.name));

  if (exes.length === 0) return null;
  const best = exes[0].a;
  return {
    name: best.name,
    url: best.browser_download_url,
  };
}

/**
 * Download file to destPath with progress callback.
 * Supports resume: when opts.start > 0 the request carries a Range header
 * and appends to the existing partial file. Redirects (301/302/307) are
 * followed with the same headers.
 * @param {string} url
 * @param {string} destPath
 * @param {(progress: number, total: number) => void} onProgress
 * @param {object} [opts] - { start=0, timeoutMs=300000 }
 */
function downloadFile(url, destPath, onProgress, opts = {}) {
  const start = opts.start || 0;
  const timeoutMs = opts.timeoutMs || 300000;
  return new Promise((resolve, reject) => {
    let file = null;
    let downloaded = 0;
    let total = 0;
    let finalUrl = url;

    const requestHeaders = { 'User-Agent': 'DSH-My-Simple-Desktop' };
    if (start > 0) requestHeaders['Range'] = `bytes=${start}-`;

    /**
     * Fail the download: close the file stream (waiting for the OS to
     * actually release the handle on Windows) before rejecting, so a quick
     * retry can immediately reopen the same partial file without EBUSY.
     */
    const failDownload = (err) => {
      const finish = () => reject(err);
      if (!file) return finish();
      let done = false;
      const onClose = () => { if (!done) { done = true; finish(); } };
      file.once('close', onClose);
      try { file.destroy(); } catch { onClose(); }
      // Safety net: never hang on a stream that refuses to close.
      setTimeout(onClose, 2000).unref();
    };

    /**
     * Follow redirects, then stream the final response into the file.
     * The file is only created once we know the final status code, so a
     * server that ignores Range (returns 200 instead of 206) restarts the
     * download from scratch instead of corrupting the partial file.
     */
    const doGet = (targetUrl, depth) => new Promise((resolveGet, rejectGet) => {
      if (depth > 5) return rejectGet(new Error('Too many redirects'));
      const client = targetUrl.startsWith('https:') ? https : http;
      const req = client.get(targetUrl, { timeout: timeoutMs, headers: requestHeaders }, (res) => {
        // Handle redirect (GitHub release downloads 302 to the CDN)
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          const redirectUrl = res.headers.location;
          if (!redirectUrl) {
            res.resume();
            return rejectGet(new Error(`Redirect failed: ${res.statusCode}`));
          }
          res.resume();
          return resolveGet(doGet(new URL(redirectUrl, targetUrl).href, depth + 1));
        }

        const isPartial = res.statusCode === 206;
        if (res.statusCode !== 200 && !isPartial) {
          res.resume();
          return rejectGet(new Error(`Download failed: ${res.statusCode}`));
        }

        // Decide once whether this response really resumes the partial file.
        if (!file) {
          const resumeOk = start > 0 && isPartial;
          const writeStart = resumeOk ? start : 0;
          file = fs.createWriteStream(destPath, { flags: resumeOk ? 'a' : 'w' });
          downloaded = writeStart;
          total = writeStart;
          finalUrl = targetUrl;
        }

        const len = parseInt(res.headers['content-length'], 10);
        if (!Number.isNaN(len)) {
          total = downloaded + len;
        }
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress) onProgress(downloaded, total);
        });
        res.on('error', (e) => failDownload(e));
        res.pipe(file);
        file.on('finish', () => resolveGet(true));
        file.on('error', (e) => failDownload(e));
      });
      req.on('error', (e) => failDownload(e));
      req.on('timeout', () => {
        req.destroy();
        failDownload(new Error('Download timeout'));
      });
    });

    doGet(url, 0)
      .then(() => {
        file.close();
        // Verify the downloaded size matches Content-Length when known
        if (total > 0) {
          const actual = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
          if (actual !== total) {
            return failDownload(new Error(`Download incomplete: ${actual}/${total} bytes`));
          }
        }
        resolve();
      })
      .catch((e) => {
        // Keep the partial file so the caller can resume from it.
        failDownload(e);
      });
  });
}

/**
 * Check for update.
 * @returns {Promise<{ hasUpdate: boolean, latestVersion: string, downloadUrl: string | null, releaseNotes: string | null, error: string | null, assetName: string | null }>}
 */
async function checkForUpdate() {
  try {
    const release = await fetchLatestRelease();
    const cmp = compareVersions(CURRENT_VERSION, release.version);

    if (cmp >= 0) {
      return {
        hasUpdate: false,
        latestVersion: release.version,
        downloadUrl: null,
        releaseNotes: null,
        error: null,
        assetName: null,
      };
    }

    const asset = findBestAsset(release.assets, detectCurrentEdition());
    if (!asset) {
      return {
        hasUpdate: true,
        latestVersion: release.version,
        downloadUrl: null,
        releaseNotes: null,
        error: `No Windows installer found in release ${release.tagName}`,
        assetName: null,
      };
    }

    return {
      hasUpdate: true,
      latestVersion: release.version,
      downloadUrl: asset.url,
      releaseNotes: null, // Could fetch release body if needed
      error: null,
      assetName: asset.name,
    };
  } catch (e) {
    return {
      hasUpdate: false,
      latestVersion: CURRENT_VERSION,
      downloadUrl: null,
      releaseNotes: null,
      error: String(e.message || e),
      assetName: null,
    };
  }
}

/**
 * Download installer with retry logic.
 * Retries up to maxRetries times on network errors / timeouts, with
 * retryDelay between attempts. Retries RESUME from the partial file
 * (Range request) instead of restarting from zero, which matters a lot
 * on slow connections.
 * @param {string} url
 * @param {(progress: number, total: number) => void} onProgress
 * @param {object} [opts] - { maxRetries=3, retryDelay=5000, timeoutMs=300000 }
 * @returns {Promise<{ destPath: string, assetName: string }>}
 */
async function downloadInstaller(url, onProgress, opts = {}) {
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : 3;
  const retryDelay = opts.retryDelay != null ? opts.retryDelay : 5000;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 300000;

  const tempDir = os.tmpdir();
  const fileName = path.basename(new URL(url).pathname);
  const destPath = path.join(tempDir, fileName);

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Resume from any existing partial file (e.g. after a failed attempt).
      let start = 0;
      try {
        if (fs.existsSync(destPath)) start = fs.statSync(destPath).size || 0;
      } catch { start = 0; }

      if (attempt > 1 && onProgress) {
        onProgress(-1, attempt); // special signal: retry
      }

      const result = await downloadFile(url, destPath, onProgress, { start, timeoutMs });
      // downloadFile resolves with undefined; verify the file really exists.
      const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
      if (size <= 0) throw new Error('Downloaded file is empty');
      return { destPath, assetName: fileName };
    } catch (e) {
      lastError = e;
      // Keep the partial file for the next attempt to resume from.

      if (attempt < maxRetries) {
        // Notify progress window about retry
        if (onProgress) onProgress(-1, attempt); // special signal: retry

        // Wait before retry
        await new Promise(r => setTimeout(r, retryDelay));
      }
    }
  }

  // All attempts failed — clean up the partial file.
  try { fs.unlinkSync(destPath); } catch {}
  throw lastError || new Error('Download failed after retries');
}

module.exports = {
  checkForUpdate,
  downloadInstaller,
  compareVersions,
  findBestAsset,
  detectCurrentEdition,
  CURRENT_VERSION,
};
