#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pkg from '../package.json' with { type: 'json' };

const electronVersion = '33.4.11';
const supportedArchs = new Set(['x64', 'arm64']);
const supportedFlags = new Set(['no-notarize']);
const args = process.argv.slice(2).map((arg) => arg.replace(/^--/, ''));
const invalidArgs = args.filter((arg) => !supportedArchs.has(arg) && !supportedFlags.has(arg));

if (invalidArgs.length > 0) {
  console.error(`[build:mac] unsupported architecture: ${invalidArgs.join(', ')}`);
  console.error('[build:mac] supported arguments: x64, arm64, --no-notarize');
  process.exit(1);
}

const requestedArchs = args.filter((arg) => supportedArchs.has(arg));
const archs = requestedArchs.length > 0 ? requestedArchs : ['x64', 'arm64'];
const shouldNotarize = !args.includes('no-notarize');

if (String(process.env.BAILONGMA_CODESIGN_TIMESTAMP || '').trim().toLowerCase() === 'none') {
  console.error('[build:mac] BAILONGMA_CODESIGN_TIMESTAMP=none is forbidden for release artifacts');
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`[build:mac] ${command} failed: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function cleanRequestedArtifacts() {
  if (archs.length > 1) {
    run('node', ['scripts/prebuild-clean.mjs']);
    return;
  }
  const arch = archs[0];
  const dist = path.resolve('dist');
  const appOutDir = path.join(dist, arch === 'x64' ? 'mac' : 'mac-arm64');
  const prefix = path.join(dist, `${pkg.productName || 'Bailongma'}-${pkg.version}-mac-${arch}`);
  const targets = [
    appOutDir,
    `${prefix}.zip`,
    `${prefix}.zip.blockmap`,
    `${prefix}.dmg`,
    `${prefix}.dmg.blockmap`,
    path.join(dist, `notary-app-${arch}.json`),
    path.join(dist, `notary-dmg-${arch}.json`),
  ];
  for (const target of targets) fs.rmSync(target, { recursive: true, force: true });
  console.log(`[build:mac] removed existing ${arch} app, artifacts, blockmaps, and notarization state`);
}

run('node', ['scripts/check-native-dependency-versions.mjs']);
cleanRequestedArtifacts();
run('node', ['scripts/prepare-macos-native-deps.mjs', ...archs]);
run('node', [
  'scripts/prepare-playwright-browsers.mjs',
  '--platform=darwin',
  ...archs.map((arch) => `--arch=${arch}`),
]);
run('node', [
  'scripts/prepare-node-runtime.mjs',
  '--platform=darwin',
  ...archs.map((arch) => `--arch=${arch}`),
]);
for (const arch of archs) {
  console.log(`[build:mac] building native macOS speech helper for ${arch}`);
  run('node', ['scripts/build-macos-speech.mjs', arch, '--required']);

  console.log(`[build:mac] rebuilding better-sqlite3 for ${arch}`);
  run('node', [
    './node_modules/@electron/rebuild/lib/cli.js',
    '-f',
    '-w',
    'better-sqlite3',
    '-v',
    electronVersion,
    '-a',
    arch,
  ]);

  console.log(`[build:mac] building signed ${arch} app${shouldNotarize ? ' and submitting it to Apple' : ' without Apple notarization'}`);
  const previousMode = process.env.BAILONGMA_NOTARY_MODE;
  process.env.BAILONGMA_NOTARY_MODE = shouldNotarize ? 'submit' : 'skip';
  run('node', ['./node_modules/electron-builder/cli.js', '--mac', 'dir', `--${arch}`]);
  if (previousMode === undefined) delete process.env.BAILONGMA_NOTARY_MODE;
  else process.env.BAILONGMA_NOTARY_MODE = previousMode;
}

if (shouldNotarize) {
  console.log('[build:mac] waiting for app notarization and stapling accepted tickets');
  run('node', ['scripts/finalize-macos-notarization.mjs', 'app', ...archs]);
}

for (const arch of archs) {
  const appOutDir = arch === 'x64' ? 'dist/mac' : 'dist/mac-arm64';
  console.log(`[build:mac] packaging ${shouldNotarize ? 'stapled ' : ''}${arch} app as DMG and update ZIP`);
  const previousMode = process.env.BAILONGMA_NOTARY_MODE;
  process.env.BAILONGMA_NOTARY_MODE = shouldNotarize ? 'submit' : 'skip';
  run('node', [
    './node_modules/electron-builder/cli.js', '--mac', 'dmg', 'zip', `--${arch}`,
    '--prepackaged', `${appOutDir}/Bailongma.app`,
  ]);
  if (previousMode === undefined) delete process.env.BAILONGMA_NOTARY_MODE;
  else process.env.BAILONGMA_NOTARY_MODE = previousMode;
}

if (shouldNotarize) {
  console.log('[build:mac] waiting for DMG notarization, stapling, and rebuilding final blockmaps');
  run('node', ['scripts/finalize-macos-notarization.mjs', 'dmg', ...archs]);
}
fs.writeFileSync(path.resolve('dist', 'mac-build-metadata.json'), `${JSON.stringify({
  version: pkg.version,
  archs,
  notarized: shouldNotarize,
}, null, 2)}\n`, { mode: 0o600 });
run('node', ['scripts/smoke-mac-artifacts.mjs', ...archs, ...(shouldNotarize ? [] : ['--no-notarize'])]);
