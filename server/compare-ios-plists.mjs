#!/usr/bin/env node

// Compare the `Info.plist` an xtool build produced with the values the Xcode
// path would have written, so the two builds cannot quietly disagree.
//
// Why this exists: `ios/GodsEyeView/Info.plist` gets its identifier, executable,
// module and version through `$(...)` build settings that only Xcode expands.
// xtool needs a plain plist (`ios/Info.xtool.plist`) and fills the rest from
// `xtool.yml` and `Package.swift`. Two sources for one bundle is exactly where
// drift hides: a version string that only differs in the second build is
// invisible until something reads it — TestFlight, the App Store, an update
// check. This script reads the produced bundle and says so line by line.
//
// Usage:  node scripts/compare-ios-plists.mjs [path to a built Info.plist]
// Default: ios/xtool/GodsEyeView.app/Info.plist

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PLIST = path.join(
  ROOT,
  'ios',
  'xtool',
  'GodsEyeView.app',
  'Info.plist',
);

// What `ios/project.yml` declares for the Xcode target, which is the reference.
const XCODE_VALUES = {
  CFBundleIdentifier: 'com.godseye.view',
  CFBundleExecutable: 'GodsEyeView',
  CFBundleName: 'GodsEyeView',
  CFBundleShortVersionString: '1.0',
  CFBundleVersion: '1',
  MinimumOSVersion: '16.0',
  CFBundleDevelopmentRegion: 'en',
  CFBundleDisplayName: "God's Eye View",
  CFBundlePackageType: 'APPL',
  LSRequiresIPhoneOS: true,
  UIDeviceFamily: [1, 2],
  UIRequiredDeviceCapabilities: ['arm64'],
};

// Keys only `Info.xtool.plist` carries; losing one changes how the app runs.
const XTOOL_KEYS = [
  'NSAppTransportSecurity',
  'NSLocationWhenInUseUsageDescription',
  'NSMicrophoneUsageDescription',
  'UIApplicationSceneManifest',
  'UIStatusBarStyle',
  'UILaunchScreen',
];

const SCENE_DELEGATE = 'GodsEyeView.SceneDelegate';

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

export function compareIosPlists(plistPath = DEFAULT_PLIST) {
  if (!existsSync(plistPath)) {
    throw new Error(
      `no built plist at ${path.relative(process.cwd(), plistPath)}: run \`cd ios && xtool dev build\` first`,
    );
  }
  const text = readFileSync(plistPath, 'utf8');
  const value = reader(text);
  const lines = [];
  const failures = [];

  for (const [key, expected] of Object.entries(XCODE_VALUES)) {
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

  const scene = value('UISceneDelegateClassName');
  const sceneOk = scene === SCENE_DELEGATE;
  if (!sceneOk) failures.push('UISceneDelegateClassName');
  lines.push(
    `${sceneOk ? 'ok  ' : 'DIFF'} UISceneDelegateClassName: ${JSON.stringify(scene)}`,
  );

  return { ok: failures.length === 0, failures, lines };
}

const invoked = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invoked) {
  try {
    const result = compareIosPlists(process.argv[2] ?? DEFAULT_PLIST);
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
