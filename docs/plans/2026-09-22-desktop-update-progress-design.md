# 桌面版更新进度与镜像切换设计

日期：2026-09-22
状态：已实现（`electron/tarball-cache.js`、`electron/update-window.js`、`updater.js`、`desktop-menu.js`）

## 为什么要改

旧路径把下载整个交给内置 npm：

```
update: download 0.1.6-alpha.2
installing @deepseek-ai/dsh@0.1.6-alpha.2 into ...\.staging-0.1.6-alpha.2-38832
（这里停了 104 秒，没有任何输出）
update: verify
update: activate
update installed: 0.1.6-alpha.2
```

用户的原话是「我都不知道下载到什么程度了，中间有没有失败，断点继续暂停等功能」。三个问题叠在一起：

1. `npm install` 带 `--loglevel=error`，且我们自己的 `run()` 把 stdout/stderr 缓冲到进程结束 ⇒ 中途零信息；
2. `onProgress` 只传 `{phase, version}`，四个阶段之间是黑箱 ⇒ UI 只有一个不确定任务栏进度条；
3. 没有任何镜像选择，实际用哪个 registry 完全由 `~/.npmrc` 决定。

一次 0.1.6-alpha.2 安装是 **520 个 tarball / 一百多 MB**，104 秒里出错与进度都不可见，这是必须解决的可观测性问题。

## 方案：自己做下载，安装仍交给 npm

不自己写解析器 —— registry 访问、代理、TLS、`.npmrc` 组合这些 npm 已经处理对了，尤其在这台公共 registry 不可达、
只能靠本地镜像的机器上。分工是：

| 步骤 | 谁做 | 用什么 |
| --- | --- | --- |
| 依赖树解析 | 内置 npm | `npm install --package-lock-only --omit=dev --ignore-scripts`，读 `package-lock.json` 的 `resolved` + `integrity` |
| 体积测量 | 我们 | 每个 tarball 一次 `Range: bytes=0-0`（部分 registry 拒绝 HEAD），并发 16 |
| 下载 | 我们 | 并发 6，`.part` 落盘 + `Range` 续传 + 完整性校验 + 镜像回退 |
| 缓存播种 | 我们 | `cacache.put.stream(cachePath, integrity, {integrity})`；cacache 缺失时回退 `npm cache add` |
| 安装 | 内置 npm | `npm install --prefer-offline --ignore-scripts --omit=dev`（缓存已满，正常情况零网络） |
| 校验 / 切换 | 我们 | 入口文件 + Web 前端产物 + 三包版本一致 → `rmTree(target)` + `rename` + `activate` |

`optionalDependencies` 按平台过滤（`os`/`cpu` 匹配），否则会白下另一平台的二进制。

### 下载器（`electron/tarball-cache.js`）

- `downloadEntry`：`<name>-<version>.tgz.part` 断点文件；请求带 `Range: bytes=<已有长度>-`；服务端不支持时
  自动从头下；结束后按 `integrity`（sha512/sha256/sha1）校验，通过才改名为 `.tgz`。
- `MAX_ATTEMPTS = 3`，每次尝试走一个不同的镜像 URL（`rewriteTarballUrl` 把官方 tarball URL 换到镜像域名）。
- 空闲 60s / 首字节 30s 超时，`REPORT_INTERVAL_MS = 250` 聚合一次进度，速度取 5 秒滑动窗口。
- 暂停/取消靠 `createUpdateController()`：pipeline 在 chunk 边界中断，抛 `PausedError` /
  `UpdateCancelledError`。**Windows 没有 SIGSTOP，所以只能自己控流**，不能给 npm 发信号。
- 取消/失败只删 `.staging-<version>-<pid>`，**`update-cache\tarballs\` 整个保留**（`pruneTarballs` 只清 7 天前的）。
  所以「重试」几乎立刻装完 —— 这也是「断点继续」的实现方式：不靠 OS 挂起，靠已下载字节复用。
- 未测到体积的 tarball 记 `size: null`，`partial: true`，百分比按已测量部分算并显式标注，避免进度条倒退。

### 进度窗口（`electron/update-window.js` + `update.html` + `update-preload.js`）

独立非模态子窗（560×620，可最小化），与背景设置窗口同一套套路：`preload` + `contextBridge`
（`window.dshUpdate`）+ `ipcMain.handle('dshup:get'/'dshup:action')`，主进程推 `dshup:state`
（整快照，150ms 节流）和 `dshup:log`（单行）。

- **关窗 ≠ 取消**：`closed` 只刷新菜单并把前台还给主窗口；安装继续跑，主窗口菜单的「更新进度…」能把它叫回来。
- 状态机 `STEPS`：解析依赖树 / 探测下载体积 / 下载 tarball / 写入 npm 缓存 / 离线安装 / 校验 / 切换，各带耗时。
- 下载阶段是确定百分比（`percent`、`bytes`/`totalBytes`、`speed`、`etaSeconds`）；其余阶段是不确定动画。
- 按钮按状态显隐：下载中「暂停 / 取消」，暂停后「继续」，失败「重试 / 打开日志目录」，就绪「立即重启内核 / 稍后」。
- 安装结束后不再弹旧的「更新已就绪」对话框 —— 重启/稍后归这个窗口，避免两个入口说两件事。
- 任务栏进度条仍保留：下载阶段映射真实百分比，seed/install 阶段回到不确定。

### 镜像源切换

`MIRRORS` 七项（`auto` + 淘宝 / 腾讯云 / 华为云 / 清华 TUNA / 中科大 USTC / npm 官方），选择写入
`runtime-state.json` 的 `registryId`（白名单校验，未知值回落 `auto`）。`npmEnv()` 把选中的地址作为
`npm_config_registry` 传给内置 npm，**优先级高于 `~/.npmrc`**；`auto` 表示完全不干预。

菜单「文件 → 更新镜像源（<当前>）」与「更新通道」同构：单选标记 + 点击即切换，切换后立刻重查。
菜单另有「镜像测速…」：并发拉各镜像的 packument（上限 2 MB / 20s），按吞吐排序并给出推荐值；
`testMirrors()` 的结果也显示在进度窗口里。

## 已知限制

- 「测速」测的是 packument 抓取吞吐，不是 tarball 吞吐；镜像对新包与热包的响应差别可能很大。
- 体积测量是 520 次往返，并发 16 也要十几秒（旧路径这段时间同样在跑 npm 解析，只是完全静默）。
- 暂停的粒度是 chunk（默认 64 KB 级），不是字节级；已写入的 `.part` 不会回退。
- 若 registry 返回的 `Content-Range` 与请求不一致，会放弃续传从头下（宁可重下，不拼错文件）。
- 镜像回退只作用于单个 tarball 的重试，不重新解析依赖树；packument 本身仍走选中的镜像。

## 测试

| 命令 | 覆盖 |
| --- | --- |
| `npm run test:tarball-cache` | 真实 registry：体积测量、下载+校验、错误 integrity 被拒、无 controller 调用者；本地慢速 registry：暂停、取消保留 `.part`、`Range` 续传、镜像改写、格式化 |
| `npm run test:update-window` | 进度窗口：快照渲染、进度条/字节/阶段列表、日志尾巴、按钮过 preload 桥、关窗不取消、失败可重试、就绪可重启 |
| `npm run test:updater` | 整条链路（含新的下载→播种→离线安装），并校验进度契约（阶段齐全、最后一个下载快照 `percent=100`、`bytes===totalBytes`） |
| `npm run test:updater --install <版本>` | 通道没有新版本时也能强制验一遍下载器 |
| `electron electron/check-menu.cjs` | 菜单定义与新命令（`update-progress`、`mirror:*`、`mirror-speed-test`）是否都能映射到命令 |
