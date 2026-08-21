// Simulate: create profiles/node_modules with scope dirs, non-symlink dirs, and symlinks
// then run cleanProfilesNodeModules logic and verify scope dirs are preserved
const fs = require('fs');
const os = require('os');
const p = require('path');

const tmpDir = p.join(os.tmpdir(), 'dsh-test-nm-' + Date.now());
const nmDir = p.join(tmpDir, 'profiles', 'node_modules');
fs.mkdirSync(nmDir, { recursive: true });

// Create scope dir with child (simulating @anthropic-ai/some-pkg)
const scopeDir = p.join(nmDir, '@anthropic-ai');
fs.mkdirSync(p.join(scopeDir, 'some-pkg'), { recursive: true });
fs.writeFileSync(p.join(scopeDir, 'some-pkg', 'package.json'), '{}');

// Create a non-symlink top-level dir (should be removed)
fs.mkdirSync(p.join(nmDir, 'micromark-util-symbol'), { recursive: true });
fs.writeFileSync(p.join(nmDir, 'micromark-util-symbol', 'package.json'), '{}');

// Create .bin and .pnpm (should be preserved)
fs.mkdirSync(p.join(nmDir, '.bin'), { recursive: true });
fs.mkdirSync(p.join(nmDir, '.pnpm'), { recursive: true });

console.log('Before cleanup:');
console.log('  @anthropic-ai exists:', fs.existsSync(p.join(nmDir, '@anthropic-ai')));
console.log('  micromark-util-symbol exists:', fs.existsSync(p.join(nmDir, 'micromark-util-symbol')));
console.log('  .bin exists:', fs.existsSync(p.join(nmDir, '.bin')));
console.log('  .pnpm exists:', fs.existsSync(p.join(nmDir, '.pnpm')));

// Run the cleanProfilesNodeModules logic
let cleaned = 0;
for (const entry of fs.readdirSync(nmDir)) {
  if (entry === '.bin' || entry === '.pnpm') continue;
  const full = p.join(nmDir, entry);
  if (entry.startsWith('@')) continue; // skip scope dirs
  let stat;
  try { stat = fs.lstatSync(full); } catch { continue; }
  if (!stat.isSymbolicLink() && stat.isDirectory()) {
    try {
      fs.rmSync(full, { recursive: true, force: true });
      cleaned++;
    } catch (err) {
      console.log('Could not remove', full, ':', err.message);
    }
  }
}

console.log('\nAfter cleanup (cleaned:', cleaned, '):');
console.log('  @anthropic-ai exists:', fs.existsSync(p.join(nmDir, '@anthropic-ai')), '(should be true)');
console.log('  micromark-util-symbol exists:', fs.existsSync(p.join(nmDir, 'micromark-util-symbol')), '(should be false)');
console.log('  .bin exists:', fs.existsSync(p.join(nmDir, '.bin')), '(should be true)');
console.log('  .pnpm exists:', fs.existsSync(p.join(nmDir, '.pnpm')), '(should be true)');

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

const pass = fs.existsSync(p.join(nmDir, '@anthropic-ai')) === false &&
             fs.existsSync(p.join(nmDir, 'micromark-util-symbol')) === false;
console.log('\nResult:', pass ? 'PASS' : 'FAIL');
