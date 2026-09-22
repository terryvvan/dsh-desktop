// 一次性探针 v3：验证 desktop-menu 看门狗的新逻辑
//   A 基线：bar + style 都在
//   B 只删样式表 → 期望自动重画（旧版本这里永远不会恢复）
//   C 把 bar 和样式表一起删 → 期望自动重画
//   D 切到 native 菜单模式（pageMenu:false）→ bar/style 都被移除
//   E native 模式下反复改 DOM → 期望菜单不回来（不刷屏）
// 运行：node_modules\electron\dist\electron.exe scripts\probe-menu-watch.cjs
// 进度同时写文件（窗口是可见的，rAF 才和真实场景一致，所以 stdout 可能被 GUI 吞掉）。
const { app, BrowserWindow } = require('electron');
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createDesktopMenu } = require('../electron/desktop-menu');

const OUT = 'F:\\v\\project\\dsh-desktop\\.tmp-shot\\probe-watch.log';
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, '');
const say = (line) => {
  const text = typeof line === 'string' ? line : JSON.stringify(line);
  console.log(text);
  try {
    appendFileSync(OUT, text + '\n');
  } catch {}
};

setTimeout(() => {
  say('TIMEOUT after 45s — 进程没走到 app.exit');
  app.exit(3);
}, 45000);

const LOG = 'C:\\Users\\LEGION\\AppData\\Roaming\\DeepSeek Harness\\logs\\desktop.log';
const matches = [...readFileSync(LOG, 'utf8').matchAll(/runtime ready at (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/g)];
if (matches.length === 0) {
  say('desktop.log 里没有 runtime ready 行');
  app.exit(1);
}
const URL = matches[matches.length - 1][1];
say('probe url: ' + URL.slice(0, 55) + '…');

const menuData = [
  { id: 'file', label: '文件(&F)', items: [{ id: 'open-settings', label: '设置…' }, { sep: true }, { id: 'quit', label: '退出' }] },
  { id: 'edit', label: '编辑(&E)', items: [{ id: 'copy', label: '复制' }] },
  { id: 'view', label: '视图(&V)', items: [{ id: 'zoom', label: '缩放' }] },
  { id: 'help', label: '帮助(&H)', items: [{ id: 'about', label: '关于' }] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(os.tmpdir(), `dsh-menu-probe-watch-${process.pid}`));

const DIAGNOSE = `(() => {
  const bar = document.getElementById('dshbg-menubar');
  const style = document.getElementById('dshbg-menubar-style');
  const cs = bar ? getComputedStyle(bar) : null;
  return {
    hasBar: !!bar,
    hasStyleEl: !!style,
    mode: window.__dshbgMenuMode ?? null,
    watch: window.__dshbgMenuWatch === true,
    barPosition: cs ? cs.position : null,
    barTop: cs ? cs.top : null,
    barHeight: cs ? cs.height : null,
    bodyPadTop: getComputedStyle(document.body).paddingTop,
    docHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  };
})()`;

let pageMenu = true;
const notes = [];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (...args) => {
    const msg = args.find((v) => typeof v === 'string');
    if (typeof msg === 'string' && (msg.includes('dshbg') || msg.includes('Error'))) notes.push(msg.slice(0, 160));
  });

  const menu = createDesktopMenu({
    contents: win.webContents,
    getMenu: () => ({ data: menuData, pageMenu }),
    setChannel: () => {},
    log: (line) => notes.push('log: ' + line),
  });
  menu.install();

  const diag = async (label) => {
    const d = await win.webContents.executeJavaScript(DIAGNOSE, true);
    say(`=== ${label} ===`);
    say(d);
    return d;
  };

  say('loading…');
  await win.loadURL(URL);
  say('loaded');
  await sleep(2500);
  await diag('A baseline');

  await win.webContents.executeJavaScript(`(() => { document.getElementById('dshbg-menubar-style')?.remove(); return 'style removed'; })()`, true);
  await sleep(900);
  await diag('B style-only removal (expect hasStyleEl=true, mode=page)');

  await win.webContents.executeJavaScript(`(() => { document.getElementById('dshbg-menubar')?.remove(); document.getElementById('dshbg-menubar-style')?.remove(); return 'nuked'; })()`, true);
  await sleep(900);
  await diag('C bar+style removal (expect both back)');

  pageMenu = false;
  await menu.refresh();
  await sleep(300);
  await diag('D native mode (expect hasBar=false, mode=native)');

  await win.webContents.executeJavaScript(`(() => { for (let i = 0; i < 5; i += 1) document.body.appendChild(document.createElement('div')); return 'mutated'; })()`, true);
  await sleep(900);
  await diag('E after 5 mutations in native mode (expect hasBar=false)');

  say('=== NOTES ===');
  say(notes);
  say('done');
  app.exit(0);
});
