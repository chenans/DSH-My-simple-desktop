const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const p = require('path');

const lockFile = p.join(os.homedir(), '.dsh', 'task-board', 'ledger-v2.lock');
if (fs.existsSync(lockFile)) {
  const content = fs.readFileSync(lockFile, 'utf-8');
  const parsed = JSON.parse(content);
  console.log('Lock file PID:', parsed.pid);
  
  try {
    const out = execSync('tasklist /FI "PID eq ' + parsed.pid + '" /FO CSV /NH', {
      encoding: 'utf-8', timeout: 5000, windowsHide: true,
    });
    console.log('Process status:', out.trim());
  } catch (e) {
    console.log('Process check error:', e.message);
  }
} else {
  console.log('No lock file');
}
