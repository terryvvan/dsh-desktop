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

---

## v3 修订：背景支持动图与视频

日期：2026-09-20
状态：已实现；动图沿用 v1 路径，视频链路已逐项渲染验证（见下）

需求是「让背景图片支持视频或动图」。两件事的性质完全不同，处理方式也不同。

### 1. 动图不需要新代码，只需要写进说法里

GIF、动态 WebP、动态 AVIF、APNG 都由浏览器自己在 `background-image` 里播放。v1 的扩展名列表里本来就有 `gif`，所以这类文件一直能用，只是文档和界面从没提过，用户不会想到可以选。v3 把 `apng` 补进列表，并在设置窗口和 README 里说明。

### 2. 视频必须换一种画法

CSS 没有播放视频的能力，`background-image` 做不到，所以视频需要一个 `<video>` 元素。这带来一个**连带的必要改动**：v1 把背景画在 `body` 上，而 `body` 的背景画在画布层，任何 `z-index: -1` 的元素都在它**上面**——也就是说，一旦引入元素，压暗的黑色蒙版就会盖在元素下面、跑到画面背后去。

所以两种模式统一到一个固定在窗口底层的元素 `#dshbg-video` 上：

```css
#dshbg-video {
  position: fixed; inset: 0; z-index: -1; overflow: hidden;
  background-image: linear-gradient(rgba(0,0,0,DIM), rgba(0,0,0,DIM)), url("dshbg://bg/current?v=…");
  background-size: cover; background-position: center; background-attachment: fixed;
}
#dshbg-video > video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
```

- 图片与动图：图直接画在这一层上（它自己的背景），行为与 v1 等价——`body` 不再画任何东西。
- 视频：这一层只留蒙版，画面由子元素 `<video>` 提供。
- 两种模式下蒙版都在画面之上、应用之下。这一条在验证时确认过（见下表）。

### 3. 视频的其余决定

- **静音、循环、`playsinline` 必须在 `play()` 之前设好**：浏览器拒绝在未静音元素上自动播放，而 `muted` 在调用之后才设已经太晚。
- **协议要支持字节范围。** `<video>` 靠范围请求探测容器并定位，永远回 200 加整个文件会让它每次请求都从头下载——循环播放时等于一直在重下。协议处理器现在解析 `Range`，回 `206` + `Content-Range` + `Accept-Ranges`，并给响应加上 `immutable` 缓存头（URL 里带内容摘要，同一个 URL 的内容永不改变）。
- **换文件的判定不能只看 `video.src`。** `HTMLMediaElement.src` 会被页面解析成绝对 URL，比较它认不出两个版本；摘要同时写在元素的 `data-rev` 上，那个值永远是外壳写进去的东西。
- **拖动滑块不重建播放器。** 样式表每次都整体替换，元素则只在需要时创建，所以调不透明度、压暗、配色都不会让视频从头开始。为此不需要另设一条 `playback` 通道——把 `playback` 与 `speed` 一起放进同一次设置更新即可。
- **视频无法自动测光。** `nativeImage` 只解静态图，所以视频固定按深色处理，并在设置窗口的配色提示里写明。这顺带修掉一个真 bug：阈值判断原是 `luminance < 0.5`，而视频的占位亮度正好是 `0.5`，于是落到了「浅色」——半透明白色压在未知动态画面上正是最难认的一种。改成 `<=`。
- **窗口不可见时暂停**是可选开关。Chromium 会在页面转为不可见时自行暂停后台视频，恢复时不会接着播，所以外壳在窗口 `restore` / `focus` 时重新确认播放状态；反过来，如果用户没开这个开关，就由外壳显式恢复。
- **设置窗口固定尺寸，卡片区滚动。** 视频卡片只在选了视频时出现，所以最初的做法是量内容高度再把窗口贴合上去。这是一条彻底的弯路，连着两个 bug：

  1. **高度不能用 `scrollHeight` 量。** 元素的 `scrollHeight` 永远不小于它自己的盒子，而 `body` 和窗口一样高，于是 `document.body.scrollHeight` 返回的是**窗口**（还要再加上 body 的 padding）。把它当内容高度喂回去就是正反馈——而重新贴合在每次设置变化时都会跑，所以拖动一次透明度滑块会让窗口一路长高往屏幕下爬（实测每次 +18px）。
  2. 改用「自然高度」（各子元素叠加 + 间距 + padding）后高度稳定了，但**窗口宽度仍会参与**：贴合时读回当前宽度再写回，而这个读回值并不总是等于写回去的那个值，于是窗口宽度会漂（1.5 倍缩放下实测内容在 908/890 之间重排）。

  更根本的是**这条路在用户的机器上根本走不通**：显示器是 1707×1067、缩放 150%，工作区只有约 711 个逻辑像素高，比卡片实际需要的（约 830）还少。也就是说无论怎么量，窗口都不可能既装下全部卡片、又留在屏幕内——旧实现只按工作区高度夹紧，从未考虑窗口自身的 y 坐标，所以它总是往屏幕下缘跑。

  **结论是这类窗口不该有自己的尺寸状态。** 现在：窗口尺寸在创建时定死（内容 640），**卡片区（`main`）自己滚动**，页脚放在滚动区之外因而始终可见。不读回、不写回、不重排，也就没有可漂的东西；小屏上滚动条承担高度不足，页脚按钮始终够得着。`fitSettingsWindow`、`dshbg:resize`、`preload.resize()` 这一整条链路连同 `screen` 依赖都已删除，窗口改为居中打开。

  回归验证用 `PREVIEW_RESIZE_REPEAT`（新增）：连做 10 次设置更新、再拖动窗口、再做 10 次，把每一步的窗口尺寸打出来，必须一模一样。现在两种状态都是 `width=456`、`height=606` 全程不变，且 `footerVisible: true`。实测窗口移动后 Windows 会把非客户区边框重新算一次（内容视口偶尔在 606/608 之间），这是窗口框架自身的行为。

### 验证方式与结果

预览脚本扩了这些能力：`PREVIEW_FRAMES` / `PREVIEW_FRAME_GAP` 连拍多帧并逐字节比对（判断背景是否真的在动）、`PREVIEW_VIDEO` 把一个真实视频文件按选图的方式装进设置目录、`PREVIEW_RESIZE_REPEAT` 连做设置更新与拖动以验证窗口尺寸不漂、`PREVIEW_DRAG_BY` 用真实鼠标拖标题栏、`PREVIEW_LOG` 把每行同时写进文件（`app.exit()` 不刷新 stdout，最后几行本来会丢）。

| 检查项 | 结果 |
| --- | --- |
| 图片背景（回归） | 截图与 v1 基线**逐字节相同**（`digest=e404bef3c538`）；`_fade`、`_composerSeat` 仍为 `none`；配色仍为深色 |
| 底层元素 | `#dshbg-video` 存在，`position: fixed`、`z-index: -1`，`background-image` = 蒙版 + `url("dshbg://bg/current?v=4f5b1f81c2a3")`；`body` 背景为 `none` |
| 视频背景（真实文件） | `<video>` 的 `src` = `dshbg://bg/current`、`data-rev` = 内容摘要、`loop`/`muted`/`playbackRate` 与设置一致、`object-fit: cover`；**`paused: false`、`readyState: 4`、`width: 2560`、`height: 1440`、`duration: 5`、`currentTime` 持续推进、`error: null`**——真实解码、播放、循环均确认 |
| 协议范围请求 | 处理器收到 `range=bytes=0-` 并按 `206` 切片作答（日志确认） |
| 设置窗口尺寸 | 固定 `456×606`；10 次设置更新 + 真实鼠标拖动 + 再 10 次更新后 `widthStable=yes heightStable=yes`（真实视频配置下同样成立） |
| 设置窗口滚动 | 卡片区 `scrollable: true`（`scrollHeight 833` / `clientHeight 539`），页脚 `footerVisible: true` |
| 连拍比对 | 图片背景 `changed = 0.00 B/px`（静止，符合预期） |

### 关于视频素材

一开始想在仓库里造一个测试视频，三条路都不通：手写 VP8 关键帧（容器结构正确，Chromium 仍以 `MEDIA_ERR_SRC_NOT_SUPPORTED` 拒绝——码流不是能靠常量拼出来的）、MediaRecorder（隐藏窗口不驱动合成器，`captureStream` 不出帧，脚本卡死）、Windows Media Foundation 的 H.264 编码器（`AddStream` 返回 `MF_E_INVALIDMEDIATYPE`，没找到合适的输出类型）；AVI 容器也确认不在 Electron 自带 ffmpeg 的支持列表内。这些尝试已全部删除，仓库不再带任何合成的「测试视频」。

改法是让预览直接用**用户自己的文件**：`PREVIEW_VIDEO=<某个 mp4/webm>` 会把它按选图的方式装进设置目录再跑完整链路；不指定时预览默认读真实的用户数据目录，所以它会直接反映当前配置——上面那行视频结论就是这么来的。播不动时页面会给出 `<video>` 的 `error` 与 `readyState`。

---

## v4 修订：菜单栏也铺上背景

日期：2026-09-20
状态：已实现并渲染验证

需求是「背景能不能铺到菜单栏」。

### 先分清两件事

- **标题栏**（`DeepSeek Harness` + 最小化/关闭按钮）是 Windows 窗口框架画的非客户区，页面背景**没有**任何办法铺过去。唯一的做法是无边框窗口（`frame: false`）加自制窗口按钮，会丢掉系统原生窗口行为（贴边、双击最大化、Aero Snap、系统菜单）。这一条在 README 里写明为固有限制。
- **菜单栏**（`Menu.setApplicationMenu` 设的四项）在 Windows 上同样是原生控件，用 Windows 的窗口样式绘制，Electron 没有让它背景透明的 API——`setBackgroundColor('#00000000')` 对非客户区无效，实测设了也没用。

所以只有三条路：保持原生（背景铺不过去）、自动隐藏（平时不占位，但菜单要按 Alt 才出来）、**在页面里重做一条**。最后选了第三条。

### 做法：一份定义，两条菜单

原来的菜单是在 `main.js` 里直接写 Electron template。现在改成先构造**纯数据**（`electron/desktop-menu.js` 的 `buildMenuData`），再由它生成两边：

- `toTemplate` 把数据转成 Electron template，交给 `Menu.setApplicationMenu`；
- `drawFunction` 把同一份数据渲染成页面里的 HTML 菜单栏。

加一个菜单项因此只需要改一处，不会出现「原生菜单有、页面菜单没有」。`role` 项（撤销/复制/粘贴/缩放/全屏/退出）仍然交给 Electron，原生菜单保留它们的实现与快捷键。

**原生菜单栏是隐藏而不是移除**：`win.setMenuBarVisibility(false)`。应用菜单仍然存在，因此 F5、F12、Ctrl+C、Alt+F4 这些快捷键一个都不丢——这是隐藏方案能成立的关键。`视图 → 使用系统菜单栏` 把原生条换回来、把页面条摘掉，选择记在 `%APPDATA%\DeepSeek Harness\menu-state.json`。

### 页面菜单栏的几个实现要点

- **挂在 `<html>`，不是 `<body>`。** 第一版挂在 body 上，结果菜单栏在预览里时有时无：body 的子节点归 DSH 自己的框架所有，它 reconcile 时会把外来节点清掉。`<html>` 只有页面自己会动。
- **应用整体下移 28px**（`body { padding-top: 28px !important }`），所以这条栏是真正的顶栏，而不是压住应用自己头部的浮层。
- **半透明靠真正的 alpha，不靠 `backdrop-filter`。** 给这条栏加 `backdrop-filter: blur()` 反而让它变成一条纯黑横条——根级 fixed 元素上的 filter 是与文档而不是与身后的画面合成；同一份样式的下拉面板（嵌套元素，合成路径不同）却能正常透出壁纸。改成 `rgba(26,27,31,0.30)` 这样的真半透明色调后就对了。
- **点击怎么回到主进程。** 主窗口的设计是**不挂载 preload、不暴露 IPC**，这个约束不为菜单破例。注入的菜单只往自己的控制台写一行 `dshbg-menu: run <id>`，主进程监听这个前缀。这是单向纯文本通道，只能点名菜单定义里已有的 id——比开一条 IPC 桥小得多：插件本来就能 `console.log`，而它能做到的最坏情况只是触发一个用户本来就能点的菜单项。

### 验证方式与结果

预览脚本新增 `PREVIEW_MENU`（`page` / `native`）与 `PREVIEW_MENU_CLICK`，用一份替身定义把菜单栏装进真实 DSH 页面：

| 检查项 | 结果 |
| --- | --- |
| 菜单栏存在与布局 | `barPresent: true`、`barHeight: 28`、`position: fixed`、`bodyPaddingTop: 28px`（应用下移，不被遮住） |
| 透明度 | 栏的计算背景 = `rgba(26, 27, 31, 0.3)`；**同一份页面在深色壁纸上栏偏暗、在浅色壁纸上栏偏亮**（两次渲染裁剪对比），证明确实透出画面而不是画自己的底色 |
| 下拉面板 | 展开后 `top: 28`、宽 261，首项为禁用信息行、可点项 `enabled: true` |
| 点击回传 | 点「背景设置…」→ 主进程收到 `["background-settings"]` |
| 换回原生 | `PREVIEW_MENU=native` → `barPresent: false`、`bodyPaddingTop: 0px` |

顺带修掉一个只有渲染才看得见的坑：注入脚本一开始总是失败，而 `executeJavaScript` 只回一句「Script failed to execute」，原因被丢在没人看的渲染进程控制台里。根因是注入字符串里有一处 `${BAR_HEIGHT}` 没转义——内层模板字面量在页面作用域里去找同名变量，于是 `BAR_HEIGHT is not defined`。修法是把注入脚本写成函数表达式，由调用方套一层 try/catch 把异常当返回值带回来，这类错误以后会直接出现在日志里。

### 实机反馈：菜单不见了，顶上多出一截空白

第一次打包后的反馈是「我菜单呢？」外加「背景上面空出来一截」。两者是同一个原因。

预览里一切正常（`barPresent: true`、`topmostAtBar: DIV.top`），差别在**时机**：`dom-ready` / `did-finish-load` 触发时应用还在启动，DSH 启动完成后重建自己的根节点，把外来节点一起带走。菜单栏是 `<html>` 的**子元素**，于是被删掉；而「下移 28px」是写在 `<head>` 里一条 `<style>`，它活了下来——所以最后看到的是**一条 28px 的空白和它上面的壁纸**，菜单栏本体已经不在 DOM 里了。

修法是不再假设「画一次就够了」：

- 安装时在 500 / 1500 / 3000 / 6000ms 各补画一次，覆盖启动结束后那段 DOM 还在动的窗口；
- 画成功之后在页面里装一个 `MutationObserver`（监听 `documentElement` 的 `childList`，`subtree` 也开），一旦发现菜单栏不在而样式还在，就通过既有的控制台通道请求主进程重画——重画必须由主进程做，因为只有它手里有菜单定义；
- 切回原生菜单时把观察者的钩子一并撤掉（`delete window.__dshbgMenuRedraw` 并清掉样式），否则它会立刻把菜单栏又画回来。

`PREVIEW_MENU=page` 里加了一条针对性的用例：**把菜单栏从 DOM 里删掉，等 900ms，要求它自己回来**。

| 检查项 | 结果 |
| --- | --- |
| 被删除后自愈 | `wipe=wiped` → `restore={"restored":true,"height":28,"padding":"28px"}` |
| 自愈后仍可用 | 自愈之后再点「背景设置…」→ 主进程收到 `["background-settings"]` |

教训记在这里：**在别人的页面里注入东西，「插进去」不等于「留在那里」**。凡是跨越应用启动期的注入，都要么等到应用稳定之后再插，要么能自己发现被删并补回来。

### 第二次实机反馈：菜单还是没有，而且主界面多了滚动条

反馈两条：「菜单依旧未生效」、「主界面出现了滚动条，导致设置按钮被裁」。

**菜单没生效的原因不在注入，而在接线。** 应用日志里写得很清楚（这正是上一轮加日志的价值）：

```
menu: bar injection said error: MENUS is not iterable
```

`main.js` 里传给 `createDesktopMenu` 的 `getMenu` 写成了 `() => ({ ...menuContext(), pageMenu })`——`menuContext()` 是 `buildMenuData` 的**输入**而不是输出，于是 `menu.data` 是 `undefined`，注入脚本自然无法遍历。

**为什么预览没抓到？** 因为预览当时用的是一份**替身菜单定义**，直接构造 `{ data, commands }` 传进去，把 `getMenu` 这一环整个绕过去了。替身让「画得出来」和「接线正确」这两件事分开了，而后者才是实机上唯一会错的地方。修法有两步：

1. 预览改为用**壳自己的定义**——`buildMenuData(previewMenuContext())`，并按 `showMainWindow` 的方式接线（连原生模板也一并生成，模板不合法会在启动时直接崩）；
2. `refresh()` 改成 `async` 并把注入结果**返回**出来，测试可以直接断言 `'ok'`，而不是只从日志里捞。

顺带查出一个更底层的 bug：注入脚本里的 CSS 注释用到了反引号，而整段脚本本身就活在一个模板字面量里——**一个反引号就把模板提前闭合了**，于是整段注入代码语法错误。这类错误在页面里只表现为「Script failed to execute」，症状看起来和上面那个接线错误一模一样。两个都修了：注释里不许出现反引号（并在注释里写明原因），同时保留 `scripts/dump-menu-script.cjs` 那种「把注入脚本落盘再用 `vm.Script` 解析」的排查手段。

**滚动条是「下移 28px」带来的副作用。** 页面是 `height: 100%`，给 `body` 加 `padding-top` 是在盒外再加 28px，于是整页比窗口高；而 `html` 上有 `overflow: hidden`，浏览器无法滚动 html，就把滚动容器挪到了 `body` 上——结果主界面自己滚起来，底部那排（设置按钮）被推到看不见的地方。修法是 `box-sizing: border-box`，让这 28px 从盒内让出来，页面仍然恰好一个窗口高。代价是应用可用高度少了 28px（这是「菜单栏占一条」的必然结果，不是 bug）。

预览的菜单探针因此也补了这两项断言：

| 检查项 | 结果 |
| --- | --- |
| 用真实定义渲染 | `topLabels = ["文件","编辑","视图","帮助"]`（四个菜单全部出现） |
| 不产生滚动条 | `bodyScrolls: false`、`htmlScrolls: false`、`bodyClient == windowInner == 794` |
| 底部不被裁 | `bottomMost: { bottom: 794, insideViewport: true }` |
| 盒模型 | `bodyBoxSizing: "border-box"` |

---

## v5 修订：关闭设置弹窗后应用掉到别的软件后面

日期：2026-09-20
状态：已修（模态子窗口 + 显式交还前台）

反馈是「关闭背景弹窗的时候会直接隐藏主界面」。先在预览里按各种路径复现都复现不出来：主窗口从不隐藏、也不最小化（42 次采样 `hidden: 0`），连最大化状态都试过。直到**直接监视用户正在运行的那个应用**，才看清真实情况——不是隐藏，是**前台丢了**：

```
line 555  other:DeepSeek Harness      ← 设置弹窗在前台
line 561  other:背景设置              ← 用户点了关闭
line 571  other:DeepSeek Harness      ← 应用整体失去前台（主窗口仍 visible、未最小化）
line 580  APP-FOREGROUND              ← 约 5 秒后才回到前台
```

也就是说：点关闭后，前台被交给了「之前在最前面的那个窗口」（这里是 Chrome），于是整套界面看起来像被最小化、跳到了别的软件。主窗口从头到尾都 visible、也没 minimized——**「看起来不见了」和「真的被隐藏」是两回事**，`isVisible()` 看不到这个现象，`GetForegroundWindow` 才能。

### 原因

设置窗口当时是一个普通子窗口（`parent: main`）。子窗口关闭时，前台交还给谁由系统按 Z 序决定：**Windows 不会把激活交给一个当前不在前台的进程**，所以外壳只能等——实测那 5 秒就是这么来的。

### 修法

1. **改成模态子窗口**（`modal: true`）。设置对话框本来就该是模态的，而且模态时由系统负责把前台还给所有者窗口，不再靠运气。
2. 关闭回调里补一次显式的交还：`mainWindow.moveTop()` + `focus()`（跳过已最小化的情况）。模态已经把这件事做对了，这一步是兜底——复现不了的问题，宁可多留一手。

### 验证

预览新增 `PREVIEW_CLOSE_SETTINGS` 场景：加载真实页面 → 显示主窗口（可选最大化）→ 打开设置 → 切换一次背景（用户的复现前提）→ 关闭 → 全程用 `GetForegroundWindow` 采样，只有状态变化才记录。

| 检查项 | 结果 |
| --- | --- |
| 前台归属 | `f=1 → f=0 → f=1`，且首尾 `fg` 是同一个窗口句柄（回到主窗口） |
| 主窗口状态 | 结束仍 `visible=true minimized=false maximized=true`，前台已回 |
| 窗口数量 | 2 → 1（设置窗口正常销毁） |

教训：**「窗口看起来不见了」要先分清楚是隐藏、最小化、还是丢前台**。前两个 `isVisible()` / `isMinimized()` 能测，第三个必须问操作系统要 `GetForegroundWindow`；在合成环境里复现不出来时，直接监视用户那台机器上的真实进程比继续加测试用例更快。


