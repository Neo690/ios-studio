import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseShortcutTarget,
  installedExecutables,
} from './desktop-shortcut.mjs';

const environment = {
  LOCALAPPDATA: 'C:\\Users\\ghost\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
};
const root = 'C:\\repo\\ios-studio';
const unpacked = `${root}\\release\\win-unpacked\\iOS studio.exe`;
const [perUser, allUsers] = installedExecutables(environment);

/** A target chosen against a machine that only has `present` on disk. */
function choose(present) {
  const found = new Set(present);
  return chooseShortcutTarget({
    root,
    environment,
    exists: (candidate) => found.has(candidate),
  });
}

test('an installed app is preferred, with its own icon', () => {
  const target = choose([perUser]);
  assert.equal(target.kind, 'installed');
  assert.equal(target.target, perUser);
  assert.equal(target.args, '');
  assert.equal(
    target.workdir,
    'C:\\Users\\ghost\\AppData\\Local\\Programs\\iOS studio',
  );
  assert.equal(target.icon, `${perUser},0`);
});

test('an all-users install is found when the per-user one is absent', () => {
  const target = choose([allUsers]);
  assert.equal(target.kind, 'installed');
  assert.equal(target.target, allUsers);
});

test('an installed app beats the unpacked build in the same checkout', () => {
  const target = choose([perUser, unpacked]);
  assert.equal(target.target, perUser);
});

test('the unpacked build is used when nothing is installed', () => {
  const target = choose([unpacked]);
  assert.equal(target.kind, 'unpacked');
  assert.equal(target.target, unpacked);
  assert.equal(target.icon, `${unpacked},0`);
});

test('with neither, there is no target rather than a dead link', () => {
  assert.equal(choose([]), null);
});
