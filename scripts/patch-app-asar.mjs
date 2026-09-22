// 把仓库里的 electron/*.js 重新打进打包版的 app.asar（默认只同步 desktop-menu.js）。
// 用法：node scripts/patch-app-asar.mjs [--apply] [--all]
//   --apply  真正写盘（先备份 app.asar 为 app.asar.bak-pre-menu-watch）
//   --all    同步整个 electron/ 目录，而不是只同步 desktop-menu.js
// 说明：运行中的 DeepSeekHarness.exe 可能锁住 app.asar；替换失败时会保留新 asar 路径并提示先退出 app。
import * as asar from '@electron/asar';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = 'F:\\v\\project\\dsh-desktop';
const ARCHIVE = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
const BACKUP = `${ARCHIVE}.bak-pre-menu-watch`;
const ELECTRON_SRC = path.join(ROOT, 'electron');

const apply = process.argv.includes('--apply');
const syncAll = process.argv.includes('--all');
const files = syncAll
  ? ['main.js', 'desktop-menu.js', 'preload.js', 'profile-guard.js', 'background.js', 'background-ui.js', 'check-menu.cjs', 'tarball-cache.js', 'update-preload.js', 'update-ui.js', 'update-window.js', 'updater.js']
  : ['desktop-menu.js'];

console.log(`archive: ${ARCHIVE} (${statSync(ARCHIVE).size} B)`);
// 工作目录必须和 app.asar 同卷：跨盘 rename 会报 EXDEV: cross-device link not permitted
const work = mkdtempSync(path.join(ROOT, '.tmp-asar-'));
console.log(`work dir: ${work}`);

await asar.extractAll(ARCHIVE, work);

for (const name of files) {
  const src = path.join(ELECTRON_SRC, name);
  const dest = path.join(work, 'electron', name);
  if (!existsSync(src)) throw new Error(`missing source: ${src}`);
  const same = existsSync(dest) && readFileSync(src).equals(readFileSync(dest));
  console.log(`${same ? 'unchanged' : 'REPLACE'}  electron/${name}  (${statSync(src).size} B)`);
  if (!same) copyFileSync(src, dest);
}

const out = path.join(work, 'app.asar.new');
await asar.createPackage(work, out);
console.log(`repacked: ${out} (${statSync(out).size} B)`);

// 自检：新 asar 里必须能读出改过的标记
const marker = readFileSync(path.join(ELECTRON_SRC, 'desktop-menu.js'), 'utf8').includes('__dshbgMenuMode');
const check = mkdtempSync(path.join(tmpdir(), 'dsh-asar-check-'));
await asar.extractAll(out, check);
const inArchive = readFileSync(path.join(check, 'electron', 'desktop-menu.js'), 'utf8');
console.log(`desktop-menu.js carries __dshbgMenuMode: ${inArchive.includes('__dshbgMenuMode')} (repo had it: ${marker})`);
console.log(`archive entries: ${asar.listPackage(out).length}`);

if (!apply) {
  console.log('dry run — 加 --apply 才会替换 app.asar');
  process.exit(0);
}

if (!existsSync(BACKUP)) {
  copyFileSync(ARCHIVE, BACKUP);
  console.log(`backup: ${BACKUP} (${statSync(BACKUP).size} B)`);
} else {
  console.log(`backup already exists: ${BACKUP}`);
}

try {
  renameSync(out, ARCHIVE);
  console.log(`replaced app.asar (${statSync(ARCHIVE).size} B) — 需要重启桌面端 app 才生效`);
} catch (error) {
  console.log(`replace failed: ${error.code ?? ''} ${error.message}`);
  console.log(`新 asar 留在 ${out}；请先退出 DeepSeekHarness.exe，再把它改名覆盖到 ${ARCHIVE}`);
  process.exitCode = 2;
}
