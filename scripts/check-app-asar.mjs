// 检查打包版桌面端的 app.asar 是否已换上带菜单看门狗修复的 electron/desktop-menu.js
import { listPackage, extractFile } from '@electron/asar';

const p = process.argv[2] ?? 'F:/v/project/dsh-desktop/dist/win-unpacked/resources/app.asar';
console.log(`--- ${p}`);
const entries = listPackage(p);
const src = extractFile(p, 'electron/desktop-menu.js').toString('utf8');
console.log(`entries=${entries.length}`);
console.log(`desktop-menu.js bytes=${Buffer.byteLength(src)}`);
console.log(`has __dshbgMenuMode=${src.includes('__dshbgMenuMode')}`);
console.log(`has backtick-in-comment bug=${src.includes('`removeScript`')}`);
const m = src.match(/__dshbgMenuMode\s*=\s*'(\w+)'/g);
console.log(`mode assignments=${m ? m.join(', ') : 'none'}`);
