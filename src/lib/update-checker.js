'use strict';

/**
 * Lightweight GitHub Release updater.
 * - Checks https://api.github.com/repos/{owner}/{repo}/releases/latest
 * - Compares versions using semver-like logic
 * - Downloads installer to %TEMP%
 * - Returns { hasUpdate, latestVersion, downloadUrl, releaseNotes, error }
 */

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
 * Find the best installer asset for Windows x64.
 * @param {Array<{name, browser_download_url}>} assets
 * @returns {{name: string, url: string} | null}
 */
function findBestAsset(assets) {
  // Prefer: *-Setup.exe (full), then *-Lite-Setup.exe
  const sorted = assets
    .filter(a => a.name.endsWith('.exe') && !a.name.includes('Portable'))
    .sort((a, b) => {
      if (a.name.includes('-Lite-')) return 1;
      if (b.name.includes('-Lite-')) return -1;
      return 0;
    });

  if (sorted.length === 0) return null;
  return {
    name: sorted[0].name,
    url: sorted[0].browser_download_url,
  };
}

/**
 * Download file to destPath with progress callback.
 * @param {string} url
 * @param {string} destPath
 * @param {(progress: number, total: number) => void} onProgress
 */
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let downloaded = 0;
    let total = 0;

    const req = https.get(url, { timeout: 120000 }, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`Download failed: ${res.statusCode}`));
      }

      total = parseInt(res.headers['content-length'], 10) || 0;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0 && onProgress) onProgress(downloaded, total);
      });

      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    });

    req.on('error', (e) => {
      file.close();
      try { fs.unlinkSync(destPath); } catch {}
      reject(e);
    });
    req.on('timeout', () => {
      req.destroy();
      file.close();
      try { fs.unlinkSync(destPath); } catch {}
      reject(new Error('Download timeout'));
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

    const asset = findBestAsset(release.assets);
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
 * Download installer and return the path.
 * @param {string} url
 * @param {(progress: number, total: number) => void} onProgress
 * @returns {Promise<string>} path to downloaded installer
 */
function downloadInstaller(url, onProgress) {
  const tempDir = os.tmpdir();
  const fileName = path.basename(new URL(url).pathname);
  const destPath = path.join(tempDir, fileName);
  return downloadFile(url, destPath, onProgress);
}

module.exports = {
  checkForUpdate,
  downloadInstaller,
  compareVersions,
  CURRENT_VERSION,
};
