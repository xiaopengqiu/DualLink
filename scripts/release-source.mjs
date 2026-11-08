import { zipSync } from 'fflate';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const release = path.join(root, 'release');
await mkdir(release, { recursive: true });
const outputPath = path.join(release, `DualLink-source-${version}.zip`);
const files = {};
const excluded = new Set(['node_modules', '.git', '.codex', '.claude', 'release', 'data', '.local', 'dist', 'build', 'out', 'coverage', '.cache', '.vite', 'credentials', 'test-results', 'playwright-report']);
const sensitiveFiles = new Set(['auth.json', '.credentials.json', 'credentials.json']);
async function add(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || sensitiveFiles.has(entry.name) || entry.name.endsWith('.log') || (entry.name.startsWith('.env') && entry.name !== '.env.example')) continue;
    const absolute = path.join(directory, entry.name);
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) await add(absolute, name);
    else if (entry.isFile()) files[name] = [new Uint8Array(await readFile(absolute)), { level: 9, os: 3, attrs: (entry.name.endsWith('.sh') ? 0o100755 : 0o100644) << 16 }];
  }
}
await add(root);
const zip = zipSync(files);
await writeFile(outputPath, zip);
console.log(`${outputPath} (${zip.byteLength} bytes)`);
