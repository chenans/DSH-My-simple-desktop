const { execSync } = require('child_process');
try {
  const out = execSync('wmic process where "ProcessId=13816" get CommandLine /format:list', {
    encoding: 'utf-8', timeout: 8000, windowsHide: true,
  });
  console.log(out.trim());
} catch (e) {
  console.log('error:', e.message);
}
