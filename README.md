# DeepSeek Harness — Windows 桌面版

把 DeepSeek Harness（DSH）的 Web GUI 装进一个原生 Windows 窗口，做成可以双击运行、
换台机器也能跑的桌面应用。

- **产物**：`DeepSeekHarness-Setup-0.1.5.exe`（NSIS 安装包）+ `DeepSeekHarness-0.1.5-x64.zip`（免安装绿色版）
- **自包含**：安装包内自带 `node.exe` 和完整的 `@deepseek-ai/dsh` 运行时，目标机器不需要装 Node.js 或 DSH
- **不重写 DSH**：桌面外壳不实现任何 DSH 行为，只是拉起官方运行时并显示它

---

## 它是怎么工作的

```
DeepSeekHarness.exe  (Electron 外壳)
        │
        │  spawn: resources/runtime/node/node.exe
        │         resources/runtime/app/node_modules/@deepseek-ai/dsh/lib/bin.js
        │         web --port 0 --no-open
        ▼
   DSH Web 内核 (纯 Node 子进程, 独立端口)
        │
        │  stdout: dsh web: http://127.0.0.1:<port>/?token=<token>
        ▼
   BrowserWindow  ──loadURL(带上 token 的地址)──►  DSH Web GUI
```

三个关键设计决定：

**1. 内核跑在自带的 `node.exe` 上，而不是 Electron 的 node。**
Electron 内嵌的 Node 与标准 Node 的 ABI 不同，而 DSH 依赖 `node-pty`（终端）、
`sharp`（图片附件）等原生模块。用 Electron 的 node 去加载这些预编译二进制会直接失败。
自带一个 80 MB 的 `node.exe` 换来的是「打包出来的东西和 `npx dsh web` 行为完全一致」，
并且顺手满足了「目标机器可以不装 Node」这个要求。

**2. `--port 0` + 解析 stdout，而不是写死 3080。**
`dsh web --port 0` 让操作系统分配空闲端口。外壳从内核 stdout 抓
`dsh web: http://127.0.0.1:<port>/?token=...` 这一行拿到实际地址，
所以桌面版**永远不会**和你已经在终端里跑着的 `dsh web`（3080）撞端口。
那个 token 是必要的：DSH 的 `/` 只接受带启动 token 的请求，用它换 cookie 后重定向到干净的 `/`。

**3. 共享 `~/.dsh`。**
桌面版默认使用和 CLI 完全相同的 DSH home，所以你已有的会话历史、skills、
模型凭据和插件配置都会直接出现在桌面版里，不是一套全新的空环境。
想隔离的话，设置环境变量 `DSH_DESKTOP_HOME` 指向别的目录即可。

---

## 目录结构

```
desktop/
  package.json              electron-builder 配置（在 "build" 字段里）
  electron/
    main.js                 主进程：拉起内核、解析地址、窗口与菜单生命周期
    updater.js              版本检测、运行时安装、原子切换、失败回滚
    profile-guard.js        配置快照、失败归因、回退上次可用配置、安全模式
    background.js           背景（图片/动图/视频）与界面透明度：dshbg:// 协议、播放器与样式注入、设置持久化
    desktop-menu.js         应用菜单：一份定义同时生成原生菜单与页面内菜单栏，以及它们的点击回传
    check-menu.cjs          校验菜单定义与原生模板能对得上（放在 electron/ 里，所以打包后也能跑）
    background.html/-ui.js  背景设置窗口及其渲染逻辑
    preload.js              仅供背景设置窗口使用的 contextBridge 桥接
    splash.html             内核引导期间的启动画面
    logo.svg                DSH 官方鲸鱼标识（由 prepare:runtime 从运行时里拷出来）
  docs/plans/               设计文档
  scripts/
    prepare-runtime.ps1     生成 runtime/（自带 node.exe + npm + 生产版 DSH）
    fetch-electron.mjs      下载并解包 Electron 二进制
    make-icon.mjs           用官方标识渲染 build/icon.png 和 build/icon.ico
    test-updater.mjs        不开 Electron 直接验证整条更新链路
    preview-background.cjs  用真实 DSH 页面渲染背景/透明度效果图，核对观感；多帧模式可判断背景是否真的在动
    test-profile-guard.mjs  配置回退：离线用例 + 真内核失败归因
  runtime/                  ← 生成物，随安装包分发（约 315 MB）
    node/node.exe
    node/node_modules/npm/  内置 npm，供应用内更新器调用
    app/node_modules/       520 个包，@deepseek-ai/dsh@0.1.5-rc.2 的生产依赖树
  dist/                     ← 构建输出
```

---

## 构建

```powershell
cd desktop

npm install --ignore-scripts   # 只装 electron / electron-builder 这两个 devDependency
node scripts/fetch-electron.mjs
npm run prepare:runtime        # 需要本机能跑 node（会把 node.exe 一起拷进去）
npm run make:icon
npm run dist                   # 产出安装包 + 绿色版
```

打包前建议先跑一次 `npm run test:updater`，它会用真实的运行时和一次性用户目录
把整条更新链路（探测 → 下载 → 安装 → 启动 → 回滚）走一遍，不需要开 Electron。
判断 master 当前是否可用，用 `npm run test:updater:check` 只探测通道即可，不下载。
`npm run test:profile-guard` 会用一次性 DSH_HOME 验证配置快照与回退，并且真的拉起内核，
用「装了一个会抛异常的插件」和「bundles 里写了个没装的包」两种坏配置去校验失败归因。

`npm run dist` 也可以拆成 `npm run dist:nsis`（只要安装包）或
`npm run dist:green`（只要绿色版 zip）。

> `make-icon.mjs` 除了 1024×1024 的 PNG，还自己写了 `build/icon.ico`
> （16/24/32/48/64/128/256 七个尺寸，PNG 载荷）。这不是多此一举：
> electron-builder 自带的 PNG→ICO 转换器是 WebAssembly 实现的，在这台机器上会以
> `WebAssembly.Memory(): could not allocate memory` 直接失败。
> 提供一个现成的 `.ico` 就完全绕开了它，顺带拿到比单尺寸转换更好的缩放质量。

### 构建产物

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `dist/DeepSeekHarness-Setup-0.1.5.exe` | 182.3 MB | NSIS 安装包，按用户安装、无需管理员权限 |
| `dist/DeepSeekHarness-0.1.5-x64.zip` | 246.0 MB | 绿色版压缩包，解压即用 |
| `dist/win-unpacked/` | 683.2 MB | 绿色版解压后的目录 |

运行时构成：`node.exe` 81.6 MB + 内置 npm 11.7 MB + DSH 依赖树 222.2 MB。

构建过程中 `../.npm-cache/` 会攒下约 350 MB 的 npm 缓存和 Electron 压缩包（`fetch-electron.mjs`
会复用它，所以重跑构建很快）。纯粹是脚手架，删掉不影响任何产物，只是下次要重新下。

### 两个 `--ignore-scripts` 是故意的

`@deepseek-ai/dsh` 的原生依赖（`node-pty`、`sharp`、`ripgrep`、`koffi`）都把预编译
二进制直接放在 npm tarball 里，不需要编译，也不需要任何 postinstall 步骤。
跳过生命周期脚本反而让安装过程不依赖构建工具链，在受限的 shell 里也能完成。
`prepare-runtime.ps1` 装完之后会逐项校验这些二进制确实存在，缺一个就直接报错，
不会产出一个启动即崩的包。

---

## 运行时行为

| 场景 | 表现 |
| --- | --- |
| 首次启动 | 内核要引导整棵插件树，可能等几十秒，期间显示带进度条的启动画面 |
| 单实例 | 第二次双击只会把已有窗口拉到前台，不会起第二个内核 |
| 关闭窗口 | 连同内核及其派生的 shell / 子代理进程一起杀掉（`taskkill /T`） |
| 内核中途挂掉 | 弹窗给出退出码和日志路径，可选「重启内核」而不必重开应用 |
| **插件把内核搞挂** | 自动回退到上次成功启动的配置（或安全模式）并重启，同时告知疑似是哪个插件 |
| 外部链接 | 一律交给系统默认浏览器，窗口本身只承载 `127.0.0.1` |
| 菜单 | 检查更新 / 更新通道 / 回退 / 回退到上次可用配置 / 重新加载 / 在浏览器中打开 / 重启内核 / 打开配置目录 / 打开配置备份目录 / 打开日志目录 / 背景设置 / 清除背景 / 缩放 / 全屏 / F12 开发者工具 |

日志写在 `%APPDATA%\DeepSeek Harness\logs\desktop.log`。

---

## 背景图片、动图与视频

「视图 → 背景设置…」可以选一个图片、动图或视频作为主窗口背景，再用三个滑块和一项配色选择调整观感。

**背景铺满整个窗口。** 无论窗口什么比例都不会变形，页面内容滚动时也不会跟着跑。图片与动图用 CSS 的 `background-size: cover` + `background-attachment: fixed`；视频用 `object-fit: cover`。两者画在同一个固定在窗口底层的元素（`#dshbg-video`）上——**这是必需的**：`body` 的背景画在画布层，会落在该元素下面，压暗的黑色蒙版就会跑到画面背后去。

**菜单栏也铺上了。** 原来那条「文件/编辑/视图/帮助」是原生控件，属于窗口框架——Windows 下它的填充色没有 API 可以变透明，所以永远是一条不透明的横条。现在改成**在页面里画一条自己的菜单栏**（`electron/desktop-menu.js`），背景就从它后面透出来；应用整体下移 28px，所以它是真正的顶栏而不是压住内容的浮层。原生菜单栏被**隐藏而不是移除**——F5、F12、Ctrl+C、Alt+F4 这些快捷键仍然由它负责，所以隐藏它不丢任何快捷键。「视图 → 使用系统菜单栏」可以换回原生那条。菜单定义只有一份（`buildMenuData`），原生菜单和页面菜单都由它生成，不会出现两处对不上的情况。

菜单栏必须能**在应用启动完成后仍然存在**：它在页面加载时就画了上去，而 DSH 启动完成会重建自己的根节点，把外来节点一起删掉。所以它除了在几个时间点补画之外，还在页面里装了一个观察者，发现自己被删就请主进程重画——「插进去」不等于「留在那里」。

下移 28px 用的是 `box-sizing: border-box`：页面本身是 `height: 100%`，如果在盒外再加 padding，整页会比窗口高，而 `html` 上又有 `overflow: hidden`，浏览器就会把滚动容器挪到 `body` 上——主界面自己滚起来、底部那排（设置按钮）被裁掉。border-box 让这 28px 从盒内让出，页面仍然恰好一个窗口高。代价是应用可用高度少了 28px，这是「菜单栏占一条」的必然结果。

标题栏（`DeepSeek Harness` 和最小化/关闭按钮）仍然是窗口框架的一部分，**铺不过去**——那需要无边框窗口加自制窗口按钮，会丢掉系统原生窗口行为。

**动图不需要额外支持。** GIF、动态 WebP/AVIF、APNG 都由浏览器自己在 `background-image` 里播放，外壳不做任何事——选进来就能动。

**视频是自动播放的。** 静音、循环、`playsinline` 从第一帧就设好（浏览器拒绝在未静音的元素上自动播放，而 `muted` 在调用之后才设已经太晚）。视频走同一个 `dshbg://` 协议，但请求按字节范围作答（`206` + `Content-Range`）：`<video>` 靠范围请求探测容器和定位，永远回整个文件会让它每次请求都从头下载，循环播放时就等于一直在重下。播放速度（0.25×–1×）、静音、以及「窗口不可见时暂停」可以在设置窗口里调。

**界面半透明，文字不透明。** 滑块调节的是界面面板的不透明度：调低时侧边栏、卡片、输入框变半透明，背景从后面透出来。实现方式是覆盖 DSH 主题自己的背景设计令牌，而不是给整个界面加 `opacity`——后者会把文字和图标一起冲淡，看起来发灰。

三个滑块各有分工：**面板不透明度**（侧边栏、卡片、输入框，最低 20%）、**画布不透明度**（主对话区的底色，可以调到 0，让背景完整露出来）、**背景压暗**（在背景上叠一层可调的黑色，画面太亮时调高）。

**界面配色跟着背景走。** 浅色半透明界面压在深色壁纸上是一层发灰的牛奶膜，深色文字压在亮图上又认不出来——这正是「文字跟背景色不搭」的来源。配色选「跟随背景」时，外壳量一下图片的平均亮度（`nativeImage` 解到 32px 宽再求均值），偏暗就换成深色界面。**视频无法在这里测光**（`nativeImage` 只解静态图），所以固定按深色处理——这正是未知动态画面上唯一站得住的读法：半透明深色玻璃在每一帧后面都能保住文字，半透明白色则会和每一帧亮画面打架。想要浅色，在下拉里手选即可。

做法不是改 DSH 的主题设置，而是把 DSH 自己的两套调色板从页面里读回来（`document.styleSheets` 里 `body` 与 `body[data-ds-dark-theme]` 两条规则的全部 `--dsw-*` 声明），再把需要的那一套以 `!important` 重新声明在 `body` 上。DSH 写在元素内联样式里的令牌也压不过 `!important`，所以即使用户把 DSH 主题固定成浅色，界面照样按背景渲染色。外壳同时同步 `nativeTheme.themeSource`，让窗口边框、菜单和原生控件保持一致。清掉背景后一切恢复原样，DSH 自己的主题设置重新说了算。

对话框、弹层、菜单、代码块和主按钮**保持不透明**，这些地方的半透明只会牺牲可读性。覆盖集合在 `electron/background.js` 的 `SURFACE_TOKENS` 里，每一项为什么在内、为什么不在内都有注释。侧边栏顶部那张「新会话」卡片是唯一的例外：它是按钮，但也是横贯侧边栏的一整块面，留成不透明白色时就是整屏里最扎眼的一块。

**两处「越描越黑」的渐变被换掉了。** DSH 在会话列表底部和输入框上方各用一条渐变把内容淡出，而这条渐变的做法是把面板底色再刷一遍——面板不透明时看不出，变半透明后两层叠加就成了一条边缘生硬的亮带。外壳把这两处改成遮罩（`mask-image`）淡化内容本身，不再多刷一层颜色。

### 实现要点

- 背景文件通过自定义协议 `dshbg://` 流式返回，不做 base64、不重新编码，画质无损。协议处理器忽略请求路径、永远只返回当前配置的那一个文件，不会变成任意文件读取通道。
- URL 带一段文件内容的短摘要（`dshbg://bg/current?v=…`）。协议响应按 URL 缓存，URL 不变时换文件只会改设置、改配色，屏幕上还是第一个；摘要取自字节，因为换文件是把新文件拷到同名路径上，而 Windows 的复制会保留源文件的时间戳，光凭 mtime 和大小认不出两个文件。同一个摘要也写在播放器元素的 `data-rev` 上，因为 `video.src` 会被页面解析成绝对 URL，光看它认不出两个版本。
- 拖动滑块只替换样式表，**不重建播放器元素**，所以调不透明度不会让视频从头开始。窗口从最小化恢复、重新获得焦点时会重新确认播放状态——Chromium 在页面转为不可见时会暂停后台视频，恢复时不会自己接着播。
- 选中的文件会**复制**到 `%APPDATA%\DeepSeek Harness\backgrounds\`，原文件之后被移动或删除都不影响。
- 设置存在 `%APPDATA%\DeepSeek Harness\background.json`（`uiOpacity` / `canvasOpacity` / `dim` / `palette` / `playback`）。滑块拖动时立即重绘样式，只有写盘做了 300ms 防抖。菜单栏的选择单独存在同目录的 `menu-state.json`（`pageMenu`，默认 `true` 即页面内菜单栏）。
- 主窗口的底色取自壁纸的平均色（`win.setBackgroundColor`），页面首帧之前不会先闪一下深灰；视频没有可测的颜色，退回外壳的深灰，正好就是视频所用的配色。
- 设置窗口的尺寸**在创建时定死**，不读回也不自适应：卡片区（`main`）自己滚动，页脚在滚动区之外所以始终可见。它曾经按内容高度自我贴合——那是个尺寸依赖自身布局的窗口，被拖动后宽度和高度都会漂；而且在一个 1707×1067 / 缩放 150% 的屏幕上工作区只有约 711 逻辑像素，比卡片需要的还少，怎么量都装不下。窗口有自己的 preload，**主窗口依旧不挂载任何 preload**，`sandbox` 与 `contextIsolation` 保持原样。
- 设置窗口是**模态子窗口**（`parent` + `modal`）。它原来只是普通子窗口，关掉时前台交给谁由系统按 Z 序决定——而 Windows 不会把激活交给一个当前不在前台的进程，于是点关闭后整个应用会掉到别的软件后面好几秒（实测约 5 秒）。模态由系统负责把前台还给所有者窗口，关闭回调里另有 `moveTop()` + `focus()` 兜底。
- **页面菜单栏没有 IPC 通道。** 主窗口照旧不挂载 preload，注入的菜单只能往自己的控制台写一行 `dshbg-menu: run <id>`，主进程监听这个前缀。它是单向的纯文本通道，只能点名菜单里已经有的 id——比开一条 IPC 桥小得多：插件本来就能 `console.log`，而它能做到的最坏情况只是触发一个用户本来就能点的菜单项。菜单栏本身挂在 `<html>` 而不是 `<body>` 上，因为 body 的子节点归 DSH 的框架所有，会被它 reconcile 掉。
- `scripts/preview-background.cjs` 把真实 DSH 页面渲染成 PNG，用来核对观感（用法见脚本头部注释）。多帧模式会对比相邻截图，用来判断背景是否真的在动；`PREVIEW_VIDEO` 指向一个真实视频文件即可跑完整条视频链路；`PREVIEW_RESIZE_REPEAT` 连做设置更新与窗口拖动，用来验证窗口尺寸不会漂；`PREVIEW_MENU=page` 用**壳自己的菜单定义**装上页面菜单栏，检查它是否铺到背景、是否把应用顶下去却不产生滚动条、被删掉后能否自愈、点击是否回到主进程；`PREVIEW_CLOSE_SETTINGS` 打开再关闭设置窗口，并用 `GetForegroundWindow` 采样确认前台交还给了主窗口。（早先菜单用的是替身定义，结果把 `getMenu` 的接线整个绕过去了——替身会让「画得出来」和「接线正确」分开，而后者才是实机上唯一会错的地方。）
- `electron/check-menu.cjs` 是菜单的廉价回归检查：`buildMenu` 在启动路径上，定义写错会让应用根本起不来，所以它用替身构造一遍菜单、转成原生模板并核对两边的项能对上、role 一个不少。不需要启动内核。

### 局限

- 「文件 → 在默认浏览器中打开」的那个页面**不会有背景**。它是独立运行的 `dsh web`，由系统浏览器渲染，桌面外壳无法向它注入样式。背景只作用于桌面窗口本身。
- 「界面配色」选自动/浅色/深色时，外壳把内置调色板以 `!important` 重新声明在 `body` 上，因此装了背景期间，第三方主题（`ctx.theme` 注册的令牌覆盖）会被压住；选「跟随 DSH 主题」就交还给 DSH，第三方主题照常生效。
- 视频能否播放取决于 Electron 自带 ffmpeg 的编译选项。H.264 的 MP4、VP8/VP9 的 WebM 是常规支持（实测 2560×1440 的 H.264 MP4 正常播放、循环、解码）；`.avi` 这类容器不一定被识别——选进来时设置窗口会显示「无法播放这个文件」并给出原因，换个 MP4 或 WebM 即可。
- 视频背景会持续占用解码资源，比静态图明显费电。设置窗口里的「窗口不可见时暂停」就是为此准备的。
- 选了静态图时，设置窗口的卡片区仍然可以滚动（视频卡片的位置留着），但桌面窗口本身不再因为内容而改变尺寸。

---

## 版本检测与免安装自动更新

外壳是两层：**稳定的 Electron 外壳** + **经常变的 DSH 运行时**。更新只替换第二层。

```
%APPDATA%\DeepSeek Harness\
    runtime-state.json          通道、当前版本、连续启动失败次数
    runtimes\0.1.6-alpha.2\     下载安装的运行时
    npm-cache\                  内置 npm 的缓存
```

- 随应用分发的 `resources\runtime` 是**不可变的兜底**，运行时永不写入它
- 新版本装进用户目录，靠 `runtime-state.json` 切换
- 所以**不需要重装应用、不需要管理员权限**，绿色版和安装版共用同一套逻辑
- 解释器始终来自应用包，只有 JS 运行时树会变

### 更新通道

映射到 npm dist-tag，在「文件 → 更新通道」里切换，默认 `next`：

| 通道 | 当前解析到 | 含义 |
| --- | --- | --- |
| `next` | `0.1.5-rc.2` | 稳态预发布 |
| `alpha` | `0.1.6-alpha.2` | **跟随官方 master** |
| `latest` | `0.1.5-rc.2` | npm 的 latest tag |

> **为什么 `alpha` 等于 master**：master 根 `package.json` 的版本号就是 `0.1.6-alpha.2`，与 npm `alpha` tag 完全一致；而且该版本 `@deepseek-ai/dsh` 的 69 个内部依赖全部声明为 `^0.1.6-alpha.2`，全族自洽。所以「跟 master」拿到的是预编译好的整棵依赖树，**不需要 pnpm、tsc 或原生插件编译**，几秒就能查到、一两分钟装完。
>
> 真正的 `git clone master` 反而是下策：那是 `pnpm@11.7.0` 的 monorepo，要 `pnpm install`（含 `vendor/*` workspaces）+ `tsc -b` 两套 face + tsdown + `native/system` 原生编译，还得有 C++ 工具链。那是开发流程，不是自动更新。

### 检查时机

- 启动后静默检查一次，有新版才弹窗（「下载并安装 / 稍后 / 忽略此版本」）
- 菜单「文件 → 检查更新…」随时手动检查，会显示当前版本、通道和所有通道的解析结果
- 菜单顶部常驻一行 `当前 DSH <版本> · 内置/已安装`，是当前运行版本的可信来源
- 下载在后台进行，用任务栏进度条提示，**不打断正在进行的会话**

### 下载与安装交给内置 npm

版本查询和安装都走随包的 npm CLI，而不是自己实现 registry 访问。理由是：npm 已经会读取用户自己的 registry、代理和 TLS 配置——在公共 registry 不可达的机器上（本机就是），那套配置是唯一能用的东西。安装用 `--ignore-scripts`，因为 DSH 的原生依赖把预编译二进制直接打在 tarball 里。

安装完成后会逐项校验：入口文件、Web 前端产物、以及 `dsh` / `dsh-web-app` / `dsh-web-frontend` 三者版本是否一致（不一致说明 npm 解出了混版树，拒绝激活）。

### 失败回滚

同一个运行时**连续 2 次启动失败**就自动回退：优先回退到上一版本，没有则回退到内置运行时，并把出问题的版本记进 `skippedVersion`，之后自动更新不会再选中它。回退后会用新运行时重启内核并明确告知。

菜单里也可以手动「回退到上一版本」或「恢复为内置运行时」。已经安装的版本只保留「当前 + 上一版」，其余自动清理。

### 单独验证更新链路

```powershell
npm run test:updater          # 探测通道 → 安装 → 启动探测 → 回滚，全程不开 Electron
npm run test:updater:check    # 只探测通道，不下载
```

这个脚本用真实的打包运行时和一次性的用户目录，跑的是应用本身的那套代码，因此可以在打包前就把问题挡住。

---

## 插件把内核搞挂时的配置自动回退

内核启动时只加载 profile 声明的那几个插件 bundle，所以**一个坏插件就足以让整个应用打不开**：
内核要么在打印监听地址之前就退出，要么干脆卡住、永远不打印。而运行时本身不记得「上次能跑的时候
配置长什么样」，它只会照着当前配置再失败一次。这份记忆由桌面外壳来存。

### 配置快照

内核报出监听地址的那一刻，外壳把决定插件集合的文件抄一份到
`%APPDATA%\DeepSeek Harness\profile-guard\last-good\`：

| 文件 | 作用 |
| --- | --- |
| `$DSH_HOME/cordis.patch.yml` | 机器级补丁层，对所有 profile 生效且优先级最高 |
| `profiles/web/package.json` | `dsh.profile.bundles`（加载哪些 bundle）+ 插件依赖 |
| `profiles/web/cordis.patch.yml` | 该 profile 的用户补丁层 |
| `profiles/web/pnpm-lock.yaml`、`pnpm-workspace.yaml` | 插件安装状态 |

内容没变就不重写，所以快照时间始终指向「这份配置第一次跑起来」的时刻。

### 启动失败之后

失败处理按「最可能的原因优先」排序，而且**绝不会因为运行时版本坏掉而牺牲你的插件配置**：

1. **配置回退**：配置相对快照变了（新加、启用或手改过插件）就先把上次能跑的配置放回去，再重启内核。
2. **运行时版本回退**：配置没变，说明问题多半不在插件，于是走原来那条「同一运行时连续 2 次失败 →
   回退到上一版本 / 内置运行时」。这一步发生在动插件之前，正是为了不误伤插件配置。
3. **安全模式**：只有已经退到不可变的内置运行时、仍然起不来时，才停用第三方 bundle
   并把该 profile 自己的补丁层清成 `[]`，保证应用至少能打开。
4. 三步都救不回来，才落到原来那个「启动失败」弹窗。

每一步动手前都会先归因：内核自己报了插件名就用它——`plugin tree failed to load`、
`plugin(s) failed to load:`、`failed to apply loader entry <行> (<包>)`、
`cannot resolve profile bundle "..."`、`N entries did not activate`、fatal rejection 的栈；
内核**一个字都没打印**（卡死那种，也是 vision-toolkit 当初的表现）就退化为
「对比快照：哪些 bundle / 补丁行是新的或改过的」。

每一步动手之前，当前配置都会先完整备份到
`%APPDATA%\DeepSeek Harness\profile-guard\backups\<时间戳>\`，里面有一份 `manifest.json`
写明这次备份的原因、失败详情和当时的插件清单；最多保留最近 20 份，**从不静默丢弃**。
恢复完成后弹一个非阻塞提示，写明失败原因、疑似元凶、改了哪些文件、备份在哪。

配置回退与安全模式每轮启动各只自动尝试一次，成功启动后计数清零，所以不会陷入反复重启。

### 手动入口

- 「文件」菜单常驻一行 `上次可用配置 · <时间> · <n> 个文件`
- 「回退到上次可用配置」：把当前配置和快照的差异列清楚，确认后回退并重启内核
- 「打开配置备份目录」：直接打开备份根目录，坏配置都在里面

### 边界

- 只动上面那几张配置文件：会话、凭据、`profiles/*/node_modules` 一概不碰。
- 只保护 `dsh web` 用的 `web` profile（外壳只跑这一个）。
- 回退的是**上次成功启动**的配置。如果那份配置本身是个定时炸弹（启动时正常、跑十分钟才炸），
  回退救不了它，仍然走「内核进程已退出」的弹窗。
- 如果插件包已经被 `dsh plugin remove` 卸掉，回退后的 `package.json` 会引用一个装不回来的包，
  这次回退救不回来，会退到「启动失败」弹窗并给出日志路径。

### 单独验证

```powershell
npm run test:profile-guard            # 离线用例 + 真内核失败归因
node scripts/test-profile-guard.mjs --offline   # 只跑离线用例
```

用例在 `.test-profile-guard/` 里造一个一次性 DSH_HOME，真的用 `runtime/node/node.exe`
拉起内核去跑「bundles 里写了个没装的包」和「装了一个 init 就抛异常的插件」两种坏配置，
把内核**真实输出**喂回归因逻辑，因此匹配的是内核实际会打印的东西，而不是源码推测的东西。
子进程输出走文件描述符而不是管道，所以在受限 shell 里也能跑。

---

## 已验证

`dist/win-unpacked/DeepSeekHarness.exe` 实测跑通，全链路对得上：

```
[shell 0.1.5 starting]
spawning runtime: ...\resources\runtime\node\node.exe
                  ...\resources\runtime\app\node_modules\@deepseek-ai\dsh\lib\bin.js web --port 0 --no-open
DSH_HOME=C:\Users\Admin\.dsh
runtime ready at http://127.0.0.1:45743/?token=...        ← 约 13 秒
```

| 检查项 | 结果 |
| --- | --- |
| 外壳拉起的是自带 `node.exe` 和自带 DSH | ✅ 日志中的路径全部在 `resources\runtime\` 下 |
| 拿到 OS 分配的随机端口（`--port 0` 生效） | ✅ 与 3080 上的 CLI 实例互不干扰 |
| 复用已有 DSH home | ✅ `DSH_HOME=C:\Users\Admin\.dsh` |
| GUI 真的能出页面 | ✅ `HTTP 200`，响应含 `window.__DSH_BOOT__`，27660 字节 |
| 真的有原生窗口 | ✅ 进程主窗口标题为 `DeepSeek Harness` |
| 退出时回收内核 | ✅ 关闭外壳后内核端口不再监听，无孤儿进程 |

更新链路（`npm run test:updater --boot`，跑的是应用自己的 `electron/updater.js`）：

| 检查项 | 结果 |
| --- | --- |
| 通道探测 | ✅ `next→0.1.5-rc.2`、`alpha→0.1.6-alpha.2`、`latest→0.1.5-rc.2` |
| 真实下载安装 | ✅ `@deepseek-ai/dsh@0.1.6-alpha.2`，约 70 秒装完 520 个包 |
| 内置运行时未被改动 | ✅ 安装后 `bundled` 版本仍是 0.1.5-rc.2 |
| **装回来的 alpha 运行时能真正跑起来** | ✅ 启动并返回 `HTTP 303 → 200`，含 `__DSH_BOOT__`，31188 字节 |
| 连续失败才回滚 | ✅ 第 1 次失败不回滚，第 2 次回退到内置并写入 `skippedVersion` |
| 手动回退 | ✅ 回到内置运行时 |

打包产物（`dist/win-unpacked/DeepSeekHarness.exe`）两条解析路径都实测过：

| 状态 | 日志 | GUI |
| --- | --- | --- |
| 干净状态 | `booting DSH 0.1.5-rc.2 (内置)` | ✅ 200 + `__DSH_BOOT__`，窗口正常 |
| `runtime-state.json` 指向用户目录下的运行时 | `booting DSH 0.1.5-rc.2 (已安装)` | ✅ 200 + `__DSH_BOOT__`，窗口正常 |

> 顺带记一个跨版本的差异：token 换 cookie 的握手，0.1.5-rc.2 是直接返回 `200`，而 0.1.6-alpha.2 改成返回 `303` 重定向到 `/`。Chromium 会自动跟随，所以外壳无需改动；但如果以后写任何裸 HTTP 客户端去探这个地址，必须跟重定向并带上 cookie。

打包进去的运行时也单独验过一次：用 `runtime/node/node.exe` 直接跑
`.../dsh/lib/bin.js web --port 0 --no-open`，同样正常输出地址并返回 200，
说明 `--ignore-scripts` 装出来的依赖树是完整的。

---


## 已知限制

- **没有代码签名。** 首次运行 Windows SmartScreen 会拦一下，需要点「更多信息 → 仍要运行」。
  要消除这个提示需要自备一张代码签名证书，并配置 electron-builder 的 `win.certificateFile`。
- **首次构建需要联网**下载 Electron 二进制和 NSIS 工具（脚本里已默认指向 npmmirror 镜像）。
- **目录选择器可能落在窗口后面。** 工作区选择走的是 DSH 内核侧的原生对话框
  （独立于 Electron 进程），少数情况下不会自动抢焦点，切一下窗口即可。
- **只打了 x64。** 需要 arm64 的话，在 `package.json` 的 `build.win.target` 里加一个
  `arm64` 条目，并且 `fetch-electron.mjs` 也要拉对应架构的 Electron。
- **背景只在桌面窗口里生效。** 菜单「在默认浏览器中打开」的那个页面是独立的
  `dsh web`，由系统浏览器渲染，外壳注入不了样式，所以没有背景。
- **`node.exe` 不随更新变化。** 更新只替换 JS 运行时树，解释器始终来自应用包。
  如果将来某个 DSH 版本把 `engines.node` 提到内置 Node 之上，那个版本会下载成功但启动失败，
  然后被自动回滚（日志里会记下它声明的 `engines.node`）。要真正跟进就得重新打包应用。
  当前内置 Node 22.20.0，而 DSH 0.1.6-alpha.2 要求 `^22.19.0 || >=24`，是满足的。
- **`alpha` 是预发布通道。** 它跟随 master，随时可能是坏的。坏的那次会被回滚挡住，
  但你会看到一次「启动失败 → 已回退」的提示，这是预期行为，不是崩溃。
- **更新需要网络和磁盘。** 每次更新下载约 220 MB，实测约 70 秒；运行时目录会同时保留
  当前版本和上一版本（约 440 MB）。
- 升级 DSH 版本时，改 `scripts/prepare-runtime.ps1` 的 `-DshVersion` 默认值后重跑
  `npm run prepare:runtime` 即可，`electron/logo.svg` 和图标会跟着官方资源一起更新。
