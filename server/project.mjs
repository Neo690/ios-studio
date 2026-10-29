// Which iOS app a checkout builds, read from the checkout rather than assumed.
//
// The panel used to name one app in its own code: the `.ipa` path, the
// `Payload/<Name>.app` prefix, the bundle identifier an archive is checked
// against, the plist values a build is compared to. That is what made a general
// tool specific — a second project could not use it without editing these files.
//
// So the app is described by the project. `ios/studio.json`, when present:
//
//   {
//     "appName": "MyApp",                     required, the bundle in Payload/MyApp.app
//     "displayName": "My App",                optional
//     "bundleId": "com.example.myapp",        optional, checked when given
//     "version": "1.0",                       optional, checked when given
//     "minimumOs": "16.0",                    optional
//     "sceneDelegate": "MyApp.SceneDelegate"  optional, defaults to <appName>.SceneDelegate
//   }
//
// Without that file the name is inferred from the layout: `ios/` holds exactly
// one directory that looks like an app — a sibling `Info.plist` or a `www/`
// bundle — and that directory's name is the app. Anything that cannot be
// determined stays empty, and every check that would need it is skipped rather
// than failing on a fact nobody supplied.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_PATH = path.join('ios', 'studio.json');

/** Directories under `ios/` that are build output, never an app. */
const NOT_AN_APP = new Set(['xtool', 'build', 'DerivedData', 'node_modules']);

/** A project that cannot be read, or that names no app at all. */
export class ProjectConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectConfigError';
  }
}

/**
 * The app a checkout builds, with the paths its artefacts live at.
 *
 * `io` is injectable so both branches — a config file and a bare layout — can
 * be tested without a real project on disk.
 */
export function readProjectConfig(root, io = {}) {
  const exists = io.exists ?? existsSync;
  const readFile = io.readFile ?? ((file) => readFileSync(file, 'utf8'));
  const readdir =
    io.readdir ?? ((dir) => readdirSync(dir, { withFileTypes: true }));

  const iosDir = path.join(root, 'ios');
  const configFile = path.join(root, CONFIG_PATH);
  let appName = '';
  let displayName = '';
  let bundleId = '';
  let version = '';
  let minimumOs = '';
  let sceneDelegate = '';
  let source = '';

  if (exists(configFile)) {
    let parsed;
    try {
      parsed = JSON.parse(readFile(configFile));
    } catch (error) {
      throw new ProjectConfigError(
        `${CONFIG_PATH} is not valid JSON: ${error.message}`,
      );
    }
    const text = (key) =>
      typeof parsed?.[key] === 'string' ? parsed[key].trim() : '';
    appName = text('appName');
    if (!appName) {
      throw new ProjectConfigError(
        `${CONFIG_PATH} needs a non-empty "appName": it is the bundle name in Payload/<appName>.app`,
      );
    }
    displayName = text('displayName');
    bundleId = text('bundleId');
    version = text('version');
    minimumOs = text('minimumOs');
    sceneDelegate = text('sceneDelegate');
    source = CONFIG_PATH.split(path.sep).join('/');
  } else {
    const found = inferAppNames(iosDir, { exists, readdir });
    if (found.length === 1) {
      appName = found[0];
      source = `ios/${appName}/`;
    }
  }

  const appDir = appName ? path.join(iosDir, appName) : '';
  return {
    root,
    source,
    appName,
    displayName,
    bundleId,
    version,
    minimumOs,
    sceneDelegate: sceneDelegate || (appName ? `${appName}.SceneDelegate` : ''),
    appDir,
    wwwDir: appDir ? path.join(appDir, 'www') : '',
    ipaPath: appName ? path.join(iosDir, 'xtool', `${appName}.ipa`) : '',
    appPrefix: appName ? `Payload/${appName}.app/` : '',
  };
}

/** Directories under `ios/` that look like an app target, sorted. */
export function inferAppNames(iosDir, io = {}) {
  const exists = io.exists ?? existsSync;
  const readdir =
    io.readdir ?? ((dir) => readdirSync(dir, { withFileTypes: true }));

  let entries;
  try {
    entries = readdir(iosDir);
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !NOT_AN_APP.has(entry.name),
    )
    .filter((entry) => {
      const dir = path.join(iosDir, entry.name);
      return (
        exists(path.join(dir, 'Info.plist')) || exists(path.join(dir, 'www'))
      );
    })
    .map((entry) => entry.name)
    .sort();
}

/** The config, or an error naming what the project is missing. */
export function requireApp(config, what) {
  if (!config.appName) {
    throw new ProjectConfigError(
      `cannot ${what}: ${config.root} names no iOS app. Add ${CONFIG_PATH} with an "appName", or leave exactly one folder under ios/ holding an Info.plist or a www/ bundle.`,
    );
  }
  return config;
}
