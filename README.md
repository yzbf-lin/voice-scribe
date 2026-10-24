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
| 推理 | Python + faster-whisper（CTranslate2） |

## 目录结构

```
voice-scribe/
├── electron/
│   ├── main.js          # 窗口、Python worker 生命周期、IPC、导出对话框
│   └── preload.js       # contextBridge 暴露的安全 API（含 webUtils 取文件路径）
├── python/
│   └── worker.py        # JSON-lines 协议转录引擎；也支持 CLI 模式
├── src/
│   ├── components/      # TopBar / ModelMenu / ChatBar / MergedTranscript / SelectionBar
│   │                    # DropZone / FileQueue / Transcript / Toaster
│   ├── components/ui/   # shadcn 组件（Nova 风格）
│   ├── lib/             # 格式化、导出构造（含合并）、chatlog 解析、模型元信息、cn()
│   ├── store/           # Zustand store
│   ├── App.tsx
│   └── index.css        # Nova 主题 token（oklch）
└── scripts/launch-electron.js
```

## 运行

```bash
# 1. 安装前端依赖
npm install

# 2. 一次性初始化 Python 推理环境（venv 在 python/.venv）
npm run setup:python

脚本会按优先级找 **Python 3.13**（`python3.13` → `/opt/homebrew/bin/python3.13` → …），
找到就 3.13，找不到再退回 `python3`。也可以指定：`PYTHON_BIN=/opt/homebrew/bin/python3.13 npm run setup:python`。

> 脚本每次都先 `rm -rf python/.venv`：如果直接对一个**用别的 Python 版本建好的** venv
> 再跑 `python3 -m venv`，会得到 pip 装到 A 目录、python 从 B 目录导入的损坏环境。
> PyAV 只会装预编译 wheel（`--only-binary=:all:`）；拿不到 wheel 时脚本会提示改用
> 3.13 或 `brew install ffmpeg pkg-config`。

# 3. 开发模式（Vite + Electron 热更新）
npm run dev

# 4. 生产模式（先构建再启动）
npm start
```

> Python 环境位置可用 `VOICESCRIBE_PYTHON=/path/to/python` 覆盖。

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

> - 语音默认按**中文**转写：微信语音基本都是普通话，而 `auto` 检测会跳过简体提示，
>   导致输出繁体（`於是有地方開避刊嗎`）。聊天模式下若语言设为「自动」，会强制走 `zh`。
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
| `失败` | 悬停看具体错误（网络、磁盘等） |

- 选中的模型若尚未下载，**选中即开始后台下载**，等待时间可以和导入文件重叠。
- 转录时如果权重还没下完，右侧会显示「正在下载 xxx 模型」+ 进度条，而不是干等一个转圈。
- 下载在 Python worker 的后台线程里跑，**不阻塞**其它操作；面板底部可看本地总占用、跳转缓存目录。
- 权重来自 Hugging Face（`Systran/faster-whisper-*`），默认落在 `~/.cache/huggingface/hub`。
  首次使用需联网，之后全程离线。
- **中断后真的会断点续传**：下载器自己发 `Range` 请求写 `<blob>.incomplete`，关掉应用、断网、
  连接超时都只损失最后几秒的进度。网络抖动会自动退避重试（最多 6 次），每次从断点接着走。

## 窄窗口自适应

窗口变窄、或者把分隔条拖到底时，**内容不允许溢出到分隔线另一侧**。三条规则：

| 位置 | 做法 |
| --- | --- |
| 左右两栏 | `minSize` 用**像素**而不是百分比（队列 `252px`、正文 `420px`）。百分比下限在窄窗口里会把栏压到比内容还窄，内容就顶到分隔线外面，必须重新拖一下才复原 |
| 正文头部按钮 | 右栏是 `@container/doc`；`复制 / 导出 / 查看全部 / 单条` 的**文字**在容器 < 600px（导出/开始转录 < 520px）时隐藏，只留图标 + tooltip |
| 长文本 | 段落一律 `break-words`，`min-w-0` 贯穿 flex 链；URL、无空格长串会换行而不是把卡片撑破 |

窗口最小宽度跟着栏宽走：`electron/main.js` 里 `minWidth: 700`（252 + 1 + 420 再留点余量）。

## 实现要点

- **不需要系统 ffmpeg**：音频解码走 PyAV，PyAV 的 wheel 自带 FFmpeg 库；解码逻辑由
  `worker.decode_audio()` 自己实现（faster-whisper 自带的 `decode_audio` 会调用
  `av.open(metadata_errors=...)`，该参数在新版 PyAV 已被移除），因此**任意 `av >= 11` 都能用**。
  PyAV 装不上时还会退回到调用系统 ffmpeg。
- **安装脚本会先重建 venv**：对不同 Python 版本重复执行 `python3 -m venv` 会产生
  pip 装到 A、python 从 B 导入的混合环境，所以一律 `rm -rf python/.venv` 后重来。
- **CPU 上 float32 比 int8 更快**：在 Apple Silicon 上实测约 5× 实时（int8 反而更慢，因为 CTranslate2 的 int8 kernel 针对 x86 调优）。
- **进度来自解码器本身**：每产出一个 segment 就按 `segment.end / duration` 回报进度，边转边显示。
- **worker 常驻**：Electron 启动时拉起一个 Python 进程，用 JSON-lines 通信，模型只加载一次。
- **模型下载自己实现，不用 `snapshot_download` 传字节**：`huggingface_hub 2.x` 每次下载都新开一个
  `<etag>.<uuid8>.incomplete` 临时文件并以 `wb` 截断写入（见其 `file_download.py`），
  所以**它本身不具备续传能力**，中断即从 0 重来，还会把上一次的残片留在磁盘上
  （实测三次中断攒下 3.4 GB 垃圾）。现在改为：按 `HfApi.model_info` 拿到每个文件的
  sha256/size，自己用 `urllib` 发 `Range` 请求写 `<blob>.incomplete`，完成后 `os.replace` 到
  blob 路径，最后再调一次 `snapshot_download` 只负责建快照软链（blob 已在，不会重下）。
  启动前用 `_clean_stale_partials()` 清掉旧后端留下的残片。字节数只统计一次，
  顺带修掉了之前 Xet 双计导致的「4.6 GB / 2.9 GB」超 100% 问题。
- **模型下载进度**：`_Progress` 直接接收写入字节，按 300ms 节流后以 `model:progress` 广播；
  总量取 `model_info` 里各文件 size 之和（缓存到
  `~/.cache/huggingface/hub/.voicescribe-model-sizes.json`，离线时退回内置体积表）。
  下载跑在独立线程，按模型名做单飞锁（`ensure_downloaded`），手动下载与转录触发的下载不会重复。
- **取消**：`cancel` 命令置位，segment 循环内检查后中断。
- **简体中文**：`language == "zh"` 时总会在 `initial_prompt` 末尾拼一句简体提示，
  Whisper 会跟随提示的字体输出；同时用 `_is_prompt_echo()` 过滤掉"复读提示词"的段落
  （归一化标点空白后做双向包含判断），否则静音片段会转出 `请用简体中文转写。` 这种假文本。
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

对 23 分钟、140 MB 的 MP4（AAC 44.1kHz 立体声）实测：模型 `small`，约 5 分钟完成，输出 500+ 段带时间轴文本。

聊天记录模式对一个 54 条消息、13 条语音的导出实测：13/13 完成，导出后 12 条 `content`
被替换为文字、1 条 0:00 静音语音保留原文，非语音消息与键结构零改动。
合并视图实测：13 条按时间铺成一篇，`复制全部` 得到 2736 字节的整段对话；
TXT / MD / SRT / JSON 四种合并产物结构均校验通过（SRT 时间轴按队列顺序连续累加）。
