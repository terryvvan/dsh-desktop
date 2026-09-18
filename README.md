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
    splash.html             内核引导期间的启动画面
    logo.svg                DSH 官方鲸鱼标识（由 prepare:runtime 从运行时里拷出来）
  scripts/
    prepare-runtime.ps1     生成 runtime/（自带 node.exe + npm + 生产版 DSH）
    fetch-electron.mjs      下载并解包 Electron 二进制
    make-icon.mjs           用官方标识渲染 build/icon.png 和 build/icon.ico
    test-updater.mjs        不开 Electron 直接验证整条更新链路
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
| 外部链接 | 一律交给系统默认浏览器，窗口本身只承载 `127.0.0.1` |
| 菜单 | 检查更新 / 更新通道 / 回退 / 重新加载 / 在浏览器中打开 / 重启内核 / 打开配置目录 / 打开日志目录 / 缩放 / 全屏 / F12 开发者工具 |

日志写在 `%APPDATA%\DeepSeek Harness\logs\desktop.log`。

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
