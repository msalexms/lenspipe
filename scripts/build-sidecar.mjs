import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function resolveTargetTriple() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && args[i + 1]) return args[i + 1];
    if (args[i].startsWith('--target=')) return args[i].slice('--target='.length);
  }
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;

  const map = {
    'win32:x64': 'x86_64-pc-windows-msvc',
    'win32:arm64': 'aarch64-pc-windows-msvc',
    'darwin:arm64': 'aarch64-apple-darwin',
    'darwin:x64': 'x86_64-apple-darwin',
    'linux:x64': 'x86_64-unknown-linux-gnu',
    'linux:arm64': 'aarch64-unknown-linux-gnu',
  };
  const key = `${process.platform}:${process.arch}`;
  const triple = map[key];
  if (!triple) throw new Error(`Unsupported host platform/arch for sidecar build: ${key}`);
  return triple;
}

const triple = resolveTargetTriple();
const isWindows = triple.includes('windows');
const workDir = resolve(root, 'artifacts', 'sidecar');
const bundlePath = resolve(workDir, 'server-bundle.cjs');
const blobPath = resolve(workDir, 'sea-prep.blob');
const seaConfigPath = resolve(workDir, 'sea-config.json');
const binDir = resolve(root, 'src-tauri', 'binaries');
const outputBin = resolve(binDir, `lenspipe-server-${triple}${isWindows ? '.exe' : ''}`);

await mkdir(workDir, { recursive: true });
await mkdir(binDir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'server', 'index.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});

await writeFile(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });

await copyFile(process.execPath, outputBin);

if (process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', outputBin], { stdio: 'inherit' });
}

const { inject } = await import('postject');
const blob = await readFile(blobPath);
await inject(outputBin, 'NODE_SEA_BLOB', blob, {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  overwrite: true,
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
});

if (process.platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', outputBin], { stdio: 'inherit' });
}

if (!isWindows) {
  await chmod(outputBin, 0o755);
}

const info = await stat(outputBin);
console.log(`Built Node SEA sidecar: ${outputBin} (${(info.size / (1024 * 1024)).toFixed(1)} MB)`);
