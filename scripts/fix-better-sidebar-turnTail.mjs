// 第二步修复：把 dsh-better-sidebar 的 turn-tail 「产出文件」行真正接到 host 的 list 槽位 API 上。
//
// 背景（已核实）：
//  - host ui-chat 把 `conversation.chat.turnTail` 声明成 kind: "list", scope: "session"
//    （dsh-client-ui-chat/lib/client.js:6652-6655）。
//  - list 槽位不调用 options.select，而是把 renderSlot 的 owner 直接当 props 传给组件
//    （dsh-client-ui-renderer/lib/client.js:1178-1196 list 分支；renderEntry 里 `...ownerProps` 最后展开，
//     见 :763-777）。owner 就是 { turn, seq, openFile }（ui-chat:6377-6381）。
//  - 所以 better-sidebar 的 `select` 被忽略，组件收到的 props 里没有 `matched`，
//    直接渲染会在 `matched.slice(0, 6)` 上崩。原来它是给 chain 槽位写的。
// 修法：加一层适配组件，用同一份 owner 自己算 matched（复用原生 selectProducedFiles），空则渲染 null。
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const files = [
  'C:\\Users\\LEGION\\.dsh\\profiles\\web\\node_modules\\dsh-better-sidebar\\lib\\client.js',
  'C:\\Users\\LEGION\\.dsh\\profiles\\web\\node_modules\\dsh-better-sidebar\\lib\\client-registry.js',
];

const anchorComment = '\t\t/**\n\t\t* Register the turn-tail interception (returns the disposer).';
const wrapper = [
  '\t\t/**',
  '\t\t* List-slot adapter for the turn-tail produced-files row.',
  '\t\t*',
  '\t\t* The host declares `conversation.chat.turnTail` as kind: "list" (0.1.7-alpha.2), so this',
  '\t\t* entry receives the turn-tail owner currency as props ({turn, seq, openFile}) instead of',
  '\t\t* a chain `select` result — `matched` never arrives. Derive it here from the same owner and',
  '\t\t* decline (render nothing) when the closing turn produced no file.',
  '\t\t*/',
  '\t\tfunction SidebarProducedFilesEntry(props) {',
  '\t\t\tconst matched = Array.isArray(props.matched) ? props.matched : selectProducedFiles(props);',
  '\t\t\tif (matched === null || matched.length === 0) return null;',
  '\t\t\treturn SidebarProducedFiles({ ...props, matched });',
  '\t\t}',
  '',
].join('\n');
const oldTail = '}, SidebarProducedFiles));';
const newTail = '}, SidebarProducedFilesEntry));';

for (const file of files) {
  let src = readFileSync(file, 'utf8');
  let changed = false;

  if (!src.includes('function SidebarProducedFilesEntry(props)')) {
    const hits = src.split(anchorComment).length - 1;
    if (hits !== 1) {
      console.log(`${file}: comment anchor occurrences = ${hits} (expected 1) — skipped`);
      continue;
    }
    copyFileSync(file, `${file}.bak-pre-turnTail`);
    src = src.replace(anchorComment, wrapper + anchorComment);
    changed = true;
  }

  const tails = src.split(oldTail).length - 1;
  if (tails === 1) {
    src = src.replace(oldTail, newTail);
    changed = true;
  } else if (!src.includes(newTail)) {
    console.log(`${file}: registration tail occurrences = ${tails} (expected 1) — skipped`);
    continue;
  }

  if (changed) {
    writeFileSync(file, src, 'utf8');
    console.log(`${file}: patched`);
  } else {
    console.log(`${file}: already patched`);
  }
}
