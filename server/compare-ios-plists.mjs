#!/usr/bin/env node

// Compare the `Info.plist` an xtool build produced with the values the Xcode
// path would have written, so the two builds cannot quietly disagree.
//
// Why this exists: `ios/<appName>/Info.plist` gets its identifier, executable,
// module and version through `$(...)` build settings that only Xcode expands.
// xtool needs a plain plist (`ios/Info.xtool.plist`) and fills the rest from
// `xtool.yml` and `Package.swift`. Two sources for one bundle is exactly where
// drift hides: a version string that only differs in the second build is
// invisible until something reads it — TestFlight, the App Store, an update
// check. This script reads the produced bundle and says so line by line.
//
// What is expected comes from the project (`server/project.mjs`): the bundle
// name always, and the identifier, display name, version and minimum iOS only
// when the project declares them. A value this file invented would just teach
// the build to agree with a guess.
//
// Usage:  node server/compare-ios-plists.mjs [path to a built Info.plist]
// Default: ios/xtool/<appName>.app/Info.plist

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readProjectConfig, requireApp } from './project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The same override the rest of the panel honours: a packaged copy runs these
// scripts against a checkout elsewhere on disk.
const ROOT = path.resolve(
  process.env.IOS_STUDIO_PROJECT?.trim() || path.join(HERE, '..'),
);

// Keys only `Info.xtool.plist` carries; losing one changes how the app runs.
const XTOOL_KEYS = [
  'NSAppTransportSecurity',
  'NSLocationWhenInUseUsageDescription',
  'NSMicrophoneUsageDescription',
  'UIApplicationSceneManifest',
  'UIStatusBarStyle',
  'UILaunchScreen',
];

/** Read one key out of the XML plist. Enough for scalars and flat arrays. */
function reader(text) {
  return (key) => {
    const string = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
    const match = string.exec(text);
    if (match) return match[1];
    const bool = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`).exec(text);
    if (bool) return bool[1] === 'true';
    const array = new RegExp(
      `<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`,
    ).exec(text);
    if (array) {
      // These arrays mix strings and integers (`UIDeviceFamily` is `<integer>`).
      return [
        ...array[1].matchAll(
          /<integer>([^<]*)<\/integer>|<string>([^<]*)<\/string>/g,
        ),
      ].map((entry) => (entry[1] !== undefined ? Number(entry[1]) : entry[2]));
    }
    return undefined;
  };
}

/** The values `ios/project.yml` declares, as far as the project stated them. */
export function expectedPlistValues(config) {
  const app = requireApp(config, 'compare a plist');
  const expected = {
    CFBundleExecutable: app.appName,
    CFBundleName: app.appName,
    CFBundlePackageType: 'APPL',
    CFBundleDevelopmentRegion: 'en',
    LSRequiresIPhoneOS: true,
    UIDeviceFamily: [1, 2],
    UIRequiredDeviceCapabilities: ['arm64'],
  };
  if (app.bundleId) expected.CFBundleIdentifier = app.bundleId;
  if (app.displayName) expected.CFBundleDisplayName = app.displayName;
  if (app.version) {
    expected.CFBundleShortVersionString = app.version;
    expected.CFBundleVersion = '1';
  }
  if (app.minimumOs) expected.MinimumOSVersion = app.minimumOs;
  return expected;
}

export function compareIosPlists(plistPath, config) {
  const app = requireApp(config, 'compare a plist');
  const file =
    plistPath ||
    path.join(app.root, 'ios', 'xtool', `${app.appName}.app`, 'Info.plist');
  if (!existsSync(file)) {
    throw new Error(
      `no built plist at ${path.relative(process.cwd(), file)}: run \`cd ios && xtool dev build\` first`,
    );
  }
  const text = readFileSync(file, 'utf8');
  const value = reader(text);
  const lines = [];
  const failures = [];

  for (const [key, expected] of Object.entries(expectedPlistValues(app))) {
    const actual = value(key);
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures.push(key);
    lines.push(
      `${ok ? 'ok  ' : 'DIFF'} ${key}: ${JSON.stringify(actual)}${
        ok ? '' : ` (project.yml says ${JSON.stringify(expected)})`
      }`,
    );
  }

  for (const key of XTOOL_KEYS) {
    const present = text.includes(`<key>${key}</key>`);
    if (!present) failures.push(key);
    lines.push(`${present ? 'ok  ' : 'MISS'} ${key}`);
  }

  // The delegate class is named after the app's module, so it is compared only
  // when the project builds one this panel knows how to name.
  if (app.sceneDelegate) {
    const scene = value('UISceneDelegateClassName');
    const sceneOk = scene === app.sceneDelegate;
    if (!sceneOk) failures.push('UISceneDelegateClassName');
    lines.push(
      `${sceneOk ? 'ok  ' : 'DIFF'} UISceneDelegateClassName: ${JSON.stringify(scene)}`,
    );
  }

  return { ok: failures.length === 0, failures, lines };
}

const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) {
  try {
    const config = readProjectConfig(ROOT);
    const result = compareIosPlists(process.argv[2] ?? '', config);
    for (const line of result.lines) console.log(line);
    console.log(
      result.ok
        ? '\nthe xtool bundle reports what the Xcode spec declares'
        : `\n${result.failures.length} divergence(s) from ios/project.yml`,
    );
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`ios plist comparison failed: ${error.message}`);
    process.exitCode = 1;
  }
}
