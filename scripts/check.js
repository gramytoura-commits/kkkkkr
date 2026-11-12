'use strict';

// Syntax-checks every backend source file with `node --check`, so a typo in any
// module fails `npm run check` (and CI) without starting the server. Portable:
// no shell globbing, works the same on every OS.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'data', 'test-data', 'local-data', '.git', 'scripts']);

function collect(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...collect(path.join(dir, entry.name)));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

// Top-level source files plus everything under src/ and admin/.
const targets = [
  ...collect(ROOT).filter((f) => path.dirname(f) === ROOT),
  ...collect(path.join(ROOT, 'src')),
  ...collect(path.join(ROOT, 'admin'))
];

let failed = 0;
for (const file of targets) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failed += 1;
    process.stderr.write(`✖ ${path.relative(ROOT, file)}\n${error.stderr || error.message}\n`);
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed the syntax check.`);
  process.exit(1);
}
console.log(`✓ ${targets.length} source files passed the syntax check.`);
