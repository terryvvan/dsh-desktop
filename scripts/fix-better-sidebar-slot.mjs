// 一次性修复：dsh-better-sidebar 往 host 的 turn-tail 槽位注册面板时漏了 options.id。
// host 侧 `conversation.chat.turnTail` 是 kind: "list" 槽位（dsh-client-ui-chat/lib/client.js:6652-6655），
// 而 dsh-client-ui-slots/lib/index.js:182 对 list 槽位强制要求 options.id，
// 于是注册必抛 `list slot "conversation.chat.turnTail" requires options.id`
// → better-sidebar 的「本回合产出文件」面板永远注册不上，控制台/页面报 interception error。
// host 自己的同槽位插件都传了 id（deliverables: "@deepseek-ai/dsh-client-ui-deliverables"，
// plan: previewId），这里按同样约定补 `id: "dsh-better-sidebar"`。
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const files = [
  'C:\\Users\\LEGION\\.dsh\\profiles\\web\\node_modules\\dsh-better-sidebar\\lib\\client.js',
  'C:\\Users\\LEGION\\.dsh\\profiles\\web\\node_modules\\dsh-better-sidebar\\lib\\client-registry.js',
];
const anchor = 'name: "conversation.chat.turnTail",';
const inserted = '\n\t\t\t\tid: "dsh-better-sidebar",';

for (const file of files) {
  const before = readFileSync(file, 'utf8');
  if (before.includes(anchor + inserted)) {
    console.log(`${file}: already patched`);
    continue;
  }
  const hits = before.split(anchor).length - 1;
  if (hits !== 1) {
    console.log(`${file}: anchor occurrences = ${hits} (expected 1) — skipped`);
    continue;
  }
  const at = before.indexOf(anchor) + anchor.length;
  copyFileSync(file, `${file}.bak-pre-slotid`);
  const after = before.slice(0, at) + inserted + before.slice(at);
  writeFileSync(file, after, 'utf8');
  console.log(`${file}: patched (backup .bak-pre-slotid)`);
}
