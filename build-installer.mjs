#!/usr/bin/env node

// Build the standalone Windows app and its installer.
//
//   1. draw the icon (build-icon.mjs): assets/icon.png and assets/icon.ico;
//   2. record which checkout an installed copy should open on, when one is
//      named with `--bake-root <path>` — this repository is the app, not the
//      project it drives, so there is nothing here to infer it from;
//   3. package with electron-builder — an unpacked app with --dir, otherwise the
//      NSIS installer;
//   4. check the artifact is actually there, with its size, rather than trusting
//      a packager that can exit 0 with nothing to show.
//
// Flags: --dir (unpacked only), --bake-root <path>, --no-bake-root, --skip-icon,
//        --publish.
// Usage:  npm run installer -- --bake-root "C:/path/to/gods-eye-view"

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO_DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const unpackedOnly = args.includes('--dir');
const bakeRoot = !args.includes('--no-bake-root');
const skipIcon = args.includes('--skip-icon');
const publish = args.includes('--publish') ? 'always' : 'never';

/** The value of `--flag=value` or `--flag value`, empty when absent. */
function flagValue(flag) {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  const next = args[index + 1];
  return index >= 0 && next && !next.startsWith('-') ? next : '';
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    // `npx` is a .cmd shim on Windows and needs a shell; a full path to an
    // executable must not go through one, which would split it at the space in
    // `C:\Program Files`.
    shell: process.platform === 'win32' && !path.isAbsolute(command),
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(' ')} exited with ${result.status}`,
    );
  }
}

const studioPackage = JSON.parse(
  readFileSync(path.join(STUDIO_DIR, 'package.json'), 'utf8'),
);
const version = process.env.IOS_STUDIO_VERSION?.trim() || studioPackage.version;

/** Whether a folder is a checkout this panel can drive. */
function isProject(directory) {
  return (
    existsSync(path.join(directory, 'package.json')) &&
    existsSync(path.join(directory, 'scripts', 'ios-studio.mjs'))
  );
}

if (!existsSync(path.join(STUDIO_DIR, 'node_modules', 'electron-builder'))) {
  throw new Error(
    'electron-builder is not installed: run `npm install` in this directory.',
  );
}

if (!skipIcon) {
  run(process.execPath, [path.join(STUDIO_DIR, 'build-icon.mjs')], {
    cwd: STUDIO_DIR,
    shell: false,
  });
}
if (!existsSync(path.join(STUDIO_DIR, 'assets', 'icon.ico'))) {
  throw new Error('assets/icon.ico is missing: run `node build-icon.mjs`');
}

// The folder a fresh install opens on. Only a path named on the command line:
// this repository is the app, so there is no sibling project to guess at, and
// an installed copy with nothing baked asks once.
const bakedRoot = path.join(STUDIO_DIR, 'project-root.json');
const projectRoot = flagValue('--bake-root').trim();
if (bakeRoot && projectRoot && isProject(path.resolve(projectRoot))) {
  const resolved = path.resolve(projectRoot);
  writeFileSync(bakedRoot, `${JSON.stringify({ root: resolved }, null, 2)}\n`);
  console.log(`project: ${resolved}`);
} else if (bakeRoot && projectRoot) {
  throw new Error(
    `--bake-root ${projectRoot} is not a checkout: it needs package.json and scripts/ios-studio.mjs`,
  );
} else if (existsSync(bakedRoot)) {
  // A build without a path must not ship the previous build's checkout by
  // accident, so the file is emptied rather than left alone.
  writeFileSync(bakedRoot, `${JSON.stringify({ root: '' }, null, 2)}\n`);
  console.log('project: none baked; the app asks on first run');
}

console.log(
  `packaging iOS studio ${version}${unpackedOnly ? ' (unpacked only)' : ''}`,
);
run(
  'npx',
  [
    'electron-builder',
    '--win',
    unpackedOnly ? 'dir' : 'nsis',
    '--publish',
    publish,
    '--config',
    'electron-builder.yml',
    `--config.extraMetadata.version=${version}`,
  ],
  { cwd: STUDIO_DIR, env: process.env },
);

const release = path.join(STUDIO_DIR, 'release');
const megabytes = (file) =>
  `${(statSync(file).size / 1024 / 1024).toFixed(1)} MiB`;

if (unpackedOnly) {
  const exe = path.join(release, 'win-unpacked', 'iOS studio.exe');
  if (!existsSync(exe)) throw new Error(`expected ${exe} and found nothing`);
  console.log(`unpacked app: ${exe} (${megabytes(exe)})`);
} else {
  const installer = readdirSync(release)
    .filter((name) => name.endsWith('.exe') && name.includes('Setup'))
    .map((name) => path.join(release, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!installer) throw new Error(`no installer in ${release}`);
  console.log(`installer: ${installer} (${megabytes(installer)})`);
}
