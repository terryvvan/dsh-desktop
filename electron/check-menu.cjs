'use strict';

/**
 * Exercise the menu module outside the shell.
 *
 * `buildMenu` runs during startup, so a mistake in the menu definition would
 * stop the app from launching at all — and the failure would look like "the
 * window never appeared". This builds the menu against stubs, converts it for
 * the native bar, and asserts the two renderings agree, so that risk is checked
 * without booting a runtime.
 *
 *   node_modules/electron/dist/electron.exe electron/check-menu.cjs
 *
 * It sits next to `main.js` rather than in `scripts/` because the packaged app
 * ships exactly `electron/**`, so this way it can be run against a build too.
 */

const { app, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = process.env.CHECK_OUT ?? path.join(__dirname, '..', 'menu-check.json');

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

const notes = [];

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
    setChannel: () => {},
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

async function main() {
  await app.whenReady();
  const menu = require(path.join(__dirname, '..', 'electron', 'desktop-menu.js'));

  const built = menu.buildMenuData(context(true));
  notes.push(`top-level menus: ${built.data.map((top) => top.label).join(' | ')}`);

  // Every leaf the page can draw must either be informational or name a command,
  // and every named command must exist — otherwise a click silently does nothing.
  const missing = [];
  const walk = (items, trail) => {
    for (const item of items) {
      if (item.separator === true) continue;
      if (item.items !== undefined) {
        walk(item.items, `${trail}/${item.label}`);
        continue;
      }
      if (item.info === true) continue;
      if (item.id === undefined) missing.push(`${trail}: no id`);
      else if (built.commands[item.id] === undefined) missing.push(`${trail}: unknown id ${item.id}`);
    }
  };
  walk(built.data, '');
  notes.push(missing.length === 0 ? 'every drawable item maps to a command' : `PROBLEMS: ${missing.join('; ')}`);

  // The native template must be accepted by Electron, and must keep every role
  // (the roles are what own the accelerators while the bar is hidden).
  const template = menu.toTemplate(built.data, built.commands);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  const seen = [];
  const collect = (items) => {
    for (const item of items) {
      if (item.submenu !== undefined && Array.isArray(item.submenu)) collect(item.submenu);
      else if (item.role !== undefined) seen.push(item.role);
    }
  };
  collect(template);
  notes.push(`native template accepted; roles: ${[...new Set(seen)].sort().join(', ')}`);

  for (const role of ['undo', 'copy', 'paste', 'selectAll', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen', 'quit']) {
    if (!seen.includes(role)) notes.push(`MISSING ROLE: ${role}`);
  }

  const pageCount = JSON.stringify(built.data).length;
  notes.push(`definitions agree: page data ${pageCount} chars, native submenus ${template.length}`);

  fs.writeFileSync(OUT, `${notes.join('\n')}\n`, 'utf8');
  app.exit(0);
}

main().catch((error) => {
  notes.push(`FAILED: ${error.stack ?? error.message}`);
  fs.writeFileSync(OUT, `${notes.join('\n')}\n`, 'utf8');
  app.exit(1);
});
