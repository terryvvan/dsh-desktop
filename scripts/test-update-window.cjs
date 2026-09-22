'use strict';

/**
 * Exercises the update progress window (`electron/update-window.js`) for real.
 *
 * The window is the only feedback the user gets while an update installs, and it
 * is the one piece that cannot be checked without Electron: the state arrives
 * through `ipcMain.handle` + `dshup:state` pushes, and the buttons only work if a
 * click in the renderer survives the preload bridge back into a main-process
 * handler. A mistake there is invisible — the window simply sits there — which is
 * exactly the failure mode this test exists to catch.
 *
 * Usage:
 *   node_modules/electron/dist/electron.exe scripts/test-update-window.cjs
 */

const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// Destroying the window must not end the test: Electron quits on
// window-all-closed by default.
app.on('window-all-closed', () => {});

let checks = 0;
const failures = [];
const say = (line) => process.stdout.write(`${line}\n`);

function check(label, ok, detail = '') {
  checks += 1;
  if (ok !== true) failures.push(label);
  say(`  ${ok === true ? '✔' : '✘'} ${label}${detail === '' ? '' : `  ${detail}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MIRRORS = [
  { id: 'auto', label: '自动（跟随 ~/.npmrc）', hint: '用系统 npm 配置' },
  { id: 'npmmirror', label: '淘宝 npmmirror', url: 'https://registry.npmmirror.com/', hint: '国内最快' },
];

async function main() {
  await app.whenReady();

  const { createUpdateWindow } = require(path.join(__dirname, '..', 'electron', 'update-window.js'));
  const calls = [];
  const handlers = {};
  for (const name of ['pause', 'resume', 'cancel', 'retry', 'restart', 'mirror', 'speedtest', 'open-log', 'close', 'closed']) {
    handlers[name] = (payload) => {
      calls.push({ name, payload });
    };
  }

  const window = createUpdateWindow({ getMainWindow: () => null, log: () => {}, handlers });
  window.open({
    version: '9.9.9-probe',
    channel: 'alpha',
    registryId: 'npmmirror',
    registry: 'https://registry.npmmirror.com/',
    mirrors: MIRRORS,
  });

  let bw = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'DSH 更新');
  if (bw === undefined) {
    check('window created', false, 'no BrowserWindow titled DSH 更新');
    return;
  }
  check('window created', true, 'title=DSH 更新');
  await new Promise((resolve) => {
    if (!bw.webContents.isLoading()) resolve();
    else bw.webContents.once('did-finish-load', resolve);
  });
  bw.hide(); // a test must not steal the desktop
  await sleep(200);

  const readDom = () =>
    bw.webContents.executeJavaScript(`(() => {
      const text = (id) => { const el = document.getElementById(id); return el === null ? null : el.textContent.replace(/\\s+/g, ' ').trim(); };
      const shown = (el) => el !== null && el !== undefined && el.hidden !== true && getComputedStyle(el).display !== 'none';
      const buttons = [...document.querySelectorAll('button')].map((b) => ({ id: b.id, text: b.textContent.trim(), shown: shown(b) }));
      const bar = document.getElementById('barFill');
      return {
        text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 1600),
        buttons,
        barWidth: bar === null ? null : bar.style.width,
        selects: [...document.querySelectorAll('select')].map((s) => ({ id: s.id, options: [...s.options].map((o) => o.value) })),
        steps: [...document.querySelectorAll('#steps > *')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim()),
        logText: text('log'),
      };
    })()`);

  const idle = await readDom();
  check(
    'the snapshot from the main process renders',
    typeof idle.text === 'string' &&
      idle.text.includes('9.9.9-probe') &&
      idle.selects.some((select) => select.options.includes('npmmirror')),
    `selects=${JSON.stringify(idle.selects)} visible=${idle.buttons.filter((b) => b.shown).map((b) => b.id).join(',')}`,
  );

  window.begin({ version: '9.9.9-probe', channel: 'alpha', registryId: 'npmmirror', registry: 'https://registry.npmmirror.com/', mirrors: MIRRORS });
  window.progress({
    phase: 'download',
    version: '9.9.9-probe',
    files: 1,
    totalFiles: 3,
    bytes: 1048576,
    totalBytes: 4194304,
    partial: false,
    percent: 25,
    speed: 524288,
    etaSeconds: 6,
    elapsedSeconds: 2,
    current: 'dsh-web-frontend@9.9.9',
    failed: 0,
    paused: false,
  });
  window.appendLog('update: 解析 @deepseek-ai/dsh@9.9.9 的依赖树');
  await sleep(400);

  const running = await readDom();
  check(
    'a download snapshot renders a bar, bytes and the step list',
    typeof running.text === 'string' &&
      running.text.includes('25') &&
      /MB|KB/.test(running.text) &&
      running.barWidth !== null &&
      running.barWidth !== '' &&
      running.steps.some((entry) => /下载/.test(entry)),
    `bar=${running.barWidth} steps=${JSON.stringify(running.steps.slice(0, 4))}`,
  );
  check(
    'npm output is streamed into the log pane',
    typeof running.logText === 'string' && running.logText.includes('依赖树'),
    `log=${String(running.logText).slice(0, 60)}`,
  );

  await bw.webContents.executeJavaScript(
    `(() => { const b = [...document.querySelectorAll('button')].find((el) => /暂停|继续/.test(el.textContent)); if (b !== undefined) b.click(); return b === undefined ? 'no-button' : b.id; })()`,
  );
  await sleep(300);
  check(
    'a button click crosses the preload bridge',
    calls.some((call) => call.name === 'pause' || call.name === 'resume'),
    `calls=${JSON.stringify(calls)}`,
  );

  // Closing the window while the install runs must not cancel it: the user can
  // dismiss the progress view and carry on working.
  window.close();
  await sleep(400);
  check(
    'closing the window leaves the install running',
    window.isOpen() === false && window.isBusy() === true && calls.some((call) => call.name === 'closed'),
    `isOpen=${window.isOpen()} isBusy=${window.isBusy()}`,
  );
  window.open({
    version: '9.9.9-probe',
    channel: 'alpha',
    registryId: 'npmmirror',
    registry: 'https://registry.npmmirror.com/',
    mirrors: MIRRORS,
  });
  bw = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'DSH 更新');
  await new Promise((resolve) => {
    if (!bw.webContents.isLoading()) resolve();
    else bw.webContents.once('did-finish-load', resolve);
  });
  bw.hide();
  await sleep(300);

  window.fail('下载内容与 registry 公布的校验值不一致');
  await sleep(300);
  const failedDom = await readDom();
  check(
    'a failure is shown with a retry offer',
    typeof failedDom.text === 'string' && failedDom.text.includes('更新失败') && failedDom.text.includes('校验值'),
    `visible=${failedDom.buttons.filter((b) => b.shown).map((b) => b.id).join(',')}`,
  );

  window.finish();
  await sleep(300);
  const readyDom = await readDom();
  check(
    'a finished install offers to restart the runtime',
    typeof readyDom.text === 'string' && /已就绪|重启/.test(readyDom.text),
    `visible=${readyDom.buttons.filter((b) => b.shown).map((b) => b.id).join(',')}`,
  );

  // Closing the window while the install runs must not cancel it: the user can
  // dismiss the progress view and keep working.
  window.destroy();
  check('window destroyed', window.isOpen() === false, `isBusy=${window.isBusy()}`);
}

main()
  .then(() => {
    const passed = checks - failures.length;
    say(`\n${passed}/${checks} checks passed`);
    if (failures.length > 0) say(`failed: ${failures.join('; ')}`);
    app.exit(failures.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    say(`FAILED: ${error.stack ?? error.message}`);
    app.exit(1);
  });
