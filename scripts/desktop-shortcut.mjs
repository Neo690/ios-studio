#!/usr/bin/env node

// Put the iOS studio shortcut on the Windows desktop, pointing at the app.
//
// A shortcut is machine state, not repository state: it lives on a desktop,
// names an absolute path and carries an icon, so a fresh clone — or a new
// Windows profile — has none of it. This is the command that puts it back, and
// it points at the best thing the machine actually has:
//
//   1. the installed application (per-user first, then all-users), because that
//      is the copy Windows will keep up to date;
//   2. the unpacked build in `release/win-unpacked`, for a checkout that built
//      the app but did not install it.
//
// Both carry their own icon, so the shortcut names the executable rather than
// a `.ico` that could move. With neither present there is nothing honest to
// point at, and the command says so instead of writing a dead link.
//
// Usage:  npm run shortcut

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHORTCUT_NAME = 'iOS studio.lnk';
const DESCRIPTION = 'iOS studio — build, sign and install the iOS shell';

/** Where electron-builder installs, per-user before all-users. */
export function installedExecutables(environment = process.env) {
  return [
    path.join(
      environment.LOCALAPPDATA ?? '',
      'Programs',
      'iOS studio',
      'iOS studio.exe',
    ),
    path.join(
      environment.ProgramFiles ?? 'C:\\Program Files',
      'iOS studio',
      'iOS studio.exe',
    ),
  ];
}

/**
 * What the shortcut should point at, or null when the app is neither installed
 * nor built. `exists` is injected so both branches can be tested without a
 * machine that has one of each.
 */
export function chooseShortcutTarget({
  root = ROOT,
  exists = existsSync,
  environment = process.env,
} = {}) {
  const installed = installedExecutables(environment).find((candidate) =>
    exists(candidate),
  );
  if (installed) {
    return {
      kind: 'installed',
      target: installed,
      args: '',
      workdir: path.dirname(installed),
      icon: `${installed},0`,
      detail: 'the installed application',
    };
  }

  const unpacked = path.join(root, 'release', 'win-unpacked', 'iOS studio.exe');
  if (exists(unpacked)) {
    return {
      kind: 'unpacked',
      target: unpacked,
      args: '',
      workdir: path.dirname(unpacked),
      icon: `${unpacked},0`,
      detail: 'the unpacked build (npm run unpacked)',
    };
  }

  return null;
}

/** Single-quote a value for PowerShell, so a path cannot break the script. */
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Write the shortcut and read it back in one call.
 *
 * `WScript.Shell` is the only supported way to create a `.lnk`, and the desktop
 * is resolved by Windows itself (it moves under OneDrive on some profiles),
 * which is why neither path is guessed here.
 */
function writeShortcut(target) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$shell = New-Object -ComObject WScript.Shell',
    "$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) " +
      psQuote(SHORTCUT_NAME),
    '$link = $shell.CreateShortcut($lnk)',
    `$link.TargetPath = ${psQuote(target.target)}`,
    `$link.Arguments = ${psQuote(target.args)}`,
    `$link.WorkingDirectory = ${psQuote(target.workdir)}`,
    `$link.IconLocation = ${psQuote(target.icon)}`,
    `$link.Description = ${psQuote(DESCRIPTION)}`,
    '$link.Save()',
    '$saved = $shell.CreateShortcut($lnk)',
    'Write-Output $lnk',
    'Write-Output $saved.TargetPath',
    'Write-Output $saved.Arguments',
    'Write-Output $saved.IconLocation',
  ].join('\n');

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(
      `could not write the shortcut: ${(result.stderr ?? '').trim() || result.status}`,
    );
  }
  const [shortcutPath, savedTarget, savedArgs, savedIcon] = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim());
  return { shortcutPath, savedTarget, savedArgs, savedIcon };
}

function main() {
  if (process.platform !== 'win32') {
    console.log('desktop shortcuts are a Windows feature: nothing to do here');
    return;
  }

  const target = chooseShortcutTarget();
  if (!target) {
    console.error(
      'no app to point at: run `npm run unpacked` or install it first',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`shortcut target: ${target.detail}`);

  const written = writeShortcut(target);
  // A `.lnk` that silently kept an old target would look like success, so the
  // values written are the values read back.
  const problems = [];
  if (written.savedTarget !== target.target) {
    problems.push(
      `target is ${written.savedTarget}, expected ${target.target}`,
    );
  }
  if (written.savedIcon !== target.icon) {
    problems.push(`icon is ${written.savedIcon}, expected ${target.icon}`);
  }
  if (problems.length > 0) {
    console.error(`shortcut: ${written.shortcutPath} is wrong`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log(`shortcut: ${written.shortcutPath}`);
  console.log(`  target: ${written.savedTarget}`);
  console.log(`  icon:   ${written.savedIcon}`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) main();
