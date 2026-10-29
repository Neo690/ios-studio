import test from 'node:test';
import assert from 'node:assert/strict';

import { expectedPlistValues } from './compare-ios-plists.mjs';

/** What a project declared, with everything else left unstated. */
function config(overrides = {}) {
  return {
    root: 'C:\\projects\\demo',
    appName: 'MyApp',
    displayName: '',
    bundleId: '',
    version: '',
    minimumOs: '',
    sceneDelegate: '',
    ...overrides,
  };
}

test('the bundle name is compared, because it is the one thing always known', () => {
  const expected = expectedPlistValues(config());
  assert.equal(expected.CFBundleExecutable, 'MyApp');
  assert.equal(expected.CFBundleName, 'MyApp');
  assert.equal(expected.CFBundlePackageType, 'APPL');
});

test('an identifier the project never stated is not invented', () => {
  const expected = expectedPlistValues(config());
  assert.equal('CFBundleIdentifier' in expected, false);
  assert.equal('CFBundleDisplayName' in expected, false);
  assert.equal('CFBundleShortVersionString' in expected, false);
});

test('declared values are compared as declared', () => {
  const expected = expectedPlistValues(
    config({
      appName: 'Other',
      bundleId: 'com.example.other',
      displayName: 'Other App',
      version: '2.3',
      minimumOs: '17.0',
    }),
  );
  assert.equal(expected.CFBundleIdentifier, 'com.example.other');
  assert.equal(expected.CFBundleDisplayName, 'Other App');
  assert.equal(expected.CFBundleShortVersionString, '2.3');
  assert.equal(expected.CFBundleVersion, '1');
  assert.equal(expected.MinimumOSVersion, '17.0');
  assert.equal(expected.CFBundleExecutable, 'Other');
});

test('a project with no app cannot be compared', () => {
  assert.throws(
    () => expectedPlistValues(config({ appName: '' })),
    /names no iOS app/,
  );
});
