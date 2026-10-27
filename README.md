# VoiceScribe · 本地音视频转文字

一个完全本地运行的桌面应用：把视频/音频拖进窗口，用 Whisper 在本机转成文字，再导出成 TXT / SRT / Markdown / JSON。
文件不上传、不需要联网（首次下载模型除外）。

也支持把 **chatlog 导出的微信聊天记录 JSON** 直接拖进来，批量转写里面的语音消息并原地替换成文字。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Electron 34（主进程 `electron/main.js` + 预加载 `electron/preload.js`） |
| UI | React 18 + TypeScript + Vite 6 + **shadcn/ui（Nova 风格）** + Tailwind CSS v4 |
| 图标 | **Lucide** |
| 动画 | **Motion**（`motion/react`） |
| 布局 | **react-resizable-panels**（左右分栏可拖拽调宽） |
| 拖拽 | **dnd-kit**（文件队列排序） |
| 状态 | **Zustand**（`src/store/useScribeStore.ts`） |
| 推理 | **whisper.cpp**（`@fugood/whisper.node` N-API 绑定，Metal / CPU）+ **ffmpeg-static** 解码 |

## 目录结构

```
voice-scribe/
├── electron/
│   ├── main.js          # 窗口、引擎进程生命周期、IPC、导出对话框
│   ├── preload.js       # contextBridge 暴露的安全 API（含 webUtils 取文件路径）
│   └── engine/          # 转录引擎（纯 Node，跑在 utilityProcess 里）
│       ├── worker.js    # 命令循环：probe / transcribe / cancel / 模型管理
│       ├── transcriber.js # whisper.cpp 推理、简体提示、提示词复读过滤
│       ├── audio.js     # ffmpeg-static 探针 + 解码成 16kHz 单声道 PCM
│       └── models.js    # 模型目录 + 支持 Range 续传的下载器
├── src/
│   ├── components/      # TopBar / ModelMenu / ChatBar / MergedTranscript / SelectionBar
│   │                    # DropZone / FileQueue / Transcript / Toaster
│   ├── components/ui/   # shadcn 组件（Nova 风格）
│   ├── lib/             # 格式化、导出构造（含合并）、chatlog 解析、模型元信息、cn()
│   ├── store/           # Zustand store
│   ├── App.tsx
│   └── index.css        # Nova 主题 token（oklch）
├── scripts/
│   ├── launch-electron.js      # 启动 Electron（带 --no-sandbox 开关）
│   ├── make-icons.py           # 生成 png / ico / icns 图标
│   ├── prepare-platform-deps.js # 跨平台打包时补齐其它架构的原生依赖
│   └── after-pack.js           # electron-builder 钩子：换 ffmpeg、裁掉多余绑定
├── .github/workflows/release.yml # 三平台原生构建 + 发布
└── build/               # 图标资源（icon.png / icon.ico / icon.icns）
```

### 用 Service Console 托管（推荐）

本仓库带 `.service-console.json`，配合 [Service Console](https://github.com/yzbf-lin/service-console)
可以从桌面端/CLI 启动、重启、看日志：

```bash
SC="/Applications/Service Console.app/Contents/MacOS/service-console"
"$SC" start voice-scribe          # 开发模式（Vite 5180 + Electron）
"$SC" logs voice-scribe --tail 100 --follow
"$SC" restart voice-scribe
"$SC" stop voice-scribe
```

| 服务名 | 用途 |
|---|---|
| `voice-scribe` | 开发模式，Vite 热更新 + Electron |
| `voice-scribe-prod` | 生产模式，`npm run build` 后直接跑打包产物 |

开发端口默认 **5180**（`VITE_PORT` 可改）。之前写死 5173，会和本机其它项目的 Vite 撞车——
本机 `pd-qa-frontend` 长期占着 5173，`strictPort` 会让本项目直接启动失败。

## 运行

```bash
# 1. 安装依赖（whisper.cpp 绑定 + ffmpeg 二进制都是 npm 包，装完即可用）
npm install

# 2. 开发模式（Vite + Electron 热更新，界面在 http://localhost:5180）
npm run dev

# 端口被占用时换一个（vite.config.ts 与 Electron 都读这个变量）
VITE_PORT=5200 npm run dev

# 3. 生产模式（先构建再启动）
npm start
```

> **不需要 Python，也不需要系统 ffmpeg。** 推理走 `@fugood/whisper.node`（随包分发的
> whisper.cpp 预编译二进制，Apple Silicon 上用 Metal），解码走 `ffmpeg-static`。
> 只有首次下载模型需要联网。

## 打包与发布

安装包由 GitHub Actions 在**各自的系统上**构建（`.github/workflows/release.yml`）：
macOS 用 `macos-14` / `macos-13`，Windows 用 `windows-latest`。

之所以不在本机跨平台编译：`@fugood/node-whisper-*` 和 `ffmpeg-static` 都是**按宿主平台**
在 `npm install` 时下载的原生二进制，一台 Mac 上装不到 Windows 的 `.node` 和 `ffmpeg.exe`。
交给原生 runner，`npm ci` 装出来的就是对的，不需要任何交叉替换。

```bash
# 打 tag 即触发：构建 → 上传产物 → 汇总发布 Release
git tag v0.1.0 && git push origin v0.1.0

# 只想先验证构建、不发版
gh workflow run release.yml      # workflow_dispatch

# 本地打包（只出当前系统能跑的那几个架构）
npm run dist:mac    # dmg + zip，arm64 / x64
npm run dist:win    # nsis 安装包 + zip
```

产物命名：`VoiceScribe-0.1.0-arm64.dmg`、`VoiceScribe-0.1.0.dmg`（Intel）、
`VoiceScribe Setup 0.1.0.exe`。

**关于签名**：仓库没有 Developer ID 证书，所以 macOS 产物是 ad-hoc 签名、Windows 产物未签名。
首次打开需要手动放行一次（Release 说明里也写了）：

```bash
# macOS：拖进「应用程序」后执行
xattr -dr com.apple.quarantine /Applications/VoiceScribe.app
```

Windows 上 SmartScreen 提示时点「更多信息」→「仍要运行」。

打包时 `scripts/after-pack.js` 会把 ffmpeg 换成目标架构那一份，并删掉其它平台的
`node-whisper-*` 绑定——否则 Intel 包会带上 arm64 的 ffmpeg，一启动就 `bad CPU type`。

## 使用

1. 拖入视频/音频，或点击「选择文件」（⌘O）。支持批量导入，队列可拖拽排序。
2. 顶部选择模型与语言（默认 `small` + 自动检测）。
3. 左侧底部可填「术语提示」（如 `硬装、水电改造、泥瓦油工`），能明显提升专业词汇准确率。
4. 点「开始转录」，右侧实时逐句出现文字与进度。
5. 点「导出文本」→ TXT / SRT / Markdown / JSON，或「复制」到剪贴板。
6. 勾选队列左侧的方框可**多选**（按住 Shift 点=连选），底部出现「已选 N 条」工具条，
   支持**合并复制**和**合并导出**（TXT / SRT / MD / JSON）成一份文档。

## 聊天记录模式（转写微信语音）

把 [chatlog](https://github.com/sjzar/chatlog) 导出的 JSON 拖进窗口（或 ⌘O 选择 `.json`），
应用会自动识别并切换到**聊天记录模式**：不再把整个 JSON 当音频，而是把里面每条 `type: "voice"`
的语音抓出来、下载到本地、排队转录，最后把结果**原地写回 `content`**。

1. 应用从 JSON 里解析出所有语音（`media_url` → `contents.host` + `contents.voice` → 正则兜底），
   并发 4 路把 mp3 拉到临时目录（只允许回环地址，避免被任意 URL 当代理）。
2. 左侧顶部出现聊天横幅：`N 条语音 · 已转写 M`，点「全部转录」按时间顺序逐条跑。
3. 右侧默认进入**合并视图**（见下），左侧点任意一条可切回单条逐句视图。

### 合并视图：把一整段对话看完

一段对话被拆成十几条语音后，最麻烦的是「不能整段读、整段复制」。合并视图解决这个：

- 右侧按时间顺序把**所有语音拼成一篇**，每条一块，块头是 `20:16` + 说话人（同一个人连续说话时
  只显示一次，避免刷屏）；转录中会实时更新并自动滚到当前那条。
- 顶部「复制全部」→ 把整段对话按 `[20:16] 说话人` + 正文的格式复制到剪贴板。
- 顶部「导出」→ TXT / SRT / MD / JSON 合成一份文档；也可回到「单条」逐句看时间轴。
- 块内悬停有「复制」和「单条」两个快捷操作。

### 导出原始 JSON（保留对话结构）

「导出」菜单和左侧横幅里的「原始 JSON」都会走这条路径：**原样复制整份导出文件**，
顶层字段、消息顺序、非语音消息、键顺序全部不动，只把每条已转写语音的 `content`
换成文字。未转写的语音保持原来的 `[语音](…)`，所以**任何时候都能导**，中途停下也不丢数据。

> - 语音默认按**中文**转写：微信语音基本都是普通话。聊天模式下若语言设为「自动」，会强制走 `zh`
>   （省掉一次语言探测，也保证每条短语音都带上简体提示）。
> - 静音或极短的语音（0:00）容易让 Whisper **把提示词复读出来**。这类片段会被过滤掉，
>   该条保持原始 `[语音](…)` 内容不变，不会被写成一句假文本。
> - 转写失败的条目同样保留原文，所以中途停止再导出也不会丢数据。

## 模型管理（后台下载）

顶栏的模型按钮是一个**模型面板**，每个模型都带实时状态：

| 状态 | 含义 |
| --- | --- |
| `已下载` + 体积 | 权重已在本地缓存，可直接离线转录 |
| `未下载` + 预计体积 | 只有元信息；点右侧云朵图标可**立即后台下载**（不切换当前模型） |
| `N%` + 进度条 | 下载中，显示已下载 / 总量、实时速度；顶栏按钮同步显示百分比 |
| `已暂停 N%` + 继续按钮 | 用户主动暂停；已下载的字节留在磁盘，点 ▶ 从断点继续 |
| `失败` | 悬停看具体错误（网络、磁盘等） |

- 选中的模型若尚未下载，**选中即开始后台下载**，等待时间可以和导入文件重叠。
- 转录时如果权重还没下完，右侧会显示「正在下载 xxx 模型」+ 进度条，而不是干等一个转圈。
- 下载在引擎进程里异步跑，**不阻塞**其它操作；面板底部可看本地总占用、跳转缓存目录。
- 权重来自 Hugging Face 的 `ggerganov/whisper.cpp`（`ggml-tiny/base/small/medium/large-v3.bin`），
  默认落在 `<应用数据目录>/models`（macOS：`~/Library/Application Support/voice-scribe/models`）。
  首次使用需联网，之后全程离线。
- **中断后真的会断点续传**：下载器自己发 `Range` 请求写 `ggml-*.bin.incomplete`，关掉应用、断网、
  连接超时都只损失最后几秒的进度。网络抖动会自动退避重试（最多 6 次），每次从断点接着走。
- **可以暂停**：下载中点行内的 ⏸ 立刻停（`AbortController` 直接掐断连接），字节保留；
  点 ▶ 从断点继续。暂停状态在顶栏和模型面板都可见，**重启应用后仍然是「已暂停」**——
  暂停时会写一个 `ggml-*.bin.paused` 标记文件，启动时据此区分「用户主动停的」和「被中断的」。
- **没下完的会自动接着下**：退出、崩溃、断网留下的 `.incomplete` 在下次启动时**自动续传**，
  不用再点一次。这也是「每次重启都要重新下载」的直接原因——之前把残留一律当成暂停态，
  大模型（2.9 GB / 约 700 KB/s ≈ 1 小时）永远下不完，每次重启都停在原地等用户点继续。
- **下载会显示剩余时间**：`12 MB / 2.9 GB · 743 KB/s · 剩余 45:12`，大文件不再像卡死。
- **已下载的模型是真的留在本地**：文件落在 `<应用数据>/models/ggml-*.bin`，重启后仍是「已下载」。
  只有下完才会改名去掉 `.incomplete`，所以面板上的「已下载」一定代表能直接用。
- **暂停是硬约束**：已暂停的模型再去转录不会偷偷续传，而是明确提示「下载已暂停，请点继续」。
  只有用户点下载/继续才会恢复（引擎里 `force` 标记区分「用户主动」和「任务需要」）。

## 窄窗口自适应

窗口变窄、或者把分隔条拖到底时，**内容不允许溢出到分隔线另一侧**。三条规则：

| 位置 | 做法 |
| --- | --- |
| 左右两栏 | `minSize` 用**像素**而不是百分比（队列 `252px`、正文 `420px`）。百分比下限在窄窗口里会把栏压到比内容还窄，内容就顶到分隔线外面，必须重新拖一下才复原 |
| 正文头部按钮 | 右栏是 `@container/doc`；`复制 / 导出 / 查看全部 / 单条` 的**文字**在容器 < 600px（导出/开始转录 < 520px）时隐藏，只留图标 + tooltip |
| 长文本 | 段落一律 `break-words`，`min-w-0` 贯穿 flex 链；URL、无空格长串会换行而不是把卡片撑破 |

窗口最小宽度跟着栏宽走：`electron/main.js` 里 `minWidth: 700`（252 + 1 + 420 再留点余量）。

## 实现要点

- **不需要系统 ffmpeg**：解码走 `ffmpeg-static`（npm 分发的 ffmpeg 二进制），任何容器
  （mp4/mov/mkv/webm/m4a…）都先转成 16kHz 单声道 s16le PCM 再喂给 whisper.cpp——
  它自带的 miniaudio 只能解 wav/mp3，mp4 会直接报 "Failed to load audio file"。
- **引擎跑在 `utilityProcess` 里**：加载模型会阻塞 JS 线程数秒（实测约 3–12 秒，期间定时器一个都不触发），
  原生推理又可能把进程带崩，所以推理不在主进程做，也不在渲染进程做。协议仍是带 `id` 的消息，
  和原来的 JSON-lines 一一对应，主进程/渲染层的契约没变。
- **引擎挂了会自己回来**：原生崩溃后按退避自动重启（最多 3 次；健康运行超过 30 秒就重置额度），
  并且每个引擎相关的 IPC 入口都会先 `ensureEngine()`，所以即便重启额度用尽，
  用户下一次点「开始转录」也能把引擎拉起来，不会卡在「引擎缺失」。
  macOS 上关掉窗口再点 Dock 图标重新打开时同样会重启引擎。
- **进度来自推理本身**：`onProgress` 给的是 whisper.cpp 处理到第几个 30 秒窗口，
  按 `t1 / duration` 也能算出进度；这里直接用前者，避免长音频尾部误差。
- **性能**：Apple Silicon 走 Metal，23 分钟音频 `small` 模型约 **45 秒**（beam size 5），
  比原来的 CTranslate2 CPU 路线快约 9 倍。`VOICESCRIBE_GPU=0` 可强制 CPU 对比。
- **模型下载自己实现**：`models.js` 用 `fetch` 发 `Range` 请求，写 `<model>.bin.incomplete`，
  下完再 `rename`。Hugging Face 会 302 到带签名的 CDN 地址（约 1 小时过期），所以**每次重试都要
  重新解析 URL 再带 Range**，不能复用旧的直链。实测中断在 30 MB 后恢复，从 30 MB 接着走。
- **模型下载进度**：写入的字节直接算出 `downloaded/total/percent/speed`，按 300ms 节流后以
  `model:progress` 广播；总量取 HEAD 的 `Content-Length`，拿不到时退回内置体积表。
  下载按模型名做单飞锁，手动下载与转录触发的下载不会重复。
- **取消**：`cancel` 同时做两件事——`AbortController` 中断 ffmpeg 解码/下载，
  `transcriber.cancel()` 调 whisper.cpp 的 abort callback 让它在两个窗口之间停下。
  实测 5 秒时点「停止」，5.02 秒就收到 `cancelled`，引擎进程不用重启，模型也不用重新加载。
- **简体中文**：`language == "zh"` 时总会把简体提示拼进 prompt，Whisper 会跟随提示的字体输出；
  同时用 `isPromptEcho()` 过滤掉"复读提示词"的段落（归一化标点空白后做双向包含判断），
  否则静音片段会转出 `请用简体中文转写。` 这种假文本。
- **自动检测要先探一次**：whisper.cpp 只在**结果里**告诉你检测到什么语言，那时提示词早已生效——
  实测 `auto` + 中文音频会输出繁体（`要提前進行可以啊`）。所以 `auto` 时先拿前 30 秒跑一次
  探测（约 1 秒），拿到 `zh` 再走正式那遍，提示词就能起作用。探测失败或非中文则按原样继续。
- **合并导出**：`buildMergedExport()` 把多个 `FileItem` 拍平成块，块头用 `[HH:MM] 说话人`
  且**同一说话人连续出现时省略名字**；SRT 按队列顺序累加时长铺一条连续时间轴
  （语音本身没有共同时间轴，这是近似做法）。
- **文件路径**：Electron 32+ 已移除 `File.path`，这里用 `webUtils.getPathForFile`（见 preload）。
- **受限环境启动**：Chromium 自带的沙箱无法在别的沙箱里初始化（报
  `Failed to initialize sandbox: Operation not permitted`，GPU 进程直接退出）。在 agent shell /
  容器里请用 `npm run dev:nosandbox`（等价于给 Electron 加 `--no-sandbox`）。

## 截图

- `docs/model-menu.png`：模型面板（已下载 / 未下载 / 下载中）
- `docs/model-downloading.png`：转录时正在后台下载权重
- `docs/chatlog-mode.png`：聊天记录模式（13 条语音全部转写完成）
- `docs/merged-view.png`：合并视图，一整段对话读到底
- `docs/merge-selection.png`：多选后的合并复制 / 合并导出工具条

## 已验证

对 23 分钟、140 MB 的 MP4（AAC 44.1kHz 立体声）实测：模型 `small`，**约 45 秒**完成，
输出 641 段带时间轴文本（6994 字），语言自动识别为中文；解码 44.5 MB PCM 只用 1.2 秒。
和旧版 Python 输出逐字对比，字符级召回 90.6%、准确率 90.5%（差异主要在口语断句与同音字）。

聊天记录模式对一个 54 条消息、13 条语音的导出实测：13/13 完成，导出后 12 条 `content`
被替换为文字、1 条 0:00 静音语音保留原文，非语音消息与键结构零改动。
合并视图实测：13 条按时间铺成一篇，`复制全部` 得到 2736 字节的整段对话；
TXT / MD / SRT / JSON 四种合并产物结构均校验通过（SRT 时间轴按队列顺序连续累加）。
