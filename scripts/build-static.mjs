import { rmSync, mkdirSync, cpSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = resolve(ROOT, 'public');
const DEST = resolve(ROOT, 'dist');

// 1. Remove existing dist/
rmSync(DEST, { recursive: true, force: true });

// 2. Create dist/
mkdirSync(DEST, { recursive: true });

// 3. Copy public/ -> dist/
cpSync(SRC, DEST, { recursive: true });

// 4. Verify dist/index.html exists
if (!existsSync(resolve(DEST, 'index.html'))) {
  throw new Error('Build failed: dist/index.html not found after copy.');
}

console.log('Build OK: public/ copied to dist/');
console.log('  - dist/index.html exists');
