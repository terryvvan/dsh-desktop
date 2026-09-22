'use strict';

/**
 * Regression test for the page menu bar's submenus.
 *
 * The bar is injected as a script string, so its submenu behaviour is invisible to
 * both `check-menu.cjs` (which only inspects the definition) and the native menu.
 * Three bugs are guarded against here, all of them reported from the running app:
 *
 *   1. Every hover of a submenu row appended one more floating panel, so sweeping
 *      the mouse in and out of 「更新通道」 or 「更新镜像源」 piled them up. The cause
 *      was a removal query that looked for the submenu as a direct child of the
 *      panel while it is actually appended to its own row.
 *   2. The submenu was positioned against the panel rather than against its own
 *      row, so it opened at the top of the panel — nowhere near the row that was
 *      hovered — and crossed the bar's bottom line on the way there.
 *   3. Because of 2 the submenu could only be reached by travelling up through the
 *      rows above it, so it had to survive a plain row being hovered. Now that it
 *      hangs off its own row the pointer goes sideways into it, and the rule is the
 *      plain one: the hovered row shows its submenu, a row without one shows none.
 *
 *   node_modules/electron/dist/electron.exe scripts/test-page-menu.cjs
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();
// The bar itself is one window; without this the run would exit at the first
// moment no window is open and truncate the remaining steps.
app.on('window-all-closed', () => {});

const failures = [];
let checks = 0;
/** Records the channel/mirror commands the injected submenu actually dispatches. */
const commandCalls = [];

function check(label, ok, detail = '') {
  checks += 1;
  if (ok !== true) failures.push(label);
  console.log(`  ${ok === true ? '✔' : '✘'} ${label}${detail === '' ? '' : `  ${detail}`}`);
}

/** The shape `main.js` passes in, with the live parts stubbed. */
function context(pageMenuBar) {
  return {
    runtimeManager: {
      CHANNELS: ['latest', 'next', 'alpha'],
      MIRRORS: [
        { id: 'auto', label: '自动（跟随 ~/.npmrc）', url: null, hint: '用系统 npm 配置里的 registry' },
        { id: 'npmmirror', label: '淘宝 npmmirror', url: 'https://registry.npmmirror.com/', hint: '国内最快，推荐' },
        { id: 'npmjs', label: 'npm 官方', url: 'https://registry.npmjs.org/', hint: '海外直连' },
      ],
      describe: () => ({
        active: '0.1.5-rc.2',
        bundled: '0.1.5-rc.2',
        source: 'bundled',
        channel: 'next',
        registryId: 'auto',
        previous: null,
        installed: [],
        lastCheck: null,
      }),
      mirrorFor: (id) => ({ id: id ?? 'auto', label: '自动（跟随 ~/.npmrc）', url: null, hint: '' }),
      setMirror: (id) => ({ id, label: id, url: null, hint: '' }),
      testMirrors: async () => [],
      writeState: () => {},
    },
    profileGuard: { hasSnapshot: () => false, describeSnapshot: () => '配置快照：无', backupRoot: () => 'x' },
    backgroundManager: { hasBackground: () => true, openSettings: () => {}, clearBackground: () => {} },
    appUrl: () => 'http://127.0.0.1:1234/?token=x',
    mainWindow: () => null,
    nativeMenuBar: () => !pageMenuBar,
    setNativeMenuBar: () => {},
    dshHome: () => 'C:\\Users\\x\\.dsh',
    logDir: 'C:\\logs',
    restartRuntime: () => {},
    setChannel: (name) => commandCalls.push(`setChannel:${name}`),
    manualProfileRollback: () => {},
    manualCheck: () => {},
    isCheckingUpdate: () => false,
    isUpdating: () => false,
    mirrors: () => [
      { id: 'auto', label: '自动（跟随 ~/.npmrc）', url: null, hint: '' },
      { id: 'npmmirror', label: '淘宝 npmmirror', url: 'https://registry.npmmirror.com/', hint: '' },
    ],
    registryId: () => 'auto',
    setMirror: () => {},
    testMirrors: () => {},
    showUpdateProgress: () => {},
    doRollback: () => {},
    showAbout: () => {},
    rebuildMenu: () => {},
  };
}

/**
 * Open a top-level menu and return how many panels exist. The label is matched by
 * prefix because the bar renders '文件(&F)' as '文件()' (the mnemonic is stripped
 * but its parentheses are not).
 */
const openMenu = (barId, label) => `(() => {
  const bar = document.getElementById(${JSON.stringify(barId)});
  const top = [...bar.querySelectorAll('.top')].find((el) => el.textContent.startsWith(${JSON.stringify(label)}));
  if (top === undefined) return { found: false, tops: [...bar.querySelectorAll('.top')].map((el) => el.textContent) };
  top.click();
  return { found: true, panels: bar.querySelectorAll(':scope > .panel').length };
})()`;

/**
 * Hover a row `times` times, moving the pointer out in between — the gesture that
 * used to leave a trail of floating panels — then report what is left.
 */
const sweepRow = (barId, label, times) => `(() => {
  const panel = document.querySelector('#' + ${JSON.stringify(barId)} + ' > .panel');
  if (panel === null) return { found: false };
  const row = [...panel.querySelectorAll(':scope > .item')].find((el) => {
    const text = el.querySelector('.label');
    return text !== null && text.textContent.startsWith(${JSON.stringify(label)});
  });
  if (row === undefined) return { found: false };
  for (let index = 0; index < ${times}; index += 1) {
    row.dispatchEvent(new MouseEvent('mouseenter'));
    row.dispatchEvent(new MouseEvent('mouseleave'));
  }
  return {
    found: true,
    own: row.querySelectorAll(':scope > .panel').length,
    total: panel.querySelectorAll('.panel').length,
    // A third level would mean the submenu built rows of its own accord.
    deeper: (row.querySelector(':scope > .panel')?.querySelectorAll('.panel').length) ?? -1,
  };
})()`;

/**
 * Hover a row that has no submenu of its own: whatever submenu was open must go
 * away, because the panel only ever shows the submenu of the row under the pointer.
 */
const hoverPlain = (barId, label) => `(() => {
  const panel = document.querySelector('#' + ${JSON.stringify(barId)} + ' > .panel');
  if (panel === null) return { found: false };
  const row = [...panel.querySelectorAll(':scope > .item')].find((el) => {
    const text = el.querySelector('.label');
    return text !== null && text.textContent.startsWith(${JSON.stringify(label)});
  });
  if (row === undefined) return { found: false };
  row.dispatchEvent(new MouseEvent('mouseenter'));
  return { found: true, total: panel.querySelectorAll('.panel').length };
})()`;

/** List the command ids the currently open submenu offers. */
const submenuCommands = (barId) => `(() => {
  const panel = document.querySelector('#' + ${JSON.stringify(barId)} + ' > .panel');
  if (panel === null) return { found: false };
  const sub = panel.querySelector(':scope > .item > .panel');
  if (sub === null) return { found: false };
  return { found: true, ids: [...sub.querySelectorAll(':scope > .item')].map((el) => el.dataset.cmd ?? null) };
})()`;

/**
 * Open the submenu of one row and measure it against the bar, the panel and the
 * row it belongs to. Everything is in viewport coordinates, which is what the user
 * sees: the bar is a fixed strip at the top, so its bottom edge is the line a
 * submenu must not cross.
 */
const submenuRect = (barId, label) => `(() => {
  const bar = document.getElementById(${JSON.stringify(barId)});
  const panel = bar === null ? null : bar.querySelector(':scope > .panel');
  if (panel === null) return { found: false, why: 'no panel' };
  const row = [...panel.querySelectorAll(':scope > .item')].find((el) => {
    const text = el.querySelector('.label');
    return text !== null && text.textContent.startsWith(${JSON.stringify(label)});
  });
  if (row === undefined) return { found: false, why: 'no row' };
  row.dispatchEvent(new MouseEvent('mouseenter'));
  const sub = row.querySelector(':scope > .panel');
  if (sub === null) return { found: false, why: 'no submenu' };
  const box = (el) => {
    const b = el.getBoundingClientRect();
    return { top: b.top, left: b.left, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
  };
  return {
    found: true,
    bar: box(bar), row: box(row), panel: box(panel), sub: box(sub),
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  };
})()`;

/** Hover another row that has a submenu, and report what is open afterwards. */
const switchSubmenu = (barId, label) => `(() => {
  const panel = document.querySelector('#' + ${JSON.stringify(barId)} + ' > .panel');
  if (panel === null) return { found: false };
  const row = [...panel.querySelectorAll(':scope > .item')].find((el) => {
    const text = el.querySelector('.label');
    return text !== null && text.textContent.startsWith(${JSON.stringify(label)});
  });
  if (row === undefined) return { found: false };
  row.dispatchEvent(new MouseEvent('mouseenter'));
  const sub = row.querySelector(':scope > .panel');
  return {
    found: true,
    total: panel.querySelectorAll('.panel').length,
    ids: sub === null ? [] : [...sub.querySelectorAll(':scope > .item')].map((el) => el.dataset.cmd ?? null),
  };
})()`;

/**
 * Hover a row *inside* the open submenu. That row belongs to the submenu, not to
 * the panel, so the submenu must stay open — and nothing deeper may appear.
 */
const hoverLeaf = (barId) => `(() => {
  const bar = document.getElementById(${JSON.stringify(barId)});
  const panel = bar === null ? null : bar.querySelector(':scope > .panel');
  if (panel === null) return { found: false };
  const sub = panel.querySelector(':scope > .item > .panel');
  if (sub === null) return { found: false };
  const leaf = sub.querySelector(':scope > .item');
  if (leaf === null) return { found: false };
  leaf.dispatchEvent(new MouseEvent('mouseenter'));
  return {
    found: true,
    total: document.querySelectorAll('#' + ${JSON.stringify(barId)} + ' .panel').length,
    deeper: sub.querySelectorAll('.panel').length,
  };
})()`;

/** Press the mouse on something behind the menu, the way a user dismisses it. */
const clickBlank = (barId) => `(() => {
  const blank = document.createElement('div');
  document.body.appendChild(blank);
  blank.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  const left = document.querySelectorAll('#' + ${JSON.stringify(barId)} + ' .panel').length;
  blank.remove();
  return { left };
})()`;

async function main() {
  await app.whenReady();
  const menu = require(path.join(__dirname, '..', 'electron', 'desktop-menu.js'));
  const built = menu.buildMenuData(context(true));
  const barId = menu.BAR_ID;
  const logs = [];
  /** Replaced by the last check, which needs a menu of its own. */
  let currentMenu = null;

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const desktop = menu.createDesktopMenu({
    contents: win.webContents,
    // `currentMenu` lets one check swap in a menu of its own (a submenu on the
    // panel's very first row) without touching the real definition.
    getMenu: () => ({ ...(currentMenu ?? built), pageMenu: true }),
    setChannel: (name) => logs.push(`setChannel:${name}`),
    log: (message) => logs.push(message),
  });

  await win.loadURL('about:blank');
  desktop.install();
  check('the bar is injected into the page', (await desktop.refresh()) === 'ok');

  const opened = await win.webContents.executeJavaScript(openMenu(barId, '文件'));
  check('「文件」opens exactly one panel', opened.found === true && opened.panels === 1, JSON.stringify(opened));

  for (const label of ['更新通道', '更新镜像源']) {
    const swept = await win.webContents.executeJavaScript(sweepRow(barId, label, 6));
    check(
      `hovering 「${label}」6 次只留一个二级浮窗`,
      swept.found === true && swept.own === 1 && swept.total === 1 && swept.deeper === 0,
      JSON.stringify(swept),
    );

    const commands = await win.webContents.executeJavaScript(submenuCommands(barId));
    check(
      `「${label}」的子项都带命令 id`,
      commands.found === true &&
        commands.ids.length > 0 &&
        commands.ids.every((id) => typeof id === 'string' && built.commands[id] !== undefined),
      JSON.stringify(commands.ids),
    );

    const plain = await win.webContents.executeJavaScript(hoverPlain(barId, '重新加载界面'));
    check(
      `移到普通行会收掉「${label}」的浮窗（谁被悬停就显示谁）`,
      plain.found === true && plain.total === 0,
      JSON.stringify(plain),
    );
  }

  // Geometry: the submenu has to sit beside the row that opened it. It used to be
  // positioned against the panel, so every submenu opened at the panel's top edge
  // and crossed the bar's bottom line on the way there.
  const geometry = await win.webContents.executeJavaScript(submenuRect(barId, '更新镜像源'));
  const geometryDetail = JSON.stringify(geometry);
  check(
    '二级菜单贴着自己那一行，而不是面板顶部',
    geometry.found === true &&
      geometry.sub.top - geometry.row.top >= -8 &&
      geometry.sub.top - geometry.row.top <= -4 &&
      geometry.sub.top - geometry.panel.top > 100,
    geometryDetail,
  );
  check(
    '二级菜单不越过菜单栏下边线',
    geometry.found === true && geometry.sub.top >= geometry.bar.bottom,
    geometryDetail,
  );
  check(
    '二级菜单挂在面板右侧、留在窗口内',
    geometry.found === true &&
      geometry.sub.left >= geometry.panel.right - 6 &&
      geometry.sub.right <= geometry.innerWidth + 1 &&
      geometry.sub.bottom <= geometry.innerHeight + 1,
    geometryDetail,
  );

  // Switching: only a row that has a submenu of its own replaces the open one.
  const swapped = await win.webContents.executeJavaScript(switchSubmenu(barId, '更新通道'));
  check(
    '移到另一个带二级菜单的行才切换过去（且只剩一个浮窗）',
    swapped.found === true && swapped.total === 1 && swapped.ids.includes('channel:alpha'),
    JSON.stringify(swapped),
  );

  // Rows inside the submenu belong to the submenu: hovering one must not clear it.
  const leaf = await win.webContents.executeJavaScript(hoverLeaf(barId));
  check(
    '悬停二级菜单内部的行不会把二级菜单自己收掉',
    leaf.found === true && leaf.total === 2 && leaf.deeper === 0,
    JSON.stringify(leaf),
  );

  // Both submenus in a row: the second must replace the first, not stack on it.
  const first = await win.webContents.executeJavaScript(sweepRow(barId, '更新通道', 2));
  const second = await win.webContents.executeJavaScript(sweepRow(barId, '更新镜像源', 2));
  check(
    '两个二级菜单之间只留最后一个',
    first.total === 1 && second.total === 1 && second.own === 1 && second.deeper === 0,
    `${JSON.stringify(first)} → ${JSON.stringify(second)}`,
  );

  // Clicking the page behind the menu is the other way out of it.
  const blank = await win.webContents.executeJavaScript(clickBlank(barId));
  check('点主界面空白处收起所有菜单', blank.left === 0, JSON.stringify(blank));

  // A submenu row must still reach the shell through the console bridge.
  await win.webContents.executeJavaScript(openMenu(barId, '文件'));
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('#' + ${JSON.stringify(barId)} + ' > .panel');
    if (panel === null) return { clicked: false, panelsLeft: -1 };
    const row = [...panel.querySelectorAll(':scope > .item')].find((el) => el.textContent.startsWith('更新通道'));
    if (row === undefined) return { clicked: false, panelsLeft: panel.querySelectorAll('.panel').length };
    row.dispatchEvent(new MouseEvent('mouseenter'));
    const sub = row.querySelector(':scope > .panel');
    if (sub === null) return { clicked: false, panelsLeft: panel.querySelectorAll('.panel').length };
    const alpha = [...sub.querySelectorAll(':scope > .item')].find((el) => el.dataset.cmd === 'channel:alpha');
    if (alpha === undefined) return { clicked: false, panelsLeft: panel.querySelectorAll('.panel').length };
    alpha.click();
    return { clicked: true, panelsLeft: document.querySelectorAll('#' + ${JSON.stringify(barId)} + ' .panel').length };
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  check(
    '点二级项仍然过桥并关闭菜单',
    clicked.clicked === true &&
      clicked.panelsLeft === 0 &&
      logs.includes('menu: run channel:alpha') &&
      commandCalls.includes('setChannel:alpha'),
    `${JSON.stringify(clicked)} logs=${JSON.stringify(logs)} calls=${JSON.stringify(commandCalls)}`,
  );

  // A submenu on the panel's first row has nowhere to go upward, so it has to be
  // pushed down to the bar's edge instead of crossing it.
  currentMenu = {
    data: [
      {
        label: '探针(&P)',
        items: [{ label: '第一行带二级菜单', items: [{ label: '子项', id: 'probe:leaf' }] }],
      },
    ],
    commands: { 'probe:leaf': { label: '子项', enabled: true, run: () => {} } },
  };
  check('换一套菜单定义后重新注入', (await desktop.refresh()) === 'ok');
  await win.webContents.executeJavaScript(openMenu(barId, '探针'));
  const firstRow = await win.webContents.executeJavaScript(submenuRect(barId, '第一行带二级菜单'));
  check(
    '面板第一行的二级菜单被压低到菜单栏之下',
    firstRow.found === true &&
      firstRow.sub.top >= firstRow.bar.bottom &&
      firstRow.sub.bottom <= firstRow.innerHeight + 1,
    JSON.stringify(firstRow),
  );

  win.destroy();
  const passed = checks - failures.length;
  console.log(`\n${passed}/${checks} checks passed`);
  if (failures.length > 0) {
    console.log(`failed: ${failures.join('; ')}`);
    app.exit(1);
    return;
  }
  app.exit(0);
}

main().catch((error) => {
  console.error(`FAILED: ${error.stack ?? error.message}`);
  app.exit(1);
});
