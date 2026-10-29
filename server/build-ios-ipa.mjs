#!/usr/bin/env node

// Build the iOS shell end to end with xtool, then check the archive it wrote.
//
// Three steps, in the order they depend on each other:
//
//   1. `npm run build`          — the Vite bundle the shell will serve;
//   2. `npm run ios:payload`    — stage it into `ios/<appName>/www` and write
//                                 `BuildConfig.swift`;
//   3. `xtool dev build --ipa`  — compile the Swift shell and package it.
//
// The app's name and identity are not written here: they come from the project
// (`server/project.mjs`, `ios/studio.json` or the `ios/` layout), so the same
// file builds any iOS shell.
//
// xtool is a Linux tool. On Windows it runs inside WSL, so this script uses
// `wsl.exe` there and calls it directly everywhere else. That difference is the
// only platform-specific part.
//
// The verification at the end is not ceremony: `xtool dev build` exits 0 even
// when it produces nothing (it did exactly that when the package's product was
// an executable instead of a library), so the archive itself is what gets
// checked — its shape, its payload, its version, and whether it carries a
// signature it should not have.
//
// Usage:  npm run ios:ipa
//         node scripts/build-ios-ipa.mjs
//
// Environment:
//   IOS_STUDIO_WSL_DISTRO  WSL distribution to build in (default: Ubuntu)

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { readProjectConfig, requireApp } from './project.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
// The Windows studio app ships these scripts inside its own resources and runs
// them against a checkout elsewhere on disk, so the project root can be given
// explicitly (`IOS_STUDIO_PROJECT`). From a checkout nothing is set and the
// root is the directory above the scripts.
const ROOT = path.resolve(
  process.env.IOS_STUDIO_PROJECT?.trim() || path.join(SCRIPTS_DIR, '..'),
);
const IOS_DIR = path.join(ROOT, 'ios');

/** Run a command, streaming its output; throw on a non-zero status. */
function run(command, args, { cwd = ROOT } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  }
}

/**
 * Run an npm script.
 *
 * `npm` is `npm.cmd` on Windows, and Node refuses to spawn a `.cmd` without a
 * shell. Going through the CLI's own JavaScript file avoids the shell entirely,
 * and falls back to the platform's npm name when this is not run from npm.
 */
function runNpmScript(script, { cwd = ROOT } = {}) {
  const cli = process.env.npm_execpath;
  if (cli && cli.endsWith('.js')) {
    run(process.execPath, [cli, 'run', script], { cwd });
    return;
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', script], {
    cwd,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`npm run ${script} exited ${result.status}`);
}

/** `C:\repo\ios` -> `/mnt/c/repo/ios`, for passing a path into WSL. */
export function toWslPath(winPath) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!match) return winPath.replace(/\\/g, '/');
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

/** Single-quote a path for a POSIX shell. */
const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * How to run `xtool <args>` in `ios/` on this host: directly on Linux/macOS,
 * through WSL on Windows. Shared by the `.ipa` build and the studio panel, so
 * there is one copy of the WSL bridging rather than two that can drift.
 */
export function xtoolCommand(
  xtoolArgs,
  {
    platform = process.platform,
    distro = process.env.IOS_STUDIO_WSL_DISTRO ?? 'Ubuntu',
    iosDir = IOS_DIR,
  } = {},
) {
  if (platform !== 'win32') {
    return { command: 'xtool', args: xtoolArgs, cwd: iosDir, shell: false };
  }

  // `bash -lc` does not put swiftly's shims on PATH (Ubuntu's .bashrc returns
  // early for non-interactive shells), so name the two directories explicitly.
  const script = [
    'export PATH="$HOME/.local/share/swiftly/bin:$HOME/.local/bin:$PATH"',
    `cd ${shellQuote(toWslPath(iosDir))}`,
    `xtool ${xtoolArgs.join(' ')}`,
  ].join(' && ');
  return {
    command: 'wsl.exe',
    args: ['-d', distro, '--', 'bash', '-c', script],
    cwd: ROOT,
    shell: false,
  };
}

/** The command that runs `xtool dev build --ipa` in `ios/`. */
export function xtoolIpaCommand(options = {}) {
  return xtoolCommand(['dev', 'build', '--ipa'], options);
}

/** Read the entries of a zip through its central directory. */
export function readZipEntries(buffer) {
  const eocdSignature = 0x06054b50;
  const searchFrom = Math.max(0, buffer.length - 66_000);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= searchFrom; offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0)
    throw new Error('not a zip archive: no end-of-central-directory record');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`corrupt central directory at entry ${index}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The bytes of one entry, inflated if it was deflated. */
export function readZipEntry(buffer, entry) {
  const header = entry.localHeaderOffset;
  if (buffer.readUInt32LE(header) !== 0x04034b50) {
    throw new Error(`corrupt local header for ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(
    `unsupported compression method ${entry.method} for ${entry.name}`,
  );
}

/**
 * Check the produced archive the way an installer would: the app is inside
 * `Payload/`, the console is inside the app, the version is the one we pinned,
 * and no signature claims something the build did not do.
 */
export function verifyIpa(
  ipaPath,
  { appName = '', bundleId = '', expectVersion = '' } = {},
) {
  requireApp({ appName, root: ROOT }, 'check an .ipa');
  const appPrefix = `Payload/${appName}.app/`;
  if (!existsSync(ipaPath)) {
    throw new Error(
      `no .ipa at ${path.relative(ROOT, ipaPath)}: xtool reported success but wrote nothing`,
    );
  }
  const buffer = readFileSync(ipaPath);
  const entries = readZipEntries(buffer);
  const names = entries.map((entry) => entry.name);
  const problems = [];

  const required = [
    `${appPrefix}${appName}`,
    `${appPrefix}Info.plist`,
    `${appPrefix}www/index.html`,
  ];
  for (const name of required) {
    if (!names.includes(name)) problems.push(`missing ${name}`);
  }

  const wwwFiles = names.filter(
    (name) => name.startsWith(`${appPrefix}www/`) && !name.endsWith('/'),
  );
  if (wwwFiles.length < 100) {
    problems.push(
      `www/ carries only ${wwwFiles.length} files; was the payload staged?`,
    );
  }

  const signed = names.filter((name) => name.includes('_CodeSignature'));
  if (signed.length > 0) {
    problems.push(
      `archive is signed (${signed.length} entries): this build signs nothing`,
    );
  }

  let plistSummary = '';
  const plistEntry = entries.find(
    (entry) => entry.name === `${appPrefix}Info.plist`,
  );
  if (plistEntry) {
    const plist = readZipEntry(buffer, plistEntry).toString('utf8');
    const version =
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(
        plist,
      )?.[1];
    const identifier =
      /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(
        plist,
      )?.[1];
    // Only what the project declared is checked: an identifier or a version
    // the project never stated is not a fact this file is entitled to invent.
    if (expectVersion && version !== expectVersion) {
      problems.push(
        `CFBundleShortVersionString is ${version}, expected ${expectVersion}`,
      );
    }
    if (bundleId && identifier !== bundleId) {
      problems.push(
        `CFBundleIdentifier is ${identifier}, expected ${bundleId}`,
      );
    }
    plistSummary = `${identifier} ${version}`;
  }

  return {
    bytes: statSync(ipaPath).size,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    entries: entries.length,
    wwwFiles: wwwFiles.length,
    signed: signed.length,
    plistSummary,
    problems,
  };
}

/**
 * The values a provisioning profile carries, read out of its CMS container.
 *
 * Apple wraps the profile in a PKCS#7 signature, but the payload inside it is
 * plain XML, so the plist is found by its own bounds rather than by parsing
 * ASN.1. `latin1` keeps every byte in one character, which is what makes the
 * offsets in the decoded text line up with the file.
 */
export function parseMobileProvision(buffer) {
  const empty = {
    name: '',
    teamId: '',
    applicationIdentifier: '',
    uuid: '',
    expiresAt: '',
  };
  const text = buffer.toString('latin1');
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>');
  if (start < 0 || end < start) return empty;
  const xml = text.slice(start, end + '</plist>'.length);

  const afterKey = (key) => {
    const needle = `<key>${key}</key>`;
    const at = xml.indexOf(needle);
    return at < 0 ? '' : xml.slice(at + needle.length);
  };
  const firstValue = (block) => {
    const string = /^\s*<string>([^<]*)<\/string>/.exec(block);
    if (string) return string[1];
    const date = /^\s*<date>([^<]*)<\/date>/.exec(block);
    if (date) return date[1];
    // TeamIdentifier is an array; its first entry identifies the team.
    const array = /^\s*<array>([\s\S]*?)<\/array>/.exec(block);
    if (array) return /<string>([^<]*)<\/string>/.exec(array[1])?.[1] ?? '';
    return '';
  };

  return {
    name: firstValue(afterKey('Name')),
    teamId: firstValue(afterKey('TeamIdentifier')),
    applicationIdentifier: firstValue(afterKey('application-identifier')),
    uuid: firstValue(afterKey('UUID')),
    expiresAt: firstValue(afterKey('ExpirationDate')),
  };
}

/**
 * What an installer would make of these two artefacts.
 *
 * iOS runs code only if it carries a signature whose profile covers the device,
 * so "signed" and "installable as-is" are not the same claim: a profile can be
 * present and expired, or a signature can exist with no profile at all (which
 * installs only after re-signing, or on a jailbroken device). A free Apple ID's
 * profile lasts seven days, so the expiry is reported with the days left rather
 * than as a date the reader has to subtract.
 */
export function describeSignature({
  codeSignature = false,
  profile = null,
  now = new Date(),
} = {}) {
  const who = profile
    ? [profile.name, profile.teamId].filter(Boolean).join(' · ')
    : '';
  const verdict = (fields) => ({
    signed: false,
    installableAsIs: false,
    daysLeft: null,
    hoursLeft: null,
    expiresSoon: false,
    expiresAt: '',
    ...fields,
  });

  if (!codeSignature && !profile) {
    return verdict({ detail: 'unsigned · iOS refuses it as-is' });
  }
  if (!codeSignature) {
    return verdict({
      expiresAt: profile.expiresAt,
      detail:
        'provisioning profile present but no code signature · iOS refuses it as-is',
    });
  }
  if (!profile) {
    return verdict({
      signed: true,
      detail:
        'signed without a provisioning profile · installs only after a re-sign',
    });
  }

  const expiresAt = profile.expiresAt;
  const parsed = Date.parse(expiresAt);
  const hoursLeft = Number.isNaN(parsed)
    ? null
    : Math.floor((parsed - now.getTime()) / 3_600_000);
  const daysLeft = hoursLeft === null ? null : Math.floor(hoursLeft / 24);
  const suffix = who ? ` · ${who}` : '';

  if (daysLeft === null) {
    return verdict({
      signed: true,
      expiresAt,
      detail: `signed, profile has no readable expiry${suffix}`,
    });
  }
  const day = expiresAt.slice(0, 10);
  if (daysLeft < 0) {
    return verdict({
      signed: true,
      daysLeft,
      hoursLeft,
      expiresAt,
      detail: `profile expired ${day} (${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago) · rebuild to sign again${suffix}`,
    });
  }
  return {
    signed: true,
    installableAsIs: true,
    daysLeft,
    hoursLeft,
    // A free Apple ID's profile lasts seven days, so its last two are the ones
    // worth acting on: past them the app stops launching and the phone needs a
    // freshly signed build. The hours are what make that visible a day early.
    expiresSoon: hoursLeft < 48,
    expiresAt,
    detail: `signed · profile expires ${day} (${daysLeft} day${daysLeft === 1 ? '' : 's'} left)${suffix}`,
  };
}

/** Whether the archive on disk would install as it stands, and until when. */
export function inspectIpaSignature(
  ipaPath,
  { now = new Date(), appName = '' } = {},
) {
  // Without a name any app inside `Payload/` will do: the signature and the
  // profile are properties of the bundle, not of what it is called.
  const appPrefix = appName ? `Payload/${appName}.app/` : 'Payload/';
  if (!existsSync(ipaPath)) {
    return {
      exists: false,
      ...describeSignature({ now }),
      detail: 'no .ipa yet — Build .ipa writes one',
    };
  }
  const buffer = readFileSync(ipaPath);
  const entries = readZipEntries(buffer);
  const inApp = (suffix) =>
    entries.find(
      (entry) =>
        entry.name.startsWith(appPrefix) && entry.name.endsWith(suffix),
    );
  const codeResources = inApp('_CodeSignature/CodeResources');
  const profileEntry = inApp('embedded.mobileprovision');
  const profile = profileEntry
    ? parseMobileProvision(readZipEntry(buffer, profileEntry))
    : null;
  return {
    exists: true,
    bytes: statSync(ipaPath).size,
    ...describeSignature({
      codeSignature: Boolean(codeResources),
      profile,
      now,
    }),
  };
}

export function buildIosIpa({ log = console.log } = {}) {
  const project = requireApp(readProjectConfig(ROOT), 'build the .ipa');

  log('== building the web bundle ==');
  runNpmScript('build');

  log('\n== staging it inside the iOS shell ==');
  runNpmScript('ios:payload');

  log('\n== compiling and packaging with xtool ==');
  const xtool = xtoolIpaCommand();
  if (
    xtool.command === 'wsl.exe' &&
    spawnSync('wsl.exe', ['--status']).status !== 0
  ) {
    throw new Error('WSL is not available; install it or run this on Linux');
  }
  run(xtool.command, xtool.args, { cwd: xtool.cwd });

  log('\n== checking the archive ==');
  const report = verifyIpa(project.ipaPath, {
    appName: project.appName,
    bundleId: project.bundleId,
    expectVersion: project.version,
  });
  log(`ipa:    ${path.relative(ROOT, project.ipaPath)}`);
  log(`size:   ${(report.bytes / 1024 / 1024).toFixed(1)} MiB`);
  log(`sha256: ${report.sha256}`);
  log(`plist:  ${report.plistSummary}`);
  log(
    `payload: ${report.wwwFiles} files under www/, ${report.entries} archive entries, ${report.signed} signature entries`,
  );
  if (report.problems.length > 0) {
    throw new Error(
      `the .ipa is not installable as built:\n  ${report.problems.join('\n  ')}`,
    );
  }
  return report;
}

const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) {
  try {
    buildIosIpa();
  } catch (error) {
    console.error(`\nios ipa failed: ${error.message}`);
    process.exitCode = 1;
  }
}
