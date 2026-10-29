#!/usr/bin/env node

// A local control panel for the iOS shell, for people on Windows who have no
// terminal open and no Mac.
//
// It is a small HTTP server on 127.0.0.1 that serves one page and runs the same
// commands the scripts run, so nothing here is a second implementation: the
// buttons call `npm run build`, `npm run ios:payload`, `npm run ios:ipa` and the
// plist comparison, and stream their output back over server-sent events.
//
// Why a page instead of a native window: the machine that drives xtool may be
// Windows, Linux or macOS, and a browser is the one control surface all three
// have. It also keeps the dependency count at zero — no Electron, no GUI
// toolkit, just `node:http`.
//
// Bound to loopback only: this starts builds on your machine and must never be
// reachable from the network.
//
// Usage:  npm run ios:studio
//         IOS_STUDIO_PORT=47830 IOS_STUDIO_WSL_DISTRO=Ubuntu npm run ios:studio

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectIpaSignature,
  readZipEntries,
  readZipEntry,
  toWslPath,
  verifyIpa,
  xtoolCommand,
} from './build-ios-ipa.mjs';
import { compareIosPlists } from './compare-ios-plists.mjs';
import { readProjectConfig } from './project.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
// The project this panel builds. From the repository it is the checkout the
// script lives in; the packaged Windows app ships this file inside its own
// resources and names the checkout with IOS_STUDIO_PROJECT, so the buttons still
// run `npm run ...` where the project actually is.
const ROOT = path.resolve(
  process.env.IOS_STUDIO_PROJECT?.trim() || path.join(SCRIPTS_DIR, '..'),
);
const PAGE = path.join(SCRIPTS_DIR, 'ios-studio.html');
const IOS_DIR = path.join(ROOT, 'ios');
const OUTPUT_DIR = path.join(IOS_DIR, 'xtool');
// Which app this checkout builds comes from the checkout, never from here: a
// broken `ios/studio.json` must not stop the panel from opening, because the
// page is where the problem gets reported.
const PROJECT = (() => {
  try {
    return readProjectConfig(ROOT);
  } catch (error) {
    return {
      root: ROOT,
      source: '',
      appName: '',
      displayName: '',
      bundleId: '',
      version: '',
      minimumOs: '',
      sceneDelegate: '',
      appDir: '',
      wwwDir: '',
      ipaPath: '',
      appPrefix: '',
      problem: error.message,
    };
  }
})();
const IPA_PATH = PROJECT.ipaPath;
const DISTRO = process.env.IOS_STUDIO_WSL_DISTRO ?? 'Ubuntu';
const PORT = Number(process.env.IOS_STUDIO_PORT ?? 47830);
const HOST = '127.0.0.1';

/** xtool and swift live in the user prefix; name them rather than trust PATH. */
const PATH_PREFIX =
  'export PATH="$HOME/.local/share/swiftly/bin:$HOME/.local/bin:$PATH"';

function shell(command, { timeout = 20_000 } = {}) {
  const script = `${PATH_PREFIX} && ${command}`;
  const result =
    process.platform === 'win32'
      ? spawnSync('wsl.exe', ['-d', DISTRO, '--', 'bash', '-c', script], {
          encoding: 'utf8',
          timeout,
        })
      : spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, status: result.status, output };
}

/** The command that runs an npm script, without a Windows `.cmd` shim. */
function npmCommand(script) {
  const cli = process.env.npm_execpath;
  if (cli && cli.endsWith('.js')) {
    return {
      command: process.execPath,
      args: [cli, 'run', script],
      shell: false,
    };
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return {
    command: npm,
    args: ['run', script],
    shell: process.platform === 'win32',
  };
}

const TASKS = {
  build: () => ({ label: 'Web build', ...npmCommand('build') }),
  payload: () => ({ label: 'Stage payload', ...npmCommand('ios:payload') }),
  ipa: () => ({ label: 'Build .ipa', ...npmCommand('ios:ipa') }),
  // Signs with the Apple ID session and installs over USB; xtool also launches it.
  install: () => ({
    label: 'Install on device',
    ...xtoolCommand(['dev', 'run', '--usb']),
  }),
};

/**
 * The phone WSL can see, by name, so the panel says what it would install onto.
 *
 * `idevice_id -l` answers `ERROR: …` when nothing is attached, and that line
 * looks just like an identifier to a naive reader — it is not. Only a hex id is
 * taken as a UDID, and an `ERROR:` answer from `ideviceinfo` counts as none.
 */
function device() {
  const UDID = /^[0-9a-f]{8,}$/i;
  const listed = shell('idevice_id -l', { timeout: 8_000 });
  const udid = listed.output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => UDID.test(line));
  if (!udid)
    return {
      ok: false,
      udid: '',
      name: '',
      detail: 'no device visible to WSL',
    };

  const read = (key) => {
    const answer = shell(`ideviceinfo -u ${udid} -k ${key}`, {
      timeout: 8_000,
    }).output.trim();
    return answer && !/^ERROR/i.test(answer) ? answer : '';
  };
  const name = read('DeviceName');
  const model = read('ProductType');
  const version = read('ProductVersion');
  if (!name && !model && !version) {
    return {
      ok: false,
      udid,
      name: '',
      detail: 'device listed but not answering ideviceinfo',
    };
  }
  const detail = [name || 'unnamed device', model, version && `iOS ${version}`]
    .filter(Boolean)
    .join(' · ');
  return { ok: true, udid, name, detail };
}

/** What the panel shows on load: which tool is missing, and what exists. */
function status() {
  const swift = shell('swift --version');
  const xtool = shell('xtool --version');
  const sdk = shell('xtool sdk status');
  const phone = device();
  const auth = shell('xtool auth status');
  const signedIn =
    /logged in/i.test(auth.output) && !/logged out/i.test(auth.output);

  const ipa = existsSync(IPA_PATH)
    ? {
        exists: true,
        bytes: statSync(IPA_PATH).size,
        modified: statSync(IPA_PATH).mtime.toISOString(),
      }
    : { exists: false };

  // Separate from `ipa` because it answers a different question: not what was
  // written, but whether an iPhone would run it, and for how many days.
  const signature = inspectIpaSignature(IPA_PATH, {
    appName: PROJECT.appName,
  });

  return {
    platform: process.platform,
    host: process.platform === 'win32' ? `WSL ${DISTRO}` : 'native',
    checks: [
      {
        name: 'Swift toolchain',
        ok: swift.ok,
        detail:
          /Swift version [\d.]+/.exec(swift.output)?.[0] ??
          swift.output.split('\n')[0],
      },
      { name: 'xtool', ok: xtool.ok, detail: xtool.output.split('\n')[0] },
      {
        name: 'Darwin SDK',
        ok: /installed/i.test(sdk.output) && !/not installed/i.test(sdk.output),
        detail: sdk.output.split('\n')[0],
      },
      {
        name: 'Apple ID session',
        ok: signedIn,
        detail: auth.output.split('\n')[0],
      },
      { name: 'iOS device', ok: phone.ok, detail: phone.detail },
      {
        name: 'Code signature',
        ok: signature.installableAsIs,
        detail: signature.detail,
      },
    ],
    // The install button is only meaningful with both halves present, so the
    // page can say why it is disabled instead of failing after a click.
    installable: signedIn && phone.ok,
    installBlockedBy: !signedIn
      ? 'xtool auth login has not been run'
      : !phone.ok
        ? 'no iPhone is visible to WSL (usbipd attach)'
        : '',
    device: phone.name,
    // What the panel would build, so a page can name the app instead of
    // assuming which one this checkout is.
    app: PROJECT.appName,
    configSource: PROJECT.source,
    configProblem: PROJECT.problem ?? '',
    ipa,
    signature,
    outputDir: OUTPUT_DIR,
    login: login
      ? { running: true, awaitingCode: login.awaitingCode }
      : { running: false, awaitingCode: false },
  };
}

const clients = new Set();
/**
 * Send one message to every open page.
 *
 * Server-sent events carry a single value per `data:` field, so text with
 * interior newlines — a task's chunk of output, or the `\n▶ …` job header —
 * must become one frame per line. Written as-is, the browser's parser keeps
 * only the first line and silently drops the rest.
 */
const broadcast = (line) => {
  for (const part of String(line).replace(/\r/g, '').split('\n')) {
    for (const client of clients) client.write(`data: ${part}\n\n`);
  }
};

let job = null;

/**
 * The plist to compare against `project.yml`: the built `.app` carries one, but
 * `xtool dev build --ipa` leaves only the archive, so read it back out of there.
 * Returns the path and a cleanup, or null when nothing has been built.
 */
function plistUnderCheck() {
  const built = PROJECT.appName
    ? path.join(OUTPUT_DIR, `${PROJECT.appName}.app`, 'Info.plist')
    : '';
  if (built && existsSync(built))
    return { plistPath: built, cleanup: () => {} };
  if (!existsSync(IPA_PATH)) return null;

  const buffer = readFileSync(IPA_PATH);
  const entry = readZipEntries(buffer).find(
    (candidate) => candidate.name === `${PROJECT.appPrefix}Info.plist`,
  );
  if (!entry) return null;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ios-studio-ipa-'));
  const plistPath = path.join(dir, 'Info.plist');
  writeFileSync(plistPath, readZipEntry(buffer, entry));
  return {
    plistPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Compare the plist and re-check the archive, in-process (no child to wait on). */
function runVerify() {
  const found = plistUnderCheck();
  if (!found) {
    broadcast('  nothing built yet: run Build .ipa first');
    broadcast('■ Verify failed (exit 1)');
    job = null;
    return;
  }
  const fromIpa = found.plistPath.includes(os.tmpdir());
  broadcast(
    `  plist: ${fromIpa ? 'inside the .ipa' : `ios/xtool/${PROJECT.appName}.app`}`,
  );
  try {
    const result = compareIosPlists(found.plistPath, PROJECT);
    for (const line of result.lines) broadcast(`  ${line}`);
    if (existsSync(IPA_PATH)) {
      const archive = verifyIpa(IPA_PATH, {
        appName: PROJECT.appName,
        bundleId: PROJECT.bundleId,
        expectVersion: PROJECT.version,
      });
      broadcast(
        `  archive: ${(archive.bytes / 1024 / 1024).toFixed(1)} MiB, ${archive.wwwFiles} files under www/, ${archive.signed} signature entries`,
      );
      for (const problem of archive.problems)
        broadcast(`  archive problem: ${problem}`);
      if (archive.problems.length > 0) result.ok = false;
    }
    broadcast(result.ok ? '■ Verify succeeded' : '■ Verify failed (exit 1)');
  } catch (error) {
    broadcast(`  ${error.message}`);
    broadcast('■ Verify failed (exit 1)');
  } finally {
    found.cleanup();
    job = null;
  }
}

/** Run one task, streaming its output to every open page. */
function startTask(name, res) {
  if (job) {
    res.writeHead(409, { 'Content-Type': 'text/plain' });
    res.end(`${job} is already running`);
    return;
  }
  if (name === 'verify') {
    job = 'Verify';
    broadcast('\n▶ Verify');
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ started: name }));
    setImmediate(runVerify);
    return;
  }

  const task = TASKS[name]?.();
  if (!task) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('unknown task');
    return;
  }

  job = task.label;
  broadcast(`\n▶ ${task.label}`);
  const child = spawn(task.command, task.args, {
    cwd: ROOT,
    env: process.env,
    shell: task.shell,
  });
  child.stdout.on('data', (chunk) => broadcast(chunk.toString().trimEnd()));
  child.stderr.on('data', (chunk) => broadcast(chunk.toString().trimEnd()));
  child.on('close', (code) => {
    broadcast(
      `■ ${task.label} ${code === 0 ? 'succeeded' : `failed (exit ${code})`}`,
    );
    if (name === 'ipa' && code === 0) {
      try {
        const report = verifyIpa(IPA_PATH, {
          appName: PROJECT.appName,
          bundleId: PROJECT.bundleId,
          expectVersion: PROJECT.version,
        });
        broadcast(
          `  archive: ${(report.bytes / 1024 / 1024).toFixed(1)} MiB, ${report.wwwFiles} files under www/, ${report.signed} signature entries`,
        );
      } catch (error) {
        broadcast(`  archive check failed: ${error.message}`);
      }
    }
    job = null;
  });
  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ started: name }));
}

/** Single-quote a value for a POSIX shell, so a password cannot inject. */
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * A login is interactive even when the credentials are supplied: Apple may ask
 * for a two-factor code and xtool reads it from the terminal. So the child is
 * kept alive with its stdin open so the page can answer, rather than the form
 * pretending a password alone is enough.
 */
let login = null;

/** The JSON body of a request, bounded so a stray client cannot exhaust memory. */
function readJson(req, limit = 4_096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('expected a JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Run `xtool auth login` with the credentials from the form.
 *
 * `script` gives xtool the pseudo-terminal it insists on: without one it dies
 * in SwiftNIO (`epoll_ctl: Operation not permitted`) before it can even prompt.
 * Every value is single-quoted on the way in, and the password is masked out of
 * the stream, so it reaches neither the log nor the page.
 */
function startLogin({ username, password }, res) {
  if (login) {
    res.writeHead(409, { 'Content-Type': 'text/plain' });
    res.end('a login is already running');
    return;
  }
  if (!username || !password) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('an Apple ID and a password are required');
    return;
  }

  const inner = [
    'xtool auth login --mode password',
    `--username ${shellQuote(username)}`,
    `--password ${shellQuote(password)}`,
  ].join(' ');
  const script = [
    PATH_PREFIX,
    `cd ${shellQuote(toWslPath(IOS_DIR))}`,
    `script -qec ${shellQuote(inner)} /dev/null`,
  ].join(' && ');

  const child =
    process.platform === 'win32'
      ? spawn('wsl.exe', ['-d', DISTRO, '--', 'bash', '-c', script], {
          env: process.env,
        })
      : spawn('bash', ['-c', script], { env: process.env });

  login = { child, awaitingCode: false };
  broadcast('\n▶ Log in');

  // The pty hands out arbitrary chunks, so lines are reassembled here: an error
  // number split across two chunks would otherwise reach the page cut in half.
  let pending = '';
  const watch = (chunk) => {
    const text = password
      ? chunk.toString().split(password).join('***')
      : chunk.toString();
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const clean = line.replace(/\r$/, '');
      if (clean.trim()) broadcast(clean);
    }
    if (
      /two-factor|verification code|code you received|enter the code/i.test(
        text,
      ) &&
      !login?.awaitingCode
    ) {
      login.awaitingCode = true;
      broadcast('state: awaiting-code');
    }
  };
  child.stdout.on('data', watch);
  child.stderr.on('data', watch);

  // A login that never completes must not hold the panel for ever.
  const timer = setTimeout(() => {
    if (login?.child === child) child.kill();
  }, 180_000);
  timer.unref?.();

  child.on('close', (code) => {
    clearTimeout(timer);
    if (pending.trim()) broadcast(pending.replace(/\r$/, ''));
    login = null;
    broadcast(`■ Log in ${code === 0 ? 'succeeded' : `failed (exit ${code})`}`);
    broadcast('state: idle');
  });

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ started: 'login' }));
}

/** Answer the two-factor prompt that xtool is waiting on. */
function sendLoginCode(code, res) {
  if (!login) {
    res.writeHead(409, { 'Content-Type': 'text/plain' });
    res.end('no login is waiting for a code');
    return;
  }
  login.awaitingCode = false;
  login.child.stdin.write(`${code}\n`);
  broadcast('  two-factor code sent');
  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ sent: true }));
}

/** Open the folder the build writes into, in the desktop's file manager. */
function revealOutput() {
  if (!existsSync(OUTPUT_DIR)) {
    return { ok: false, dir: OUTPUT_DIR, reason: 'no build output yet' };
  }
  const [command, args] =
    process.platform === 'win32'
      ? ['explorer.exe', [OUTPUT_DIR]]
      : process.platform === 'darwin'
        ? ['open', [OUTPUT_DIR]]
        : ['xdg-open', [OUTPUT_DIR]];
  const opener = spawn(command, args, { detached: true, stdio: 'ignore' });
  opener.unref();
  return { ok: true, dir: OUTPUT_DIR };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (
    req.method === 'GET' &&
    (url.pathname === '/' || url.pathname === '/index.html')
  ) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(PAGE));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(status()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`data: ${job ? `running: ${job}` : 'idle'}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Credentials and the file manager both change local state, so they get the
  // same cross-origin refusal as the build buttons.
  if (req.method === 'POST' && url.pathname.startsWith('/api/auth/')) {
    if (req.headers.origin && req.headers.origin !== `http://${HOST}:${PORT}`) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('cross-origin request refused');
      return;
    }
    readJson(req)
      .then((body) => {
        if (url.pathname === '/api/auth/login') startLogin(body, res);
        else {
          const code = String(body.code ?? '').trim();
          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('a two-factor code is required');
            return;
          }
          sendLoginCode(code, res);
        }
      })
      .catch((error) => {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(error.message);
      });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/reveal') {
    if (req.headers.origin && req.headers.origin !== `http://${HOST}:${PORT}`) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('cross-origin request refused');
      return;
    }
    const result = revealOutput();
    res.writeHead(result.ok ? 200 : 404, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/run/')) {
    // Loopback only, but a page on another origin must not be able to POST here.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${HOST}:${PORT}`) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('cross-origin request refused');
      return;
    }
    startTask(url.pathname.slice('/api/run/'.length), res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`iOS studio: http://${HOST}:${PORT}/`);
  console.log(
    `host: ${process.platform === 'win32' ? `WSL ${DISTRO}` : 'native'}`,
  );
  console.log(
    'the page drives npm run build / ios:payload / ios:ipa and the plist check',
  );
});
