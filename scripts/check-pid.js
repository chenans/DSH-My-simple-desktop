const { execSync } = require('child_process');
try {
  const out = execSync('tasklist /FI "PID eq 13816" /NH /FO CSV', {
    encoding: 'utf-8', timeout: 5000, windowsHide: true,
  });
  console.log(out.trim());
} catch (e) {
  console.log('error:', e.message);
}
