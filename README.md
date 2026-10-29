# iOS studio

A Windows application for building, signing and installing iOS apps — without a
Mac and without Xcode.

It puts one workflow behind a window: stage the app's web bundle, build an
`.ipa`, verify what came out, sign it with an Apple ID, and install it on a
phone over USB. The toolchain — WSL, Swift, the Darwin SDK, `xtool` — stays
where it already is; this is the control surface in front of it, with its own
icon, an installer and a desktop entry instead of a terminal and a browser tab.

## What it drives

This repository is the shell; a project is the work. The buttons run the
project's own npm scripts — `build`, `ios:payload`, `ios:ipa` — and
`xtool dev run` inside the folder you point it at, then read the archive back.
That folder has to be an iOS project exposing those entry points.

Which app it builds is never written in this repository: the panel asks the
project. See [the app the project builds](#the-app-the-project-builds).

## The app the project builds

`ios/studio.json`, at the root of the checkout, is where a project says what it
is building:

```json
{
  "appName": "MyApp",
  "displayName": "My App",
  "bundleId": "com.example.myapp",
  "version": "1.0",
  "minimumOs": "16.0",
  "sceneDelegate": "MyApp.SceneDelegate"
}
```

| Key             | Required | What it decides                                                                |
| --------------- | -------- | ------------------------------------------------------------------------------ |
| `appName`       | yes      | the bundle in `Payload/<appName>.app`, and `ios/xtool/<appName>.ipa`           |
| `bundleId`      | no       | the `CFBundleIdentifier` an archive is checked against                         |
| `version`       | no       | the `CFBundleShortVersionString` expected in the built plist                   |
| `displayName`   | no       | the `CFBundleDisplayName` expected in the built plist                          |
| `minimumOs`     | no       | the `MinimumOSVersion` expected in the built plist                             |
| `sceneDelegate` | no       | the `UISceneDelegateClassName` expected; defaults to `<appName>.SceneDelegate` |

Without that file the name is inferred from the layout: exactly one folder
under `ios/` holding an `Info.plist` or a `www/` bundle is taken as the app, and
the other keys stay unknown. Unknown keys are **not compared** — a check this
app invented would only teach a build to agree with a guess. With no app to
find, the panel says so instead of building something unnamed.

## What it needs

A checkout of an iOS project with its `node_modules` installed, and `npm` on
`PATH`.

For signing and installing, the machine also needs:

- WSL (on Windows) with the Swift toolchain, `xtool` and the Darwin SDK —
  `swift --version`, `xtool --version` and `xtool sdk status` are what the
  panel checks;
- an Apple ID session (`xtool auth login`);
- an iPhone visible to WSL, which on Windows means binding it with
  [usbipd-win](https://learn.microsoft.com/en-us/windows/wsl/connect-usb).

The window itself needs none of that to open: it reports what is missing in its
navigator and leaves the buttons that depend on it disabled.

## Run it from source

```bash
npm install
npm start
```

The first launch asks for the project folder. It remembers the answer; **File ▸
Open project folder…** changes it later, and `--root=<path>` overrides both:

```bash
npx electron . --root "C:/path/to/the-ios-project"
```

## Build the app and its installer

```bash
npm run unpacked     # release/win-unpacked/iOS studio.exe, no installer
npm run installer    # release/iOS studio Setup <version>.exe
```

`--bake-root <path>` records the checkout an installed copy should open on, so a
fresh install lands on the right project instead of asking:

```bash
npm run installer -- --bake-root "C:/path/to/the-ios-project"
```

Both builds run `build-icon.mjs` first, which draws `assets/icon.png` and
`assets/icon.ico` from the panel's favicon — a PNG encoder and an ICO writer in
plain Node, no image library.

## Where the installer comes from

You do not have to build it to get it. Every push to `main` builds the app on a
Windows runner, smoke-tests the packaged copy, and publishes the installer as a
GitHub release on the [releases page](https://github.com/Neo690/ios-studio/releases).

The tag is the version in [package.json](package.json), so a release cannot
claim a version the app does not report. Releasing again means bumping that
version and pushing; pushing a second time on the same version replaces the
release's installer rather than failing, and pull requests are built to be
checked but never published. `workflow_dispatch` runs it by hand.

The published file is the one the runner downloaded and read back after
uploading — not a rebuild of the same commit, which could differ from the copy
it verified.

A built copy answers for itself, which is what CI checks:

```bash
"release/win-unpacked/iOS studio.exe" --verify --root "C:/path/to/the-ios-project"
```

It starts the panel, prints the project it opened, the port, the page size and
every toolchain check, then exits without a window.

## Put the shortcut back

A shortcut is machine state, not repository state, so a fresh clone has none:

```bash
npm run shortcut
```

It points the desktop's `iOS studio.lnk` at the installed app, or at the
unpacked build when nothing is installed, and reads the result back to be sure.

## How it is put together

| Path                                   | What it is                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `main.mjs`                             | the Electron window: picks the project folder, starts the panel, owns the menu and the shutdown |
| `server/`                              | the panel: the page, the `.ipa` build, the plist check                                          |
| `server/project.mjs`                   | which app the checkout builds, from `ios/studio.json` or the `ios/` layout                      |
| `build-icon.mjs`                       | the icon, drawn from the favicon                                                                |
| `build-installer.mjs`                  | icon → bake the checkout → electron-builder → check the artifact                                |
| `electron-builder.yml`                 | what ships inside the app and how the NSIS installer behaves                                    |
| `scripts/desktop-shortcut.mjs`         | recreates the desktop shortcut with the app's icon                                              |
| `.github/workflows/ios-studio-app.yml` | builds, smoke-tests and packages on Windows, then publishes the installer as a release          |

The panel server is started as a child of the app's own binary
(`ELECTRON_RUN_AS_NODE`), so an installed copy needs no Node installation. That
is also why a build has to be smoke-tested rather than assumed: the packaged
paths are not the checkout's.

## One tool, any iOS project

No file here names an app: the name, the bundle identifier, the version and the
plist expectations come from the checkout (`server/project.mjs`). The panel is
portable because of that — the same window drives a different project by being
pointed at it, and `--verify` in CI is what catches a build that stopped
starting.

The `--verify` step in CI is what catches the copy drifting far enough to stop
starting.

## Licence

MIT, like the project it drives.
