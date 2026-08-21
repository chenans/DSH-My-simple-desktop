const { execSync } = require('child_process');
try {
  const out = execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv', {
    encoding: 'utf-8', timeout: 8000, windowsHide: true,
  });
  const lines = out.split('\n').filter(l => l.trim());
  for (const line of lines) {
    if (line.toLowerCase().includes('processid') || line.toLowerCase().includes('commandline')) continue;
    const parts = line.split(',');
    const pid = parts[parts.length - 1].trim();
    const cmd = parts.slice(0, -1).join(',').toLowerCase();
    if (cmd.includes('dsh') && !cmd.includes('dsh-my-simple-desktop') && !cmd.includes('electron')) {
      console.log('Stale dsh pid:', pid);
      try {
        execSync('taskkill /PID ' + pid + ' /T /F', { stdio: 'ignore', timeout: 3000, windowsHide: true });
        console.log('killed');
      } catch (e) { console.log('kill failed:', e.message); }
    }
  }
} catch (e) { console.log('wmic failed:', e.message); }
