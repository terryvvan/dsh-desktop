// 通用修复：把插件客户端里引用的 host 旧图标名（IconXxx16 / IconXxx14）映射成新名 IconXxxRegular。
//
// 背景：DSH 0.1.7-alpha.2 的 @deepseek-ai/dsh-client-ui-primitives 把图标从「名字带尺寸」
// 改成「名字带字重」（尺寸改由 size prop 传）：IconSearchOutline16 -> IconSearchOutlineRegular、
// IconChevronDownOutline14 -> IconChevronDownOutlineRegular …。仍用旧名的插件客户端取到的是
// undefined，渲染 host Button（或其 children）时抛 React error #130，整个插件面板被错误边界替换。
//
// 用法：node scripts/fix-plugin-icons.mjs          # 只扫描（dry-run，零写入）
//       node scripts/fix-plugin-icons.mjs --apply  # 就地替换，改前备份 <file>.bak-pre-iconmap
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const ROOT = 'C:\\Users\\LEGION\\.dsh\\profiles\\web\\node_modules';
const HOST_INDEX =
  'C:\\Users\\LEGION\\AppData\\Roaming\\DeepSeek Harness\\runtimes\\0.1.7-alpha.2\\node_modules\\@deepseek-ai\\dsh-client-ui-primitives\\lib\\index.js';
const PREFIX = '_deepseek_ai_dsh_client_ui_primitives.';
const OLD_RE = new RegExp(`${PREFIX.replace(/\./g, '\\.')}Icon[A-Za-z0-9]*(?:14|16)\\b`, 'g');

// host 当前导出的名字集合：替换目标必须存在，否则等于把 undefined 换成另一个 undefined
const hostSrc = readFileSync(HOST_INDEX, 'utf8');
const exportStart = hostSrc.lastIndexOf('export {');
const exported = new Set(
  hostSrc
    .slice(exportStart)
    .replace(/^export \{/, '')
    .replace(/\};?\s*$/, '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
);

function* walk(dir, depth) {
  if (depth > 4) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.bin' || entry.name === '.pnpm') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, depth + 1);
      continue;
    }
    if (!/\.(?:js|mjs|cjs)$/.test(entry.name)) continue;
    if (entry.name.includes('.bak')) continue;
    yield full;
  }
}

let filesTouched = 0;
let totalHits = 0;
const skipped = [];

for (const file of walk(ROOT, 0)) {
  let src = readFileSync(file, 'utf8');
  if (!src.includes(PREFIX)) continue;
  const hits = src.match(OLD_RE);
  if (hits === null) continue;

  const perName = new Map();
  for (const hit of hits) perName.set(hit, (perName.get(hit) ?? 0) + 1);

  let next = src;
  for (const oldToken of perName.keys()) {
    const oldName = oldToken.slice(PREFIX.length);
    const newName = `${oldName.replace(/(?:14|16)$/, '')}Regular`;
    if (!exported.has(newName)) {
      skipped.push(`${file}: ${oldName} -> ${newName}（host 未导出该名字，跳过）`);
      continue;
    }
    next = next.split(oldToken).join(PREFIX + newName);
  }

  const remaining = next.match(OLD_RE)?.length ?? 0;
  const replaced = hits.length - remaining;
  if (remaining > 0 && replaced === 0) continue;

  console.log(`${APPLY ? 'apply' : 'scan '} ${file}`);
  console.log(`  ${hits.length} hit(s): ${[...perName].map(([k, v]) => `${k.slice(PREFIX.length)}x${v}`).join(', ')}`);
  if (APPLY) {
    copyFileSync(file, `${file}.bak-pre-iconmap`);
    writeFileSync(file, next, 'utf8');
  }
  filesTouched += 1;
  totalHits += replaced;
}

console.log(`\n${APPLY ? 'applied' : 'would apply'} to ${filesTouched} file(s), ${totalHits} replacement(s)`);
if (skipped.length > 0) console.log(`skipped:\n  ${skipped.join('\n  ')}`);
if (!APPLY && filesTouched > 0) console.log('re-run with --apply to write.');
