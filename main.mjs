// Standalone Windows window for the iOS studio panel.
//
// The panel is a copy of the one God's Eye View serves from `scripts/` (the
// same file `npm run ios:studio` starts there), kept in `server/` beside this
// shell and started here as a child of this binary through
// `ELECTRON_RUN_AS_NODE`. An installed copy therefore needs no Node
// installation, and the page in the window is the page a checkout's own panel
// serves.
//
// The window is the app; the checkout is the project. Its buttons run
// `npm run ...` and `xtool` somewhere on disk, so this app remembers where: on
// first run the folder it was built from (`project-root.json`, written by
// build-installer.mjs), then whichever folder the user picks in
// File ▸ Open project folder…

import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'server')
  : path.join(HERE, 'server');
const SERVER = path.join(SERVER_DIR, 'ios-studio.mjs');
const ICON = path.join(HERE, 'assets', 'icon.png');
const CONFIG = path.join(app.getPath('userData'), 'studio.json');
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'main.log');

const FIRST_PORT = 47830;
const PORT_SPAN = 30;
const READY_TIMEOUT_MS = 30_000;

// `--verify` is what a built installer is smoke-tested with: start the panel,
// ask it one question, exit without opening a window.
const VERIFY = process.argv.includes('--verify');

let projectRoot = '';
let serverChild = null;
let serverPort = 0;
let mainWindow = null;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // A read-only profile must not stop the panel from opening.
  }
}

/** The value of `--flag=value` or `--flag value`, empty when absent. */
function flagValue(flag) {
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  const next = process.argv[index + 1];
  return index >= 0 && next && !next.startsWith('-') ? next : '';
}

/** Whether a folder is a checkout this panel can drive. */
function isProject(directory) {
  return (
    Boolean(directory) &&
    existsSync(path.join(directory, 'package.json')) &&
    existsSync(path.join(directory, 'scripts', 'ios-studio.mjs'))
  );
}

function savedRoot() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG, 'utf8'));
    return typeof parsed.root === 'string' ? parsed.root : '';
  } catch {
    return '';
  }
}

function saveRoot(root) {
  try {
    mkdirSync(path.dirname(CONFIG), { recursive: true });
    writeFileSync(
      CONFIG,
      `${JSON.stringify({ root, savedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch (error) {
    log(`could not remember the project folder: ${error.message}`);
  }
}

/** The checkout this app was packaged from, when there was one. */
function bakedRoot() {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(app.getAppPath(), 'project-root.json'), 'utf8'),
    );
    return typeof parsed.root === 'string' ? parsed.root : '';
  } catch {
    return '';
  }
}

/**
 * Where the buttons build.
 *
 * An explicit `--root` beats the environment, which beats what the user picked
 * last time, which beats the folder the app was built from. When none of those
 * is a checkout the user is asked once, because guessing a folder would mean
 * running builds somewhere nobody named.
 */
async function resolveProjectRoot() {
  const candidates = [
    flagValue('--root'),
    process.env.GEV_PROJECT_ROOT ?? '',
    savedRoot(),
    bakedRoot(),
  ];
  for (const candidate of candidates) {
    if (isProject(candidate)) return path.resolve(candidate);
  }
  if (VERIFY) return '';

  const answer = await dialog.showOpenDialog({
    title: 'Choose the God’s Eye View folder',
    message:
      'The panel builds, signs and installs the iOS shell from a checkout.',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory'],
  });
  const picked = answer.filePaths?.[0] ?? '';
  if (answer.canceled || !isProject(picked)) return '';
  return path.resolve(picked);
}

const canListen = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });

/** The first free port in the panel's range, or 0 when the range is taken. */
async function freePort() {
  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_SPAN; port += 1) {
    if (await canListen(port)) return port;
  }
  return 0;
}

/** Start the panel server inside this binary's own Node, pointed at `root`. */
function startServer(root, port) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: root,
    env: {
      ...process.env,
      // No Node on the machine is assumed: this executable is the runtime.
      ELECTRON_RUN_AS_NODE: '1',
      GEV_PROJECT_ROOT: root,
      IOS_STUDIO_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const forward = (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) log(`[studio] ${line.trim()}`);
    }
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
  child.on('exit', (code) => log(`[studio] server exited (${code})`));
  return child;
}

/** Wait until the panel answers; a probe of the page is cheaper than /api/status. */
async function waitForServer(port, timeout = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) return true;
    } catch {
      // Not up yet: the server does several toolchain probes before it listens.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Stop the panel and everything it started.
 *
 * The tree matters: the panel spawns `npm`, which spawns `vite` or `xtool`, and
 * a build left running after the window closes would keep writing into the
 * checkout. `taskkill /T` targets this pid's children only, never a name.
 */
function stopServer() {
  const child = serverChild;
  serverChild = null;
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#1e1e1e',
    title: 'iOS studio',
    icon: ICON,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // The panel's own links (if any) belong in the browser, not in a window that
  // has no address bar to come back from.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'Open project folder…', click: () => void switchProject() },
          {
            label: 'Show project folder',
            click: () => void shell.openPath(projectRoot),
          },
          {
            label: 'Reveal build output',
            click: () =>
              void shell.openPath(path.join(projectRoot, 'ios', 'xtool')),
          },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
    ]),
  );
}

/** Point the running window at another checkout, without a restart. */
async function switchProject() {
  const answer = await dialog.showOpenDialog({
    title: 'Choose the God’s Eye View folder',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory'],
  });
  const picked = answer.filePaths?.[0] ?? '';
  if (answer.canceled || !isProject(picked)) {
    if (!answer.canceled) {
      dialog.showErrorBox(
        'Not a God’s Eye View folder',
        `${picked}\n\nThat folder has no package.json and scripts/ios-studio.mjs.`,
      );
    }
    return;
  }

  stopServer();
  projectRoot = path.resolve(picked);
  saveRoot(projectRoot);
  log(`project: ${projectRoot}`);
  serverPort = await freePort();
  serverChild = startServer(projectRoot, serverPort);
  if (!(await waitForServer(serverPort))) {
    dialog.showErrorBox(
      'iOS studio did not start',
      `The panel server did not answer on port ${serverPort}.\n\nSee ${LOG_FILE}.`,
    );
    return;
  }
  mainWindow?.loadURL(`http://127.0.0.1:${serverPort}/`);
  buildMenu();
}

async function boot() {
  projectRoot = await resolveProjectRoot();
  if (!projectRoot) {
    dialog.showErrorBox(
      'No project folder',
      'iOS studio builds the iOS shell from a checkout. Open one with\nFile ▸ Open project folder…, or start the app with --root=<path>.',
    );
    app.quit();
    return;
  }
  saveRoot(projectRoot);
  log(`project: ${projectRoot}`);

  serverPort = await freePort();
  if (!serverPort) {
    dialog.showErrorBox(
      'No free port',
      `Ports ${FIRST_PORT}–${FIRST_PORT + PORT_SPAN - 1} are all taken; close the other copy first.`,
    );
    app.quit();
    return;
  }
  serverChild = startServer(projectRoot, serverPort);
  if (!(await waitForServer(serverPort))) {
    dialog.showErrorBox(
      'iOS studio did not start',
      `The panel server did not answer on port ${serverPort}.\n\nSee ${LOG_FILE}.`,
    );
    stopServer();
    app.quit();
    return;
  }
  log(`window: http://127.0.0.1:${serverPort}/`);
  buildMenu();
  createWindow(serverPort);
}

/** Start the panel, ask it what it sees, print that, exit. */
async function verify() {
  projectRoot = await resolveProjectRoot();
  if (!projectRoot) {
    console.error('verify: no project folder (pass --root=<path>)');
    app.exit(1);
    return;
  }

  serverPort = await freePort();
  serverChild = startServer(projectRoot, serverPort);
  if (!(await waitForServer(serverPort))) {
    console.error(`verify: the panel did not answer on port ${serverPort}`);
    console.error(`verify: see ${LOG_FILE}`);
    stopServer();
    app.exit(1);
    return;
  }

  try {
    const page = await fetch(`http://127.0.0.1:${serverPort}/`);
    const html = await page.text();
    const status = await (
      await fetch(`http://127.0.0.1:${serverPort}/api/status`, {
        signal: AbortSignal.timeout(60_000),
      })
    ).json();
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
    console.log(
      JSON.stringify(
        {
          project: projectRoot,
          port: serverPort,
          page: { ok: page.ok, bytes: html.length, title },
          status: {
            platform: status.platform,
            host: status.host,
            outputDir: status.outputDir,
            checks: (status.checks ?? []).map(
              (check) => `${check.name}: ${check.ok ? 'ok' : 'missing'}`,
            ),
          },
        },
        null,
        2,
      ),
    );
    const ok =
      page.ok &&
      html.includes('iOS studio') &&
      Array.isArray(status.checks) &&
      status.checks.length > 0;
    stopServer();
    app.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(`verify: ${error.message}`);
    stopServer();
    app.exit(1);
  }
}

// One panel at a time: a second launch focuses the window already open instead
// of starting a second server on the next port.
if (!app.requestSingleInstanceLock() && !VERIFY) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('before-quit', stopServer);
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(() => (VERIFY ? verify() : boot()));
}
