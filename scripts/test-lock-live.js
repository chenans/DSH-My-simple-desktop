// Simulate: lock file with a LIVE process PID (current process)
const fs = require('fs');
const os = require('os');
const p = require('path');
const { execSync } = require('child_process');

const dshHome = process.env.DSH_HOME || p.join(os.homedir(), '.dsh');
const lockDir = p.join(dshHome, 'task-board');
const lockFile = p.join(lockDir, 'ledger-v2.lock');

// Create lock file with current PID (alive)
fs.mkdirSync(lockDir, { recursive: true });
const fakeLock = {
  pid: process.pid, // this process is alive
  token: 'test-token',
  startedAt: Date.now(),
};
fs.writeFileSync(lockFile, JSON.stringify(fakeLock));
console.log('Created lock file with live PID', process.pid);

// Simulate cleanup
let ownerPid = null;
try {
  const content = fs.readFileSync(lockFile, 'utf-8');
  const parsed = JSON.parse(content);
  if (typeof parsed.pid === 'number') ownerPid = parsed.pid;
} catch {}

// In the actual code, shouldRemove is always true (we kill stale dsh first)
// But let's test the process detection logic
let processAlive = false;
if (ownerPid && ownerPid !== process.pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${ownerPid}" /NH /FO CSV`, {
      encoding: 'utf-8', timeout: 3000, windowsHide: true,
    });
    if (out.includes(String(ownerPid))) processAlive = true;
  } catch {}
} else if (ownerPid === process.pid) {
  processAlive = true; // ourselves
}
console.log('Process alive:', processAlive);

// In actual code, we remove the lock regardless (after killing stale dsh)
// because we're about to start a new dsh instance
try {
  fs.unlinkSync(lockFile);
  console.log('Lock file removed (as expected in actual code flow)');
} catch (err) {
  console.log('Failed to remove:', err.message);
}

console.log('Lock file exists after cleanup:', fs.existsSync(lockFile));
