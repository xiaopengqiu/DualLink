import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../release/', import.meta.url));
const names = [
  ...(await readdir(root)).filter(name => /^DualLink-(source|web)-.*\.zip$/.test(name)),
  ...(await readdir(path.join(root, 'windows'))).filter(name => /^DualLink-.*\.exe$/.test(name)).map(name => `windows/${name}`)
].sort();
const lines = [];
for (const name of names) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path.join(root, name))) hash.update(bytes);
  lines.push(`${hash.digest('hex')}  ${name}`);
}
await writeFile(path.join(root, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
