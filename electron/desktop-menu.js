'use strict';

/**
 * The application menu, drawn inside the page instead of by the window manager.
 *
 * The background is painted by the page, and a native menu bar is window chrome
 * drawn outside it — on Windows its fill cannot be made transparent, so a menu
 * bar there is always an opaque strip above the wallpaper. Drawing the menu in
 * the page is what lets the background run behind it.
 *
 * The menu definition stays in one place: it is built as plain data, rendered
 * into HTML, and registered as the native menu from the same data. The native
 * menu bar is *hidden* rather than removed, because it is what still owns every
 * accelerator (F5, F12, Ctrl+C, Alt+F4) — hiding the bar therefore costs no
 * shortcuts. `视图 → 使用系统菜单栏` puts the bar back and takes the page's own
 * bar away.
 *
 * ## How a click gets back here
 *
 * The page is untrusted: it runs DSH and any third-party plugin, and the shell
 * deliberately gives it no preload and no IPC channel. So it does not get one
 * for this either. The injected menu only writes a line to its own console —
 *
 *     dshbg-menu: run open-settings
 *
 * — and the main process listens for that prefix. It is a one-way, text-only
 * channel that can only ever name an id already present in the menu, which is a
 * far smaller surface than an IPC bridge: a plugin could already call
 * `console.log`, and the most this gains it is triggering a menu item the user
 * can see and click anyway.
 *
 * @module desktop/desktop-menu
 */

const { Menu, shell } = require('electron');

/** Console prefix the page uses to ask for a menu command. */
const CONSOLE_PREFIX = 'dshbg-menu:';
/** Ids of the injected bar and the style element that goes with it. */
const BAR_ID = 'dshbg-menubar';
const STYLE_ID = 'dshbg-menubar-style';
/** Height of the bar, in CSS pixels; the page is pushed down by exactly this. */
const BAR_HEIGHT = 28;

/**
 * Build the menu as data, plus the table of things it can do.
 *
 * `role` entries exist for the native menu, which owns their implementation and
 * accelerator. Every entry also carries what the page needs to draw it, so the
 * two menus cannot drift apart.
 *
 * @param {object} context - the shell's live state and helpers.
 * @returns {{ data: object[], commands: Record<string, { label: string,
 *   enabled?: boolean, role?: string, accelerator?: string, run?: Function }> }}
 */
function buildMenuData(context) {
  const {
    runtimeManager,
    profileGuard,
    appUrl,
    backgroundManager,
    mainWindow,
    nativeMenuBar,
    setNativeMenuBar,
    dshHome,
    logDir,
    restartRuntime,
    setChannel,
    manualProfileRollback,
    manualCheck,
    isCheckingUpdate,
    isUpdating,
    mirrors,
    registryId,
    setMirror,
    testMirrors,
    showUpdateProgress,
    doRollback,
    showAbout,
    rebuildMenu,
  } = context;

  const commands = {
    'reload-window': { label: '重新加载界面', accelerator: 'F5', run: () => mainWindow()?.reload() },
    'open-in-browser': {
      label: '在默认浏览器中打开',
      enabled: () => appUrl() !== null,
      run: () => {
        const url = appUrl();
        if (url !== null) shell.openExternal(url).catch(() => {});
      },
    },
    'restart-runtime': { label: '重启 DSH 内核', run: () => void restartRuntime() },
    'rollback-profile': {
      label: '回退到上次可用配置',
      enabled: () => profileGuard.hasSnapshot(),
      run: () => void manualProfileRollback(),
    },
    'manual-update': {
      label: () => (isCheckingUpdate() ? '正在检查更新…' : '检查更新…'),
      enabled: () => !isCheckingUpdate(),
      run: () => void manualCheck(),
    },
    'update-progress': {
      label: () => (isUpdating() ? '更新进度（下载中…）' : '更新进度…'),
      run: () => showUpdateProgress(),
    },
    'mirror-speed-test': {
      label: () => (isUpdating() ? '测速并推荐最快镜像（下载中不可用）' : '测速并推荐最快镜像…'),
      enabled: () => !isUpdating(),
      run: () => void testMirrors(),
    },
    rollback: {
      label: () => {
        const previous = runtimeManager.describe().previous;
        return previous === null ? '回退到上一版本' : `回退到 DSH ${previous}`;
      },
      enabled: () => runtimeManager.describe().previous !== null,
      run: () => doRollback(),
    },
    'use-bundled': {
      label: '恢复为内置运行时',
      enabled: () => runtimeManager.describe().source !== 'bundled',
      run: () => {
        runtimeManager.writeState({ activeVersion: null, previousVersion: null });
        rebuildMenu();
        void restartRuntime();
      },
    },
    'open-dsh-home': { label: () => `打开配置目录 (${dshHome()})`, run: () => void openPath(dshHome()) },
    'open-backup-dir': { label: '打开配置备份目录', run: () => void openPath(profileGuard.backupRoot()) },
    'open-log-dir': { label: '打开日志目录', run: () => void openPath(logDir) },
    'toggle-native-menu': {
      label: () => (nativeMenuBar() ? '使用页面内菜单栏' : '使用系统菜单栏'),
      run: () => setNativeMenuBar(!nativeMenuBar()),
    },
    undo: { label: '撤销', role: 'undo' },
    redo: { label: '重做', role: 'redo' },
    cut: { label: '剪切', role: 'cut' },
    copy: { label: '复制', role: 'copy' },
    paste: { label: '粘贴', role: 'paste' },
    selectAll: { label: '全选', role: 'selectAll' },
    resetZoom: { label: '实际大小', role: 'resetZoom' },
    zoomIn: { label: '放大', role: 'zoomIn' },
    zoomOut: { label: '缩小', role: 'zoomOut' },
    togglefullscreen: { label: '全屏', role: 'togglefullscreen' },
    'toggle-devtools': {
      label: '开发者工具',
      accelerator: 'F12',
      run: () => mainWindow()?.webContents.toggleDevTools(),
    },
    'background-settings': { label: '背景设置…', run: () => backgroundManager.openSettings() },
    'clear-background': {
      label: '清除背景',
      enabled: () => backgroundManager.hasBackground(),
      run: () => backgroundManager.clearBackground(),
    },
    quit: { label: '退出', accelerator: 'Alt+F4', role: 'quit' },
    about: { label: '关于 DeepSeek Harness', run: () => showAbout() },
  };

  /** One command, in the shape the page draws. */
  const at = (id) => {
    const command = commands[id];
    if (command === undefined) throw new Error(`unknown menu command: ${id}`);
    return {
      id,
      label: typeof command.label === 'function' ? command.label() : command.label,
      enabled: command.enabled === undefined ? true : command.enabled(),
    };
  };

  const described = runtimeManager.describe();
  // The page draws channel rows like any other item, so a click arrives here as
  // `run channel:<name>`. Register them as real commands, otherwise the bridge
  // reports `unknown command: channel:<name>` and nothing happens.
  for (const name of runtimeManager.CHANNELS) {
    commands[`channel:${name}`] = { run: () => void setChannel(name) };
  }
  const channels = runtimeManager.CHANNELS.map((name) => ({
    id: `channel:${name}`,
    label:
      name === 'next' ? 'next（稳态预发布）' : name === 'alpha' ? 'alpha（跟随 master）' : 'latest',
    checked: described.channel === name,
  }));

  // Mirrors are rows for the same reason channels are: the page draws them as
  // ordinary items, so a click arrives as `run mirror:<id>` and has to map onto
  // a registered command.
  const allMirrors = mirrors();
  for (const mirror of allMirrors) {
    commands[`mirror:${mirror.id}`] = { run: () => void setMirror(mirror.id) };
  }
  const currentMirror = runtimeManager.mirrorFor(registryId());
  const mirrorItems = allMirrors.map((mirror) => ({
    id: `mirror:${mirror.id}`,
    label:
      mirror.url === null
        ? mirror.label
        : `${mirror.label}（${mirror.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}）`,
    checked: mirror.id === currentMirror.id,
  }));
  mirrorItems.push({ separator: true }, at('mirror-speed-test'));

  const data = [
    {
      label: '文件(&F)',
      items: [
        {
          label: `当前 DSH ${described.active ?? '未知'} · ${described.source === 'bundled' ? '内置' : '已安装'}`,
          info: true,
        },
        { separator: true },
        at('reload-window'),
        at('open-in-browser'),
        at('restart-runtime'),
        { separator: true },
        { label: profileGuard.describeSnapshot(), info: true },
        at('rollback-profile'),
        { separator: true },
        at('manual-update'),
        at('update-progress'),
        { label: `更新镜像源（${currentMirror.label}）`, items: mirrorItems },
        { label: '更新通道', items: channels },
        at('rollback'),
        at('use-bundled'),
        { separator: true },
        at('open-dsh-home'),
        at('open-backup-dir'),
        at('open-log-dir'),
        { separator: true },
        at('quit'),
      ],
    },
    {
      label: '编辑(&E)',
      items: [
        at('undo'),
        at('redo'),
        { separator: true },
        at('cut'),
        at('copy'),
        at('paste'),
        at('selectAll'),
      ],
    },
    {
      label: '视图(&V)',
      items: [
        at('resetZoom'),
        at('zoomIn'),
        at('zoomOut'),
        { separator: true },
        at('togglefullscreen'),
        at('toggle-devtools'),
        { separator: true },
        at('background-settings'),
        at('clear-background'),
        at('toggle-native-menu'),
      ],
    },
    { label: '帮助(&H)', items: [at('about')] },
  ];

  return { data, commands };
}

/** `shell.openPath`, which never throws for a missing path but can reject. */
function openPath(target) {
  return shell.openPath(target).catch(() => {});
}

/**
 * Turn menu data into an Electron menu template. Roles are passed through, so
 * the native bar keeps owning their behaviour and accelerators.
 * @param {object[]} data
 * @param {Record<string, object>} commands
 */
function toTemplate(data, commands) {
  const convert = (items) =>
    items.map((item) => {
      if (item.separator === true) return { type: 'separator' };
      if (item.info === true) return { label: item.label, enabled: false };
      if (item.items !== undefined) {
        return {
          label: item.label,
          // Nested levels (e.g. the update channels) need the same conversion,
          // otherwise their entries reach Electron as raw data with no click.
          submenu: convert(item.id === undefined ? item.items.filter((entry) => entry.info !== true) : item.items),
        };
      }
      const command = commands[item.id];
      return {
        label: item.label,
        id: item.id,
        enabled: item.enabled,
        accelerator: command?.accelerator,
        ...(item.checked === undefined ? {} : { type: 'radio', checked: item.checked }),
        ...(command?.role === undefined ? { click: () => command?.run?.() } : { role: command.role }),
      };
    });
  return data.map((top) => ({ label: top.label, submenu: convert(top.items) }));
}

/**
 * The function that draws the bar, as source text.
 *
 * It is written as a function expression rather than an IIFE so the caller can
 * wrap it in its own try/catch — see `refresh`. It runs in the page, which is
 * why it is text and not a normal function.
 *
 * @param {object[]} data - the menu definition, as plain data.
 * @returns {string} JS source for a `(document) => string` function.
 */
function drawFunction(data) {
  return `function (document) {
  const MENUS = ${JSON.stringify(data)};
  const BAR_ID = ${JSON.stringify(BAR_ID)};
  const STYLE_ID = ${JSON.stringify(STYLE_ID)};
  if (document.body === null) return 'no-body';
  document.getElementById(BAR_ID)?.remove();

  if (document.getElementById(STYLE_ID) === null) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = \`
      :root {
        --dshbg-menu-bg: rgba(26, 27, 31, 0.30);
        --dshbg-menu-fg: #ffffff;
        --dshbg-menu-hover: rgba(255, 255, 255, 0.16);
        --dshbg-menu-line: rgba(255, 255, 255, 0.14);
        --dshbg-menu-dim: rgba(255, 255, 255, 0.72);
        --dshbg-menu-off: rgba(255, 255, 255, 0.38);
        --dshbg-menu-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
      }
      html:not([data-ds-dark-theme]) body {
        --dshbg-menu-bg: rgba(250, 250, 252, 0.34);
        --dshbg-menu-fg: #12151c;
        --dshbg-menu-hover: rgba(0, 0, 0, 0.10);
        --dshbg-menu-line: rgba(0, 0, 0, 0.14);
        --dshbg-menu-dim: rgba(18, 21, 28, 0.68);
        --dshbg-menu-off: rgba(18, 21, 28, 0.34);
        --dshbg-menu-shadow: 0 10px 30px rgba(30, 35, 50, 0.28);
      }
      /* Push the app down by exactly the bar's height, so the bar is a real strip
         and not an overlay on the app's own header.
         Border-box is what makes that safe: the page is height:100%, so padding
         added *outside* the box would make it 28px taller than the window. With
         html{overflow:hidden} the browser cannot scroll the html element, so it
         moves the scroller inside body instead — and the app's bottom row (the
         settings button) ends up below the fold behind a scrollbar. Border-box
         keeps the page exactly one window tall.
         No backticks in this comment: everything here is inside a template
         literal, and a stray one closes it and breaks the whole wrapper.
         DSH writes body padding inline, hence !important. */
      body { padding-top: ${BAR_HEIGHT}px !important; box-sizing: border-box !important; }
      #${BAR_ID} {
        position: fixed; top: 0; left: 0; right: 0; height: ${BAR_HEIGHT}px;
        box-sizing: border-box;
        display: flex; align-items: stretch; z-index: 2147483000;
        /* A real translucent tint rather than a backdrop blur. A filter on a
           root-level fixed element composites against the document rather than
           against the picture behind it, which left the bar an opaque black
           strip while the dropdowns — nested, and so composited differently —
           showed the wallpaper correctly. The tint is what matters: the picture
           only has to be legible behind it. */
        background: var(--dshbg-menu-bg);
        border-bottom: 1px solid var(--dshbg-menu-line);
        color: var(--dshbg-menu-fg);
        font: 12.5px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
        user-select: none;
      }
      #${BAR_ID} .top {
        display: flex; align-items: center; padding: 0 11px; cursor: default;
        white-space: nowrap;
      }
      #${BAR_ID} .top:hover, #${BAR_ID} .top.open { background: var(--dshbg-menu-hover); }
      #${BAR_ID} .panel {
        position: fixed; top: ${BAR_HEIGHT}px; min-width: 250px; max-width: 420px;
        padding: 5px; border-radius: 8px;
        background: var(--dshbg-menu-bg);
        -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
        border: 1px solid var(--dshbg-menu-line);
        box-shadow: var(--dshbg-menu-shadow);
        color: var(--dshbg-menu-fg);
        font: 12.5px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
      }
      /* A submenu hangs off its own row, not off the panel: the row is its parent
         so that moving the pointer onto the submenu does not read as leaving the
         row, and the row is positioned so that 'left: 100%' means the panel's
         right edge rather than the panel's own left edge. Where it actually lands
         is measured in placeSubmenu below; this rule only has to be a sane
         starting point for that measurement. */
      #${BAR_ID} .panel .panel {
        position: absolute; top: -6px; left: 100%;
        -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
      }
      #${BAR_ID} .item {
        position: relative;
        display: flex; align-items: center; gap: 10px;
        padding: 5px 10px; border-radius: 5px; cursor: default; white-space: nowrap;
      }
      #${BAR_ID} .item:hover { background: var(--dshbg-menu-hover); }
      #${BAR_ID} .item.info { color: var(--dshbg-menu-dim); }
      #${BAR_ID} .item[data-off="1"] { color: var(--dshbg-menu-off); }
      #${BAR_ID} .item[data-off="1"]:hover { background: transparent; }
      #${BAR_ID} .item .label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
      #${BAR_ID} .item .arrow { color: var(--dshbg-menu-dim); }
      #${BAR_ID} .item .tick { color: #4d6bfe; width: 11px; text-align: center; }
      #${BAR_ID} .sep { height: 1px; margin: 5px 8px; background: var(--dshbg-menu-line); }
    \`;
    document.head.appendChild(style);
  }

  const bar = document.createElement('div');
  bar.id = BAR_ID;
  let open = null;
  const close = () => {
    if (open !== null) { open.panel.remove(); open.item.classList.remove('open'); open = null; }
  };

  /**
   * Put a submenu beside the row it was opened from.
   *
   * The position is measured, not inherited from CSS. Two things decide where an
   * absolutely positioned box lands — which ancestor counts as its containing
   * block, and which edge 'left: 100%' is measured from — and both are easy to
   * get wrong here: the panel carries a backdrop filter (which is itself a
   * containing block for its descendants), and the top of the page belongs to the
   * bar. So the box is first put at a known origin, its real position is read
   * back, and it is moved by the difference; that lands it in the right place
   * whichever ancestor the engine picked, and it is what keeps a submenu for a
   * top-of-the-panel row from crossing the bar's bottom line.
   */
  const placeSubmenu = (sub, row, panel) => {
    const rowRect = row.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    sub.style.left = '0px';
    sub.style.top = '0px';
    const origin = sub.getBoundingClientRect();
    const gap = 2;
    // The bar is a fixed strip across the top of the page, so the floor for
    // anything drawn in the page is the bar's bottom edge.
    const floor = ${BAR_HEIGHT} + gap;
    // Sit against the panel's right edge with a few pixels of overlap, so the
    // pointer never has to cross a gap to reach the submenu.
    let left = panelRect.right - 4;
    if (left + origin.width > window.innerWidth - gap) left = panelRect.left - origin.width + 4;
    left = Math.max(gap, left);
    let top = rowRect.top - 6;
    if (top < floor) top = floor;
    if (top + origin.height > window.innerHeight - gap) {
      top = Math.max(floor, window.innerHeight - gap - origin.height);
    }
    sub.style.left = Math.round(left - origin.left) + 'px';
    sub.style.top = Math.round(top - origin.top) + 'px';
  };

  const buildPanel = (items) => {
    const panel = document.createElement('div');
    panel.className = 'panel';
    for (const item of items) {
      if (item.separator === true) {
        const rule = document.createElement('div');
        rule.className = 'sep';
        panel.appendChild(rule);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'item' + (item.info === true ? ' info' : '');
      const clickable = item.info !== true && item.enabled !== false;
      if (item.info !== true && item.enabled === false) row.dataset.off = '1';
      // Records which command a row stands for, so a test can click a named item
      // rather than guessing at its position.
      if (item.id !== undefined) row.dataset.cmd = item.id;

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = item.label;
      row.appendChild(label);

      if (item.checked === true || item.checked === false) {
        const tick = document.createElement('span');
        tick.className = 'tick';
        tick.textContent = item.checked ? '✓' : '';
        row.appendChild(tick);
      }

      if (item.items !== undefined) {
        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = '›';
        row.appendChild(arrow);
      } else if (clickable) {
        row.addEventListener('click', (event) => {
          event.stopPropagation();
          close();
          console.log(${JSON.stringify(CONSOLE_PREFIX)} + ' run ' + item.id);
        });
      }
      // The row the pointer is on shows its own submenu and nothing else: a row
      // with children builds one, a plain row leaves the panel bare. That is only
      // safe because a submenu hangs off its own row — the pointer walks sideways
      // from the row into the submenu, so no other row is in the way, and moving
      // up off the row is meant to close it.
      // Clearing has to match *all* descendants: a submenu is appended to its own
      // row, not to the panel, so a ':scope > .panel' test never saw it and each
      // hover in-and-out piled up one more floating panel.
      row.addEventListener('mouseenter', () => {
        for (const other of panel.querySelectorAll('.panel')) other.remove();
        if (item.items === undefined) return;
        const sub = buildPanel(item.items);
        row.appendChild(sub);
        placeSubmenu(sub, row, panel);
      });
      panel.appendChild(row);
    }
    return panel;
  };

  for (const top of MENUS) {
    const item = document.createElement('div');
    item.className = 'top';
    // '文件(&F)' shows as '文件': the bar is not keyboard-navigable, so an
    // underlined mnemonic would promise something it cannot do.
    item.textContent = String(top.label).replace(/&\(.\)/, '').replace(/&/g, '');
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      const wasOpen = open !== null && open.item === item;
      close();
      if (wasOpen) return;
      const panel = buildPanel(top.items);
      panel.style.left = Math.round(item.getBoundingClientRect().left) + 'px';
      bar.appendChild(panel);
      item.classList.add('open');
      open = { item, panel };
      const bounds = panel.getBoundingClientRect();
      if (bounds.right > window.innerWidth) {
        panel.style.left = Math.max(4, window.innerWidth - bounds.width - 4) + 'px';
      }
    });
    item.addEventListener('mouseenter', () => { if (open !== null && open.item !== item) item.click(); });
    bar.appendChild(item);
  }

  document.addEventListener('mousedown', (event) => { if (!bar.contains(event.target)) close(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  window.addEventListener('blur', close);
  // Hung off <html>, not <body>: the application owns body's children (it is a
  // framework root) and reconciles them away, which is exactly what happened to
  // the first version of this bar. Nothing but the page itself writes to <html>.
  document.documentElement.appendChild(bar);
  return 'ok';
}`;
}

/** Take the bar back out, for native menu mode. */
function removeScript() {
  return `(() => {
    document.getElementById(${JSON.stringify(BAR_ID)})?.remove();
    document.getElementById(${JSON.stringify(STYLE_ID)})?.remove();
    const body = document.body;
    if (body !== null) {
      body.style.removeProperty('padding-top');
      body.style.removeProperty('box-sizing');
    }
    // Stop the observer from putting the bar straight back.
    delete window.__dshbgMenuRedraw;
    window.__dshbgMenuWatch = false;
    return 'removed';
  })()`;
}

/**
 * Install the menu into a window that hosts the DSH page.
 *
 * @param {object} options
 * @param {Electron.WebContents} options.contents
 * @param {() => { data: object[], commands: object, pageMenu: boolean }} options.getMenu
 * @param {(name: string) => void} options.setChannel
 * @param {(message: string) => void} [options.log] - shell logger.
 * @returns {{ install: () => void, refresh: () => void }}
 */
function createDesktopMenu({ contents, getMenu, setChannel, log }) {
  let installed = false;

  /**
   * One-way channel from the page: the injected menu logs the command it wants.
   * Nothing else in the page can reach the shell through this.
   */
  function installConsoleBridge() {
    contents.on('console-message', (...args) => {
      try {
        // Electron changed this event's signature across versions; the log line is
        // whichever argument is the message string.
        const message = args.find(
          (value) => typeof value === 'string' && value.startsWith(CONSOLE_PREFIX),
        );
        if (typeof message !== 'string') return;
        const request = message.slice(CONSOLE_PREFIX.length).trim();
        if (request === 'redraw') {
          // The page noticed the bar was thrown away; draw it again.
          refreshNow();
          return;
        }
        if (request.startsWith('run ')) {
          const id = request.slice(4).trim();
          const command = getMenu().commands[id];
          if (command !== undefined && command.run !== undefined) {
            // The click that reaches the shell must leave a trace in desktop.log:
            // a swallowed command is otherwise indistinguishable from a click
            // that never arrived.
            log?.(`menu: run ${id}`);
            command.run();
          } else {
            log?.(`menu: unknown command: ${id}`);
          }
          return;
        }
        if (request.startsWith('channel ')) {
          log?.(`menu: ${request}`);
          setChannel(request.slice(8).trim());
          return;
        }
        log?.(`menu: ignored request: ${request}`);
      } catch (error) {
        // A throwing getMenu() must not look like a click that never arrived.
        log?.(`menu: bridge failed: ${error && error.message}`);
      }
    });
  }

  /**
   * Watch for the bar being thrown away, and put it back.
   *
   * `dom-ready` and `did-finish-load` fire while the application is still
   * booting, and a framework that rebuilds its root during boot takes foreign
   * nodes with it — the bar then has to survive a page whose DOM is still
   * moving. An observer is what makes it stick: whatever replaces the node, the
   * next mutation re-adds it.
   */
  function watchScript() {
    return `(() => {
      const ID = ${JSON.stringify(BAR_ID)};
      const STYLE_ID = ${JSON.stringify(STYLE_ID)};
      // The page asks for a redraw by logging; the redraw itself is built by the
      // main process, which is the only side that has the menu definition.
      window.__dshbgMenuRedraw = () => console.log(${JSON.stringify(CONSOLE_PREFIX)} + ' redraw');
      if (window.__dshbgMenuWatch === true) return 'watching';
      window.__dshbgMenuWatch = true;
      let pending = false;
      const observer = new MutationObserver(() => {
        // Only the bar's absence is interesting, and redrawing on every mutation
        // would fight whatever is mutating.
        if (document.getElementById(ID) !== null) return;
        if (document.getElementById(STYLE_ID) === null) return;  // native menu mode
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          window.__dshbgMenuRedraw?.();
        });
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      return 'watching';
    })()`;
  }

  /**
   * Put the bar in, or take it out, according to the current mode.
   *
   * The drawing is wrapped in its own try/catch because `executeJavaScript` only
   * reports "Script failed to execute" and points at a renderer console nobody
   * is reading — so the actual exception has to travel back as the result.
   *
   * @returns {Promise<string>} `ok`, `no-body`, or `error: …`; the caller can
   *   await it, which is what makes a failure visible in a test.
   */
  async function refreshNow() {
    try {
      const menu = getMenu();
      if (menu.pageMenu === false) {
        await contents.executeJavaScript(removeScript(), true).catch(() => {});
        return 'removed';
      }
      const script = `(() => { try { return (${drawFunction(menu.data)})(document); } catch (error) { return 'error: ' + (error && error.message); } })()`;
      const result = await contents.executeJavaScript(script, true);
      if (result !== 'ok' && result !== 'no-body') log?.(`menu: bar injection said ${result}`);
      // Arm the observer only once the bar is actually on the page, so it can
      // tell "thrown away" apart from "never drawn".
      if (result === 'ok') await contents.executeJavaScript(watchScript(), true).catch(() => {});
      return result;
    } catch (error) {
      // `getMenu()` is part of the drawing: a throwing getter used to escape as an
      // unhandled rejection, which left no trace anywhere.
      log?.(`menu: bar injection failed: ${error && error.message}`);
      return `error: ${error && error.message}`;
    }
  }

  return {
    install() {
      if (installed) return;
      installed = true;
      installConsoleBridge();
      const draw = () => refreshNow();
      contents.on('dom-ready', draw);
      contents.on('did-finish-load', draw);
      // The application finishes booting well after `did-finish-load`, and what
      // it does then can take the bar with it. Redrawing after the dust settles
      // is cheaper than reasoning about exactly when that is.
      for (const delay of [500, 1500, 3000, 6000]) {
        setTimeout(() => {
          if (!contents.isDestroyed()) void refreshNow().catch(() => {});
        }, delay);
      }
    },
    refresh: refreshNow,
  };
}

module.exports = { createDesktopMenu, buildMenuData, toTemplate, CONSOLE_PREFIX, BAR_ID, STYLE_ID };
