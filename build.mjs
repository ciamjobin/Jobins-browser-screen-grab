// Builds one package per browser family from the shared source in flow-screenshot-extension/.
// Usage: node build.mjs
import { mkdir, rm, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const SRC = 'flow-screenshot-extension';
const OUT = 'dist';

// Files that only one browser family needs, so the other package stays clean.
const TARGETS = {
  'chrome-edge': { manifest: 'manifest.json', drop: ['manifest.firefox.json'] },
  firefox: { manifest: 'manifest.firefox.json', drop: ['manifest.firefox.json', 'offscreen.html', 'offscreen.js'] }
};

const version = JSON.parse(await readFile(path.join(SRC, 'manifest.json'), 'utf8')).version;

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const [target, config] of Object.entries(TARGETS)) {
  const stage = path.join(OUT, target);
  await cp(SRC, stage, { recursive: true });

  if (config.manifest !== 'manifest.json') {
    await cp(path.join(stage, config.manifest), path.join(stage, 'manifest.json'));
  }
  for (const file of config.drop) {
    await rm(path.join(stage, file), { force: true });
  }

  const manifest = JSON.parse(await readFile(path.join(stage, 'manifest.json'), 'utf8'));
  if (manifest.version !== version) {
    throw new Error(`${config.manifest} is at ${manifest.version}, expected ${version}`);
  }

  const zip = path.resolve(OUT, `Flow-Screenshot-Recorder-${version}-${target}.zip`);
  await run('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${path.resolve(stage)}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`
  ]);

  const files = await readdir(stage);
  console.log(`${target.padEnd(12)} ${files.length} files -> ${path.basename(zip)}`);
}

await writeFile(path.join(OUT, 'VERSION'), `${version}\n`);
console.log(`\nBuilt version ${version} into ${OUT}/`);
