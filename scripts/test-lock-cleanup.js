// Simulate: create a stale lock file, then run the cleanup logic from main.js
const fs = require('fs');
const os = require('os');
const p = require('path');
const { execSync } = require('child_process');

const dshHome = process.env.DSH_HOME || p.join(os.homedir(), '.dsh');
const lockDir = p.join(dshHome, 'task-board');
const lockFile = p.join(lockDir, 'ledger-v2.lock');

// Step 1: Create a fake stale lock file with a dead PID
fs.mkdirSync(lockDir, { recursive: true });
const fakeLock = {
  pid: 99999, // non-existent PID
  token: 'test-token',
  startedAt: Date.now() - 60000,
};
fs.writeFileSync(lockFile, JSON.stringify(fakeLock));
console.log('Created fake lock file with dead PID 99999');

// Step 2: Verify lock file exists
console.log('Lock file exists:', fs.existsSync(lockFile));

// Step 3: Simulate the cleanup logic from killStaleDshProcesses()
let ownerPid = null;
try {
  const content = fs.readFileSync(lockFile, 'utf-8');
  const parsed = JSON.parse(content);
  if (typeof parsed.pid === 'number') ownerPid = parsed.pid;
  console.log('Owner PID from lock file:', ownerPid);
} catch (e) {
  console.log('Failed to read lock file:', e.message);
}

// Check if process is alive
let processAlive = false;
if (ownerPid && ownerPid !== process.pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${ownerPid}" /NH /FO CSV`, {
      encoding: 'utf-8', timeout: 3000, windowsHide: true,
    });
    // If output contains the PID number, process is alive
    if (out.includes(String(ownerPid))) {
      processAlive = true;
    }
  } catch {
    // tasklist failed — process is likely dead
  }
}
console.log('Process alive:', processAlive);

// Remove lock file
if (!processAlive) {
  try {
    fs.unlinkSync(lockFile);
    console.log('SUCCESS: Stale lock file removed');
  } catch (err) {
    console.log('FAILED: Could not remove lock file:', err.message);
  }
} else {
  console.log('SKIPPED: Process is still alive, not removing lock');
}

// Step 4: Verify lock file is gone
console.log('Lock file exists after cleanup:', fs.existsSync(lockFile));
