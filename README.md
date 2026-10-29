# iOS studio

A Windows application for building, signing and installing the iOS shell of
[God's Eye View](https://github.com/Neo690/gods-eye-view) without a Mac.

It is a window around the project's own control panel: the page, the buttons and
the commands are the ones `npm run ios:studio` serves inside that checkout. Only
the delivery differs — no terminal to keep open, no browser tab, its own icon,
and an installer.

## What it needs

This repository is the shell; the project lives elsewhere. The buttons run
`npm run build`, `npm run ios:payload`, `npm run ios:ipa` and `xtool dev run`
inside a God's Eye View checkout, so that checkout has to exist, with its
`node_modules` installed, and `npm` on `PATH`.

For the signing and install buttons the machine also needs what that project's
[iOS notes](https://github.com/Neo690/gods-eye-view/blob/main/ios/README.md)
describe: WSL with the Swift toolchain, `xtool` and the Darwin SDK, an Apple ID
session (`xtool auth login`) and an iPhone visible to WSL through `usbipd-win`.

The window itself needs none of that to open: it reports what is missing in its
navigator and leaves the buttons that depend on it disabled.

## Run it from source

```bash
npm install
npm start
```

The first launch asks for the checkout. It remembers the answer; **File ▸ Open
project folder…** changes it later, and `--root=<path>` overrides both:

```bash
npx electron . --root "C:/path/to/gods-eye-view"
```

## Build the app and its installer

```bash
npm run unpacked     # release/win-unpacked/iOS studio.exe, no installer
npm run installer    # release/iOS studio Setup <version>.exe
```

`--bake-root <path>` records the checkout an installed copy should open on, so a
fresh install lands on the right project instead of asking:

```bash
npm run installer -- --bake-root "C:/path/to/gods-eye-view"
```

Both builds run `build-icon.mjs` first, which draws `assets/icon.png` and
`assets/icon.ico` from the panel's favicon — a PNG encoder and an ICO writer in
plain Node, no image library.

A built copy answers for itself, which is what CI checks:

```bash
"release/win-unpacked/iOS studio.exe" --verify --root "C:/path/to/gods-eye-view"
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
| `server/`                              | the panel itself, copied from the project's `scripts/`                                          |
| `build-icon.mjs`                       | the icon, drawn from the favicon                                                                |
| `build-installer.mjs`                  | icon → bake the checkout → electron-builder → check the artifact                                |
| `electron-builder.yml`                 | what ships inside the app and how the NSIS installer behaves                                    |
| `scripts/desktop-shortcut.mjs`         | recreates the desktop shortcut with the app's icon                                              |
| `.github/workflows/ios-studio-app.yml` | builds, smoke-tests and packages on Windows                                                     |

The panel server is started as a child of the app's own binary
(`ELECTRON_RUN_AS_NODE`), so an installed copy needs no Node installation. That
is also why a build has to be smoke-tested rather than assumed: the packaged
paths are not the checkout's.

## `server/` is a copy, deliberately

The panel is maintained in God's Eye View, where `npm run ios:studio` still
serves it; this repository carries a copy so the window works without a
checkout for the page itself. When the panel changes there, copy the four files
again:

```bash
cp ../gods-eye-view/scripts/{ios-studio.mjs,ios-studio.html,build-ios-ipa.mjs,compare-ios-plists.mjs} server/
```

The `--verify` step in CI is what catches the copy drifting far enough to stop
starting.

## Licence

MIT, like the project it drives.
