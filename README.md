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
That folder has to be an iOS project exposing those entry points. The one this
was written for is [God's Eye View](https://github.com/Neo690/gods-eye-view):
its iOS shell, bundle staging and `.ipa` inspection are what the panel shows, so
the plist comparison names its app. A project exposing the same three scripts
and an `ios/` folder gets the build, stage, `.ipa` and install buttons; the
verify button is the one piece still written around that app's plist, and says
so when it is handed another.

## What it needs

A checkout of that project with its `node_modules` installed, and `npm` on
`PATH`.

For signing and installing, the machine also needs what
[God's Eye View's iOS notes](https://github.com/Neo690/gods-eye-view/blob/main/ios/README.md)
describe: WSL with the Swift toolchain, `xtool` and the Darwin SDK, an Apple ID
session (`xtool auth login`) and an iPhone visible to WSL through `usbipd-win`.

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
