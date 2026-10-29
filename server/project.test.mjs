import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  readProjectConfig,
  inferAppNames,
  requireApp,
  ProjectConfigError,
} from './project.mjs';

const root = 'C:\\projects\\demo';

/**
 * A filesystem made of paths, so both branches — a config file and a bare
 * `ios/` layout — can be exercised without creating either on disk.
 */
function fakeIo({ files = {}, dirs = {} } = {}) {
  const normal = (value) => path.normalize(value);
  const contents = new Map(
    Object.entries(files).map(([file, text]) => [normal(file), text]),
  );
  const entries = new Map(
    Object.entries(dirs).map(([dir, names]) => [normal(dir), names]),
  );
  return {
    exists: (file) => contents.has(normal(file)) || entries.has(normal(file)),
    readFile: (file) => {
      const text = contents.get(normal(file));
      if (text === undefined) throw new Error(`ENOENT ${file}`);
      return text;
    },
    readdir: (dir) => {
      const names = entries.get(normal(dir));
      if (!names) throw new Error(`ENOENT ${dir}`);
      return names.map((name) => ({
        name,
        isDirectory: () => true,
        isFile: () => false,
      }));
    },
  };
}

const configFile = path.join(root, 'ios', 'studio.json');

test('studio.json names the app and derives the artefact paths', () => {
  const config = readProjectConfig(
    root,
    fakeIo({
      files: {
        [configFile]: JSON.stringify({
          appName: 'MyApp',
          displayName: 'My App',
          bundleId: 'com.example.myapp',
          version: '1.0',
          minimumOs: '16.0',
        }),
      },
    }),
  );

  assert.equal(config.appName, 'MyApp');
  assert.equal(config.bundleId, 'com.example.myapp');
  assert.equal(config.version, '1.0');
  assert.equal(config.source, 'ios/studio.json');
  assert.equal(config.appPrefix, 'Payload/MyApp.app/');
  assert.equal(config.ipaPath, path.join(root, 'ios', 'xtool', 'MyApp.ipa'));
  assert.equal(config.wwwDir, path.join(root, 'ios', 'MyApp', 'www'));
  // Not stated by the project, so derived from the module name.
  assert.equal(config.sceneDelegate, 'MyApp.SceneDelegate');
});

test('a declared scene delegate wins over the derived one', () => {
  const config = readProjectConfig(
    root,
    fakeIo({
      files: {
        [configFile]: JSON.stringify({
          appName: 'MyApp',
          sceneDelegate: 'MyApp.RootScene',
        }),
      },
    }),
  );
  assert.equal(config.sceneDelegate, 'MyApp.RootScene');
  assert.equal(config.bundleId, '');
});

test('a config without an app name is an error, not a guess', () => {
  assert.throws(
    () =>
      readProjectConfig(
        root,
        fakeIo({ files: { [configFile]: JSON.stringify({ bundleId: 'x' }) } }),
      ),
    ProjectConfigError,
  );
});

test('a config that is not JSON says so', () => {
  assert.throws(
    () => readProjectConfig(root, fakeIo({ files: { [configFile]: '{oops' } })),
    /not valid JSON/,
  );
});

test('without a config, the app is the one app-shaped folder under ios/', () => {
  const config = readProjectConfig(
    root,
    fakeIo({
      files: {
        [path.join(root, 'ios', 'MyApp', 'Info.plist')]: '<plist/>',
      },
      dirs: { [path.join(root, 'ios')]: ['MyApp', 'xtool'] },
    }),
  );
  assert.equal(config.appName, 'MyApp');
  assert.equal(config.source, 'ios/MyApp/');
  assert.equal(config.ipaPath, path.join(root, 'ios', 'xtool', 'MyApp.ipa'));
});

test('a www/ bundle alone is enough to recognise an app', () => {
  const names = inferAppNames(path.join(root, 'ios'), {
    exists: (file) =>
      path.normalize(file) === path.join(root, 'ios', 'App', 'www'),
    readdir: () => [
      { name: 'App', isDirectory: () => true },
      { name: 'DerivedData', isDirectory: () => true },
      { name: '.bsp', isDirectory: () => true },
    ],
  });
  assert.deepEqual(names, ['App']);
});

test('two candidates leave the app unnamed rather than picked', () => {
  const io = fakeIo({
    files: {
      [path.join(root, 'ios', 'One', 'Info.plist')]: '<plist/>',
      [path.join(root, 'ios', 'Two', 'www')]: '',
    },
    dirs: { [path.join(root, 'ios')]: ['One', 'Two'] },
  });
  const config = readProjectConfig(root, io);
  assert.equal(config.appName, '');
  assert.equal(config.ipaPath, '');
  assert.throws(() => requireApp(config, 'build the .ipa'), /names no iOS app/);
});

test('a checkout with no ios/ at all is left unnamed', () => {
  const config = readProjectConfig(root, fakeIo({}));
  assert.equal(config.appName, '');
  assert.equal(config.source, '');
  assert.throws(
    () => requireApp(config, 'compare a plist'),
    ProjectConfigError,
  );
});
