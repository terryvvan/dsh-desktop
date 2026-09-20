# 桌面版背景图片与界面透明度 — 设计文档

日期：2026-09-18
状态：已确认，待实现

## 目标

给 DeepSeek Harness 桌面外壳增加两个能力：

1. 用户可以选择一张图片作为主窗口的背景，图片铺满整个窗口。
2. 用户可以用滑块调整界面的不透明度，让背景图从半透明的面板后面透出来。

明确不做的事：不改动 DSH 自身的任何行为，不修改 DSH 的源码或插件，不把功能做成 DSH 客户端插件。

## 背景与约束

桌面外壳是一个 Electron 窗口，里面加载的是本地 DSH Web GUI（`http://127.0.0.1:<随机端口>/?token=...`）。这带来三个必须处理的事实：

- **页面有自己的不透明背景。** 如果只是给 Electron 的 `BrowserWindow` 设背景，图片会被页面完全盖住，看不见。必须注入样式改变页面自身。
- **页面没有 CSP。** 已确认 DSH 的 webserver 和前端静态服务都不发送 `Content-Security-Policy` 头（只有 `electron/splash.html` 这个本地文件带 CSP，与主窗口无关）。因此注入样式和自定义协议图片都不会被拦截。
- **主题令牌可以被覆盖。** DSH 前端用 `--dsw-alias-*` 设计令牌表达颜色，令牌定义在 `body` 和 `body[data-ds-dark-theme]` 上，由主题插件在运行时通过 `createElement("style")` 注入，且**没有使用 `!important`**。我们用 `!important` 覆盖即可稳定胜出，不受注入先后顺序影响。

Electron 版本为 44.4.2，`protocol.handle` 与 `net.fetch` 均可用。

## 一、核心机制

### 背景图

注册一个特权自定义协议 `dshbg://`，由主进程把用户选定的图片文件流式返回给渲染进程：

```js
protocol.registerSchemesAsPrivileged([{
  scheme: 'dshbg',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);
```

之所以用自定义协议而不是把图片转成 base64 塞进样式里：桌面壁纸动辄几 MB 到十几 MB，base64 会膨胀约 33%，而且每次页面加载都要重新构造并传输一遍。`protocol.handle` 直接流式返回文件，没有体积放大，也不需要对原图重新编码，画质无损。

协议处理器**忽略请求路径，永远只返回当前配置的那一个文件**，不接受任意路径，避免变成任意文件读取通道。

注入的样式：

```css
body {
  background-image: linear-gradient(rgba(0,0,0,DIM), rgba(0,0,0,DIM)), url("dshbg://bg/current") !important;
  background-size: cover, cover !important;
  background-position: center center, center center !important;
  background-repeat: no-repeat, no-repeat !important;
  background-attachment: fixed, fixed !important;
  background-color: transparent !important;
}
```

`background-size: cover` 保证图片始终填满窗口且不变形；`background-attachment: fixed` 保证页面内容滚动时图片不动、始终铺满可视区域。两个图层叠在一起，第一层是可调的黑色蒙版——这样"压暗"就成了纯 CSS 的一层渐变，不需要额外的 DOM 元素，也不用和应用的堆叠上下文（`z-index`）打架。

### 界面透明

不动 `opacity`。对整个界面用 `opacity` 会把文字和图标一起冲淡，看起来发灰，不是想要的效果。

改为覆盖背景令牌，让面板自身变成半透明色，文字保持完全不透明：

```css
body {
  --dsw-alias-bg-base: rgba(255,255,255,ALPHA) !important;
  --dsw-alias-bg-layer-1: rgba(255,255,255,ALPHA) !important;
  --dsw-alias-bg-module-platform: rgba(255,255,255,ALPHA) !important;
}
body[data-ds-dark-theme] {
  --dsw-alias-bg-base: rgba(21,21,23,ALPHA) !important;
  --dsw-alias-bg-layer-1: rgba(21,21,23,ALPHA) !important;
  --dsw-alias-bg-module-platform: rgba(21,21,23,ALPHA) !important;
}
```

浅色与深色两套都覆盖，所以用户切换主题后背景依然正常。两条规则都带 `!important`，深色模式下 `body[data-ds-dark-theme]` 特异性更高因而胜出。

**`--dsw-alias-bg-layer-2` 和 `-layer-3` 故意不覆盖**，保持完全不透明。这两层对应弹层和模态框，让对话框变透明会严重影响可读性。

### 注入时机

在 `mainWindow.webContents` 的 `did-finish-load` 事件里注入，并保存 `insertCSS` 返回的 key。页面重载（F5）后会重新注入，无需额外处理。

调整滑块时先 `removeInsertedCSS` 移除旧规则再插入新的，实现实时预览。注入状态用 `WeakMap<WebContents, key>` 记录，避免泄漏。

## 二、设置窗口与持久化

新增文件，**不改动主窗口的安全配置**——主窗口保持 `sandbox: true` + `contextIsolation: true`，且不挂载 preload：

| 文件 | 职责 |
| --- | --- |
| `electron/background.js` | 设置读写、协议注册与处理、CSS 生成与注入、图片导入 |
| `electron/background.html` | 设置界面，沿用 `splash.html` 的视觉风格 |
| `electron/preload.js` | 仅供设置窗口使用，通过 `contextBridge` 暴露最小 API |

设置窗口通过 `contextBridge` 只暴露四个方法：`get()` / `choose()` / `update(patch)` / `clear()`。主窗口不加载 preload，因此 DSH 页面（包括第三方插件）无法触达这些接口。

设置界面包含：**选择图片…** 按钮、**界面不透明度**滑块（实时生效）、**背景压暗**滑块（实时生效）、**清除背景**按钮、关闭。

菜单入口放在「视图」下：`背景设置…` 和 `清除背景图片`。

### 持久化

用户选定的图片**复制**到 `%APPDATA%\DeepSeek Harness\backgrounds\current.<ext>`，配置写入 `%APPDATA%\DeepSeek Harness\background.json`：

```json
{ "enabled": true, "file": "current.jpg", "uiOpacity": 0.78, "dim": 0.25 }
```

复制而不是引用原路径，是因为引用原路径时用户一旦移动或删除原图，背景就会静默失效。这是必须避免的体验问题。重新选图时覆盖 `current.*` 并清理旧扩展名的残留文件。

配置文件损坏或缺失时回退到默认值（关闭背景），不阻塞启动。

## 三、边界情况

| 情况 | 行为 |
| --- | --- |
| 拷贝的图片文件丢失或损坏 | 记日志，按无背景渲染，不阻塞 |
| 用户切换浅色/深色主题 | 两套令牌都已覆盖，背景正常 |
| 页面重载（F5） | `did-finish-load` 重新注入 |
| 内核重启 | 页面重新加载，重新注入 |
| 从菜单「在默认浏览器中打开」 | **不会有背景** |
| 设置窗口重复打开 | 只聚焦已有实例，不重复创建 |
| 启动画面 | 不应用背景，保持现状 |

「在默认浏览器中打开」的页面没有背景是固有限制：那个页面是独立运行的 `dsh web`，由浏览器渲染，桌面外壳无法向它注入样式。这条会写进 README。

## 实现阶段验证结果

设计时留下两个只能靠渲染确认的问题，已用独立 Electron 进程加载真实 DSH 页面逐一验证。

### 1. 构成应用画布的令牌（已确定）

初版只覆盖了 `bg-base` + `bg-layer-1` + `bg-module-platform`。截图显示**左侧边栏和输入框在 40% 不透明度下依然接近不透明**。没有靠猜补令牌，而是让渲染进程用 `document.elementFromPoint()` 取到真实元素，再用 `element.matches()` 把元素和 `document.styleSheets` 里的规则对上，直接读出生效的令牌名：

| 区域 | 实际令牌 |
| --- | --- |
| 应用画布 | `--dsw-alias-bg-base` |
| 面板 | `--dsw-alias-bg-layer-1` |
| 平台模块（工具条等） | `--dsw-alias-bg-module-platform` |
| **左侧边栏** | `--dsw-specific-sidebar-fill` |
| **输入框卡片** | `--dsw-specific-input-major` |

最终覆盖集合即为这五个。同时对全部用于背景的令牌做了完整清点（`background` / `background-color` / `background-image` 中出现 `var(--dsw-*)` 的规则），据此明确排除：`bg-layer-2` / `-layer-3` / `specific-menu`（对话框、弹层、菜单）、`interactive-bg-*` / `button-*-fill`（悬停与按钮）、`bg-mask-*`（遮罩）、`markdown-code-block*`（代码块）。理由都写进了 `electron/background.js` 的 `SURFACE_TOKENS` 注释，避免以后有人凭直觉往里加。

### 2. `cover` + `fixed` 的表现（已验证）

用一张 1600×900 的测试图（含正圆、网格、四角标记）在 1264×735 的内容区渲染：圆保持正圆、没有变成椭圆，说明 `cover` 是裁切而非拉伸；四角标记在窗口右上下、以及透过左侧边栏都可见，说明图片铺满整个窗口。滚动与固定定位无异常。

### 3. 深色主题（已验证）

`body` 与 `body[data-ds-dark-theme]` 两条规则都带 `!important`。实测切换主题属性后，面板的计算背景为 `rgba(21, 21, 23, 0.55)`，即深色规则以当前滑块值胜出，浅色规则没有串色。

### 4. 设置窗口与 IPC（已验证）

设置窗口、`contextBridge` 桥接、滑块拖动链路均实测通过：桥接对象存在、初始状态正确往返、拖动滑块后主窗口实时变化、防抖 300ms 后落盘、重复调用 `openSettings()` 不产生第二个窗口、关闭按钮生效。

---

## v2 修订：实际使用后反馈的三个问题

日期：2026-09-18（同日，实机试用后）
状态：已实现并逐项渲染验证

使用一张深色星空地球壁纸、DSH 处于浅色主题时的实际效果被否掉了，反馈三条：红框处（侧边栏「新会话」卡片、底部「设置」上方）有瑕疵；整个窗口仍带着默认底色，透明度不理想；文字跟背景色不搭。

### 1. 侧边栏「新会话」卡片是一块不透明白色

该卡片画的是 `--dsw-alias-button-elevated-fill`（浅色主题下 `#fff`）。v1 把它按「按钮填充」排除在覆盖集合之外，但它其实是横贯侧边栏的一整块面：面板 25% 透明时，它是全屏最亮、边缘最硬的一块。现已纳入 `SURFACE_TOKENS`（`--dsw-alias-button-elevated-fill`），同时覆盖的还有会话重命名输入框——同一令牌，同样合理。

### 2. 「设置」上方的亮带是 DSH 自己画的第二层底色

`dsh-client-ui-workspace` 的会话列表底部有一条 `linear-gradient(transparent → var(--dsw-specific-sidebar-fill))`，`dsh-client-ui-conversation` 的输入框上方也有一条同样手法的 36px 渐变。面板不透明时两条都看不见；面板一旦半透明，第二层底色叠在第一层上，就成了一条 0.95 不透明度的亮带，而且右边界（`right: var(--dsh-session-list-edge-inset)`）是硬的。

修法不是调低它的透明度（那只是把亮带变淡，仍然存在），而是**换掉淡出方式**：`[class*="_fade"]` 与 `[class*="_composerSeat"]` 的渐变背景置空，改在 `.bhn1Oq_treeBody` 上用 `mask-image` 淡化内容本身；输入框座（seat）额外加 `backdrop-filter: blur(10px)`，让滚到下面的内容模糊而不是被刷白。类名选择器用 `[class*="_fade"]` 这种子串匹配，是因为哈希前缀每次构建都会变；实测整个客户端里只有三处 `_fade` 类：本条、一条 mask 渐变（`eGxaPq_fadeTop/Bottom`）、一条动画类（`BInVoG_fade-in`），后两者都不吃 `background-image`。

### 3. 浅色半透明界面压在深色壁纸上，文字必然不搭

这是根因，也是「默认底色」的观感来源：`rgba(255,255,255,α)` 铺满整个窗口，图片再深也会被抬成灰白，而深色文字又正压在这层灰白上；不透明度调到 20%（当时的下限）时图片终于透出来了，文字却因为背景花花绿绿而更难认——两个诉求互相拉扯，靠一个滑块解决不了。

**界面配色改为跟随背景图。** 用 `nativeImage` 把图片解到 32px 宽求平均亮度，偏暗就用深色界面（阈值 0.5）。实现上没有走「改 DSH 主题设置」这条路——实测用户已在 DSH 里把主题固定成 `light`，`nativeTheme.themeSource` 对页面完全无效（属性不在，`rootScheme` 仍是 light）。改为把 DSH 自己的调色板读回来重声明：

- 在页面里跑一段只读脚本，扫 `document.styleSheets`，取出 `body` 与 `body[data-ds-dark-theme]` 两条规则里的全部 `--dsw-*` 声明（实测浅色 351 条、深色 165 条，深色只覆盖有差异的部分）。
- 需要哪一套就把那一套以 `!important` 重新声明在 `body` 上，外加 `html { color-scheme }`。DSH 的 ui-layout 把令牌写成 **body 的内联样式**（`body.style.setProperty`），内联声明压不过 `!important`，所以即使 DSH 认定了浅色，界面也照样按背景图渲染。DSH 的源码、设置、状态一律没动。
- 同时仍然同步 `nativeTheme.themeSource`，让窗口边框、菜单和原生控件一致；清掉背景图后恢复 `system`，DSH 自己的主题设置重新生效。

配色选项：「跟随背景图（默认）」/ 浅色 / 深色 / 跟随 DSH 主题。最后一项不注入任何调色板，只保留 v1 的双分支表面令牌覆盖。

### 4. 顺手修的两处

- **画布单独一个滑块。** `--dsw-alias-bg-base`（整个应用画布）此前与面板同一个不透明度，于是面板要可读、画布就得一起发灰。现在画布有独立滑块，可以调到 0，背景图完整露出来，面板仍留在 60% 左右保证文字对比度。
- **窗口底色取自壁纸。** 主窗口 `backgroundColor` 由 `#1b1c1f` 改为壁纸的平均色（`win.setBackgroundColor`），首帧之前不再先闪一下深灰。

### 5. 换第二张图不生效（v2 实测后补修）

实机反馈：「第一次选背景图片生效，再选其他图片就不生效，生效的还是第一个。」

原因不在选图链路，而在图片 URL。`dshbg://bg/current` 这个 URL 从头到尾没变过，协议响应是按 URL 缓存的，于是浏览器一直用第一次取到的那张位图回答后续所有请求。`chooseImage()` 其实做对了每一件事——文件拷过去了、设置写了、样式也重注入了（日志里一串 `image set to …`）——只有屏幕上的图没换。更糟的是配色会跟着换：亮图的摘要一算，界面翻成浅色，底下却还是那张深色壁纸，于是又回到「文字跟背景不搭」。

修法：URL 上带一段图片内容的短摘要（`?v=<sha1 前 12 位>`），换图即换 URL，缓存自然失效；内容不变则摘要不变，缓存照旧复用。摘要取自字节而不是 `mtime + size`，是因为换图是把新文件拷到同名路径上，而 Windows 的 `CopyFileW` 会保留源文件的时间戳，光凭这两项认不出两张图；分析缓存也在选图后显式清空，理由相同。

复现与验证用一个临时脚本驱动（把新图拷到配置的文件上，再调 `manager.refresh()`，正是 `chooseImage()` 对文件做的那一步）：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 第一次（地球，深色） | `url: dshbg://bg/current`，`label #f9fafb` | `?v=c65acdef25de`，`label #f9fafb` |
| 换成亮色渐变图 | `url: dshbg://bg/current`（**没变**），截图上仍是地球，界面却已翻成浅色 | `?v=a351282bf7a5`，截图是亮色渐变图，界面浅色 |
| 再换回地球 | — | `?v=c65acdef25de`，截图回到地球，界面深色 |

顺带一句：这个 bug 与主题设置无关，用户当前磁盘上的 `current.jpg` 本身没问题，更新后重启即可正常显示，不必重新选图。

### 验证方式

新增 `scripts/preview-background.cjs`：用仓库自带的 Electron 加载真实 DSH 页面（默认自起一个隔离的 `dsh web`，也可以 `PREVIEW_URL` 指向正在运行的实例），套用生产环境的 `electron/background.js`，`capturePage()` 落成 PNG，并打印 `pageDark` / `label` / `imageUrl` / 各表面令牌的计算值 / `_fade`、`_composerSeat` 的 `background-image` 作为断言。本轮据此逐项确认：

| 检查项 | 结果 |
| --- | --- |
| 深色壁纸 + `palette: auto` | `nativeTheme: source=dark`，页面停在浅色属性、但 `--dsw-alias-label-primary` = `#f9fafb`，界面按深色渲染 |
| 浅色壁纸 + `palette: auto` | `source=light`，`label` = `#0f1115` |
| 「新会话」卡片 | `--dsw-alias-button-elevated-fill` = `color-mix(in srgb, #43454a 55%, transparent)` |
| 两处亮带 | `_fade` 与 `_composerSeat` 的 `background-image` 均为 `none` |
| 会话页（点击侧边栏会话行后截图） | 工具行、思考行、输入框、底部状态栏均清晰，输入框上方无亮带 |
| `palette: theme` | 回到 v1 行为（跟随页面主题），但同时修好了卡片与亮带 |
| 设置窗口（`PREVIEW_WINDOW=settings`） | `clipped: false`，加了第三个滑块和配色下拉后窗口由 660 调到 706，页脚不再被裁掉 |

对照图见 `docs/images/background/`：`before.jpg`（v1，浅色主题 + 25% 面板）、`after-dark-low.jpg`、`after-dark-default.jpg`（默认参数）、`after-conversation.jpg`、`settings.jpg`（v2 设置窗口）。


