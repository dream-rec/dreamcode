# 语音助手（录音辅助解答）设计说明

> 版本：1.3.0 起。本文描述新功能的目标、边界、架构、数据流与可调参数，供后续维护参考。

## 1. 目标与非目标

**目标**

- 在不影响现有截图解题功能的前提下，新增「监听会议音频 → 逐句语音识别 → 一键交给大模型解答」的能力。
- 识别与解答**全部由快捷键手动触发**：手动开始/停止监听、手动发送；不做自动触发。
- 语音识别（STT）与解答用的大模型（LLM）分别独立配置；LLM 也可以直接复用当前 Provider 组。
- 尽量接近「同声」：面试官说完一句，一两秒内文字就出现在窗口里。

**非目标**

- 不做 TTS（文字转语音）。用户描述中的「tts 模型」实际是 STT / ASR（语音识别），本功能按 STT 实现。
- 只采集面试软件/指定应用播放的输出音频；不提供 DreamCode 麦克风或输入设备采集。目标应用自行使用麦克风是独立场景，不应因此扩大采集范围。
- 不做说话人分离（面试官 / 自己）。如果目标应用主动将麦克风声音回放到自身输出，该回放属于目标输出，不能靠进程 tap 区分。
- 不做自动触发：不根据识别文本自动发问，也不做「问句结束检测」，发什么、什么时候发完全由快捷键决定。

## 2. 用户流程

```
Alt+L ──▶ 开始监听（自动跳转语音助手页，可关闭）
            │  会议软件播放的声音被采集，按停顿切成一句句
            │  每句立即送去识别，识别结果逐行出现在「待发送内容」
            ▼
Alt+L ──▶ 停止监听：识别内容留在「待发送内容」，不自动发送
Alt+Shift+L ──▶ 发送给大模型并继续监听（面试官连续追问时用）
Alt+↑ / Alt+↓ ──▶ 在识别记录里上下选择断句（也可鼠标点击，Shift+点击多选）
Alt+/ ──▶ 只发送选中的断句并继续监听；未选中时发送最新一句
Alt+Shift+, ──▶ 清空对话（识别记录、回答、LLM 上下文）
Alt+. ──▶ 停止生成（与截图解题共用）
Alt+, ──▶ 从任意页面返回语音助手页
```

「发送全部」与「发送选中」的区别：前者把所有**尚未发送**的行拼成一个问题（已发送的行留在原处、置灰并跳过），后者只发送选中的行。发送后已发送行不会被删除，方便回看；「清空」才真正清掉。停止监听只是结束采集：识别内容保留在待发送区，只有发送键才会把内容交给大模型。

语音助手快捷键（含「返回监听页面」）均可在设置页自定义，帮助页同步展示。

## 3. 架构

```
┌──────────── renderer ────────────┐        ┌──────────── main ────────────┐
│ VoiceCaptureController (常驻)     │        │ voice.ts  状态机 / 单一事实源  │
│  ├ 系统输出：mediaDevices         │        │  ├ segments: 待发送转写行      │
│  │   → AudioWorklet → 20ms PCM   │ IPC    │  ├ selection: 选中的断句范围   │
│  ├ 指定应用：native helper 的 PCM │ ─────▶ │  ├ exchanges: 问答历史         │
│  ├ UtteranceSegmenter (能量 VAD)  │ 段音频 │  ├ pendingTranscriptions       │
│  └ WAV 编码 → voice:pushSegment   │        │  └ conversation (LLM 上下文)    │
│                                   │        │ stt.ts       POST /audio/transcriptions 或 /stt
│ VoicePage (/voice) 仅展示 store   │ ◀───── │ ai.ts        getVoiceAnswerStream  │
│ useVoiceStore  ← voice-state      │ 状态/  │ app-audio.ts helper 进程 / PCM 解码 │
│                ← voice-answer-chunk│ 流式块 │ shortcuts.ts 快捷键 → voice.*     │
└───────────────────────────────────┘        └───────────────────────────────┘
```

**为什么这样切分**

- 浏览器音频 API 只能在 renderer 用；API Key、代理、请求头继续留在 main（与截图链路一致，密钥不进页面逻辑）。
- 状态机放在 main：快捷键在 main 触发，且需要在 renderer 切换路由时保持监听不中断。`VoiceCaptureController` 挂在 `App` 根部而不是页面里，正是为了让监听与路由无关。
- renderer 只持有一份从 main 镜像来的 `VoiceSnapshot` 和本地电平值；所有变更通过 IPC 请求 main 完成。
- 指定应用的采集必须另起原生进程（Chromium 不暴露该能力），但 PCM 仍然回送到 renderer 统一做 VAD/WAV，所以断句逻辑对所有音源只有一份。

### 3.1 状态

```ts
captureState: 'idle' | 'starting' | 'listening' | 'stopping'
answering: boolean                      // LLM 是否正在流式输出（与监听互不阻塞）
segments: TranscriptSegment[]           // 自上次发送以来的转写行（pending/done/error，sent 标记已发送）
selection: { anchor, focus } | null     // 选中的断句范围（按 seq，支持 Shift 连选）
exchanges: VoiceExchange[]              // 问答历史（question / answer / status）
error: string | null
```

监听与回答是两个独立维度：回答还在生成时可以继续监听下一题；再次发送会中止上一条回答。

### 3.2 命令与确认

main → renderer 通过 `voice-capture-command` 下发 `start / flush / stop`，其中 `flush` 与 `stop` 带 `requestId`，renderer 在**把最后一段音频推给 main 之后**再回 `voice:flushed / voice:captureStopped`。IPC 同通道有序，因此 main 收到确认时最后一段一定已进入待识别队列；随后 `waitForTranscriptions()` 等所有识别完成（上限 50s）再拼问题。

### 3.3 断句（VAD）

`src/renderer/src/voice/audio/vad.ts` 是一个能量阈值分段器：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `thresholdDb` | -45 dBFS | 帧 RMS 超过即视为有声 |
| `silenceMs` | 800 ms | 连续静音超过此值 → 这一句结束，送去识别 |
| `minSpeechMs` | 200 ms | 有声总时长不足则丢弃（敲击声、噪声） |
| `maxSegmentMs` | 20 s | 长篇独白强制切断，保证增量识别 |
| 预滚动 | 300 ms | 句首前保留一小段，避免吞掉第一个字 |

会议软件输出的音频信噪比很高，能量 VAD 在实测里足够稳定；设置页有「录音测试」与电平条（红线 = 阈值）用于现场调参。若未来需要更鲁棒的方案，可在同一接口下替换为 Silero VAD（onnxruntime-web）。

**关于「停顿与问题间隔」**：识别结果按句逐行显示并带时间戳，问题之间的间隔就是行与行之间的停顿；真正「哪些行属于同一个问题」由用户按发送键决定，不做猜测。Whisper / SenseVoice 类模型自带标点，一句内部的停顿由模型还原。

### 3.4 语音识别（STT）

- 设置页第一行是「调用协议」下拉框，选项名自带请求路径（不在下方另写注释）：

  | 选项 | 请求 | 预设 Base URL / 模型 |
  | --- | --- | --- |
  | `SenseVoice（/audio/transcriptions）` | `POST {baseURL}/audio/transcriptions` | `https://api.siliconflow.cn/v1` / `FunAudioLLM/SenseVoiceSmall` |
  | `OpenAI（/audio/transcriptions）` | 同上 | `https://api.openai.com/v1` / `gpt-4o-mini-transcribe` |
  | `Groq Whisper（/audio/transcriptions）` | 同上 | `https://api.groq.com/openai/v1` / `whisper-large-v3-turbo` |
  | `grok2api（/stt）` | `POST {baseURL}/stt` | `http://127.0.0.1:8000/v1` / `grok-stt` |

  没有单独的「自定义」选项：预设之外的网关直接选 `OpenAI（/audio/transcriptions）` 再改 Base URL / 模型，行为与之前一致（旧配置里的 `provider: 'custom'` 归一化为 `openai`，已填的地址与模型不动）。选项名一律用 ASCII，不使用中文厂商名。

  切换协议只填补空白或仍是其他预设默认值的字段，自建的 Base URL / 模型名（例如远端 grok2api 网关）不会被覆盖。
- OpenAI 兼容分支：multipart 上传 16 kHz 单声道 PCM16 WAV，字段 `model`、`response_format=json`，可选 `language`；Grok2API 分支：同一份 multipart（字段名 `file`）+ `model`，并在填写了 `language` 时追加 `format=true`（上游要求 `format` 必须同时给 `language`，否则 400）。
- 已验证可用的服务：OpenAI（`whisper-1` / `gpt-4o-mini-transcribe`）、硅基流动（`FunAudioLLM/SenseVoiceSmall`）、Groq（`whisper-large-v3-turbo`）、Grok2API 的 `/stt`（mock 网关验证）。
- 每段一请求，并发发出，`seq` 保证显示顺序；单请求 45 s 超时。空结果的段会被静默移除（避免噪声产生空行）。
- 不发送任何识别提示词（`prompt`）：各家对 prompt 的支持与长度限制不一致，对会议音频也没有实际收益。
- 主动选择「分段批量识别」而不是各家私有 WebSocket 流式协议：只需一个通用接口即可覆盖所有 OpenAI 兼容网关，延迟 ≈ 一句话长度 + 一次往返（1~3 s），对面试场景足够。如需真正的逐字流式，可新增 `SttProvider` 实现（如 OpenAI Realtime transcription）而不动其他层。

### 3.5 解答（LLM）

- `llmMode = 'shared'`：直接用当前激活的 Provider 组（快捷键切组同样生效）。
- `llmMode = 'custom'`：独立的 `ProviderConfig`（OpenAI 兼容 / Claude、Base URL、Key、Model、代理、请求头），复用 `createLanguageModel()`。
- 系统提示词内置在 `src/main/prompts-voice.md`：先复述理解的问题，再给可口述的结构化回答；`voice.answerPrompt` 非空时整体替换。
- 上下文：保留最近 8 轮问答；「清空」会同时清掉上下文。
- 输出经 `ThinkTagStreamFilter` 过滤 `<think>`，与截图解题一致。

## 4. 音频来源与平台限制

产品只提供输出音频采集，设置中不再提供「输入设备/麦克风」。指定应用失败时不会自动切换成全部系统声音，也不会自动启动录音。

| 来源 | 实现 | 平台说明 |
| --- | --- | --- |
| 系统音频（全部，保留原路径） | `getDisplayMedia({audio:true})` + main 端 `setDisplayMediaRequestHandler` 返回 `audio:'loopback'`，视频轨立即停止 | Windows 官方支持；macOS 13+ 依赖 Chromium 回环。需要用户明确选择，指定应用失败时不自动降级到此路径 |
| 系统音频（稳定版 Chrome） | macOS 14.4+：私有正向 Core Audio process tap，PCM 原生转换为 16 kHz 单声道 Float32 | `com.google.Chrome`；启动只需应用运行，可在开始监听很久以后才播放；不依赖窗口可见性或显示器 |
| 系统音频（其他指定软件 / 老版 macOS） | macOS helper 保留 ScreenCaptureKit `SCContentFilter` 包含目标应用；Windows 保留 `application-loopback` 的 WASAPI 进程树回环 | macOS 13+；Windows 10 2004+ x64。网易云音乐等路径没有迁移到新后端，仍受各自平台限制 |

### 4.1 指定软件的采集链路

```
voice:appCaptureStart(appId) ─▶ main 起 helper（macOS: audio-tap capture <bundleId>；Windows: ApplicationLoopback.exe <pid>）
helper stdout（macOS float32 / Windows PCM16 48k stereo）─▶ 重采样为 16 kHz 单声道 ─▶ SilencePadder（补齐静音，让 VAD 能收口）
─▶ voice-app-pcm ─▶ renderer Framer ─▶ 输出音频共用的 VAD → WAV → STT 链路
```

- 两端的 PCM 都归一化成 16 kHz 单声道 float32，**断句与识别只此一份实现**。
- 部分后端在静音或等待目标进程时可能不发包，因此 main 侧有 `SilencePadder` 按墙钟补静音，让 VAD 能收到「停顿」；收到补零或静音 PCM 不代表已成功采到目标声音。
- macOS helper 走 stderr 的 JSON 事件（`started` / `format` / `error`）与 main 通信；`stdin` 关闭即退出，父进程死了不会残留。
- macOS 构建：`npm run build:audio-tap` 将 Swift 后端及 C 实时缓冲编译为 macOS 13 deployment target 的 x86_64 + arm64 通用二进制。输出 `resources/bin/audio-tap.app`，包含用途说明和 ad-hoc 签名，并同步到 `out/main/bin/audio-tap.app`；不修改发布 CI。`npm run build` 本身不重新编译 Swift。

### 4.2 macOS 上 ScreenCaptureKit 的实测限制

以下是旧 ScreenCaptureKit 后端的历史观察，不是新 Chrome 后端的验证结果。在 macOS 13.0 Ventura x64 上，`SCShareableContent`（列应用）与 `SCStream`（取音频）曾有以下现象：

- `audio-tap list` 几乎总是**永久挂起**，`SCShareableContent` 的四种调用形式（`current`、`excludingDesktopWindows` 的 onScreen true/false、excludingDesktopWindows true）全部不返回；十余次调用中仅成功过一次。
- 同时 `screencapture`（CoreGraphics）在同一进程链下正常出图，TCC 日志（`log show --predicate 'subsystem CONTAINS "TCC"'`）显示 `kTCCServiceScreenCapture` 请求已附权（responsible = Kaku，authValue=2），即**非权限问题**；系统里也找不到 ScreenCaptureKit 的 XPC 服务/`SCStreamAgent`（macOS 13.0 的该框架只有 `Resources` + `_CodeSignature`）。
- 结论：这是系统侧 ScreenCaptureKit 的问题（macOS 13.0 + Intel），不是本项目的代码缺陷；helper 已加 20 s 超时，超时后 stderr 输出可操作的中文提示，设置页直接展示该提示。

现代 macOS 14.4+ 改用 `NSWorkspace` 列举运行中的应用，不依赖 SCK、窗口或录屏权限；最小化、后台应用也可选择。老系统继续保留原列表路径。指定应用失败时提示错误，不自动扩大采集范围，也不提供输入设备降级。

### 4.3 旧 Chrome 路径的排查记录

2026-10-02 在 macOS 14.8.3（Chrome 154）上用「自建测音页面 + Goertzel 判频」复现过（均为单次观测，未完全定性）：

- 目标应用**在采集开始之后**才出声（浏览器按需启动音频服务进程）时，「只包含该应用」的 filter 采不到；`updateContentFilter` 无效，只有重建 `SCStream` 才恢复。
- 目标窗口不在被采集的那块显示器上（移到屏幕外）时，该应用采不到声音。
- 目标开着麦克风时出现过整段静音（含与其他应用一起放进同一 filter 时两者都静音），但同一实例稍后又采得到，**属间歇现象，原因未定**。

试过改用「排除其他应用」（显示器全局 tap 减去其他应用）：上述几种情况都能采到，但实测会把**通过 helper 进程放音的其他应用**（Electron 类应用）也录进来，与「只采目标应用」的承诺不符，因此未采用、未合入。

用户进一步明确的复现是：Chrome 中的牛客 AI 面试页面占用麦克风时，指定 Chrome 输出采集完全无声音；其他会议软件没有做过同样验证。不能据此断言“抢麦”或推断所有会议软件均有同一根因。

### 4.4 Chrome 正向 Core Audio 后端

**API 与实现边界**

- 仅稳定版 `com.google.Chrome` 且 macOS 14.4+ 使用 `CATapDescription` / `AudioHardwareCreateProcessTap`；不存在 global tap 或排除其他应用的列表；唯一的范围扩大是 4.7 定义的、由证据门槛触发的双工回退（一次性系统输出采集 + `fallback` 事件 + UI 提示）。
- 先验证唯一运行安装的 bundle、规范化安装路径和 PID/启动时间；同一安装可有多个独立 profile 根进程，保留启动时逐个验证的根身份，不任意挑选一个实例。再把同安装内、bundle 身份和父进程链均可追溯到这些根的 HAL process **AudioObjectID** 加入正向集合。不会按进程名、宽泛前缀、当前是否出声筛选；无法验证的成员不加入，不同安装目录仍拒绝。
- 注册 HAL process-list 监听后再进行首次协调；每秒刷新身份以识别退出和 PID 复用。空集合只等待、销毁旧图，不创建空 tap。helper 新出现/重启会更新集合，所有已验证的 Chrome 根进程退出后结束本次采集；某一 profile 退出不会误停其他仍在运行的已验证 profile。
- `started` 附带 `backend: "core-audio-process-tap", waiting: true`，含义是身份/观察/取消机制已就绪，**不是有声、权限成功或实际采到音频**。因此长时间等候播放不会撞到主进程 45 秒或正式监听 55 秒的启动超时；后续失败仍通过 `error` / ended 路径传回。
- tap 私有、nonexclusive、unmuted；aggregate **只含这个 tap，不含任何物理输入设备**，以唯一 tap 为时钟且关闭多时钟漂移补偿，不更改系统默认设备。DreamCode 不请求麦克风；Chrome 自己开麦不等于允许 DreamCode 读取物理输入。
- 成员变更先停 IO，检查 tap description 是否可写并检查 OSStatus；保留 UUID/私有/正向/不静音设置。同格式时重用，否则仅用同一可信正向名单重建。监听默认输出、设备存活与格式变化；相同通知和静音不会触发重试风暴。
- C IOProc 只向预分配、无锁、有界 SPSC 缓冲复制；溢出整包丢弃并计数。worker 依据 tap 的真实 ASBD 和交错布局，以有状态 `AVAudioConverter` 转成固定 16 kHz mono Float32 little-endian。非阻塞 stdout 按 Float32 对齐整块写入，旧 generation 的样本不进入新流。
- EOF/SIGTERM 合并为一次停止。控制队列可立即使 generation 失效；图的 start/stop/销毁串行，即使 `AudioDeviceStart` 尚未返回也不会提前释放 IOProc/aggregate/tap/缓冲。若系统调用无法退出，主进程仍保留原一秒 SIGKILL 兜底并等待 child close，不能宣称这种情况已完成优雅清理。
- helper 和宿主均声明 `NSAudioCaptureUsageDescription`。只使用公开授权流程，不使用私有 TCC API、重置权限或以静音推断“未授权”。真实授权归属仍需在实际签名/启动链下验证。

**自动化与真机验证必须分开**

- `npm test` 以 mock child/preload 验证已有租约、设置退休、取消、ID 隔离；新增 armed 长等待、拆分 PCM/JSON、晚到错误、重复 stop/等待 close，以及网易云音乐旧 SCK 协议回归。
- `npm run test:native-audio` 执行生产身份准入、集合协调、tap/aggregate 描述、有界缓冲、Float32/PCM16 与交错/平面/44.1kHz 转换、清理顺序及阻塞 start 取消逻辑；不打开音频设备、不创建真实 tap、不访问服务商。
- 编译、描述检查、合成内存信号和补零均不能证明真实采音成功。真机验收需分别测试先播放/晚播放、后台/最小化/移出显示器、helper 重启、输出设备变化、无关应用/Electron 干扰频率隔离。
- **Chrome 双工是核心验收项**：需要单独验证 Chrome 使用真实物理麦克风时仍能取得其输出。fake microphone 只能提供补充证据，不能替代用户复现场景。必须另行获得真实麦克风授权；不访问用户牛客会话、现有浏览内容或通话音频。
- 本节实现及无设备测试不构成上述 OS/音频验收通过的声明；网易云音乐真实音频、系统回环、Windows 和正式发布签名链仍应分别回归。

### 4.5 本次集成验证状态（2026-10-03）

- 主工作区：45 项 Node 回归测试、13 项原生无设备场景、node/web 类型检查、完整 Electron 构建及修改文件 lint 通过。通用 helper 已重新编译，x86_64/arm64、严格签名检查、resources/out 两份 bundle 一致性通过。全仓 lint 仍有既有 7 errors / 4 warnings，未改无关文件。
- 真实本地合成音验证通过：先监听 60 秒后播放，以及已经播放后再监听，都持续捕获 Chrome 的 997 Hz；同时播放的 Electron 1613 Hz 干扰低于测试阈值。第二次完整尝试的两段测量均收到约 64,087 个样本/4 秒，目标幅度约 0.025，最大干扰幅度低于 6e-10。证据保留在任务目录的 `live-duplex.json`。
- **真实麦克风并发尚未验证**：独立 Chrome 测试页的麦克风授权等待 120 秒后超时，没有进入有效输入 track 的双工测量。不能把这次超时解释为已经复现采音故障，也不能宣称牛客 AI 面试已经修复。测试已释放自身资源，未保存或上传麦克风输入。
- 用户选择先保留改动、稍后手动复测，不继续自动重试麦克风授权。后台/最小化场景在修正测试工具焦点操作后尚未得到成功复跑结果；移屏、真实 helper 重启、设备切换、网易云/系统回环/Windows 的真机回归同样不计为已验证。
- 使用当前开发代码需要重启开发版 DreamCode；已安装的旧版本不会因仓库代码更新而自动升级。手动复测应选择 Chrome 并保存，在牛客已开麦时开始监听，确认电平/识别有输出且不混入其他应用。

### 4.5.1 双工回退实现与验证（2026-10-04）

- 实现：原生侧 `ChromeBlindPolicy` 分派 + `SystemAudioFallback`（SCK 系统级后端，16 kHz mono Float32、非阻塞 stdout、格式变化先发 `format`）；会话在回退后只保留目标存活监督。Node 侧 `onFallback` 透传、`VoiceSnapshot.captureNotice` 与语音页「系统声音模式」徽标；smoke 工具回退感知（记录 `fallbacks`、回退后隔离断言自动放宽、开麦场景加长稳定期）。
- 自动化：47 项 Node 测试（新增 fallback 事件透传与 notice 生命周期）、14 项原生无设备场景（新增盲区分派策略：双工立即回退、陈旧图重建有界 ≤5 次/≥15 秒）、node/web 类型检查、改动文件 lint 通过；helper 重新编译并签名（x86_64/arm64）。
- 真机（Chrome 154 / macOS 14.6，真实物理麦克风 + 页内 WebRTC 997 Hz 环回）：
  - 双工状态：`capture com.google.Chrome` 恰好 1 次 `fallback`（`reason: chrome-duplex`）、0 次 rebuild；回退后系统级采集采到 997 Hz（幅度 0.133，与 tap 正常时 0.150 同量级）。
  - 无麦克风基线：重启清除双工后 tap 直接工作（幅度 0.150；0 fallback、0 盲区事件）。
  - 回退中目标 profile 退出：helper 保持运行（另一 Chrome 根仍在）、0 错误、0 重建，PCM 持续输出。
  - 完整 Chrome 全退出场景未实测（需关闭用户浏览器）；复用既有「所有已验证根退出即停止」路径。

### 4.6 现场诊断开关（`DREAMCODE_AUDIO_DIAG`）

`DREAMCODE_AUDIO_DIAG=1 npm run dev`：main 进程把 helper 的 stderr 事件与原始 PCM 计数打到开发终端（前缀 `[audio-diag]`），helper 额外输出 `diagnostic` 事件（默认关闭时为零开销）。

- `target` / `membership`：选中的 HAL 成员（object/pid/可执行文件名）、默认输出设备（id/name/uid/rate）、是否处于等待。
- `graph-create` / `tap` / `aggregate` / `io-start` / `io-started` / `tap-update` / `graph-closed`：图生命周期与 tap 的真实 ASBD、就地更新是否被重用。
- `stats`（每秒）：`ioCallbacks` 回调数、`accepted` 接收整包、`dropped` 环形满丢弃、`rejected` 布局/格式不匹配、`frames` 有效帧、`nonzeroFrames` 真实非零帧、`peak` 输入峰值、`running` 聚合设备运行位、`defaultDevice` 当前默认输出设备、`members` 每个成员对象的 `running`/`output`/`input`。
- `pcm`（应用侧每秒，挂在 `SilencePadder` **之前**）：原始字节/样本、窗口峰值与 RMS；`pcm summary` 为整段汇总。
- `audio-tap procs [bundleId]`：只读列出 HAL 认定的所有音频进程对象（object/pid/可执行文件/bundle/running/output/input/是否被准入），用于回答“音频到底记在哪个进程对象上”。不建立 tap、不输出音频。
- 盲区/回退分派：`blind` 事件的 `action`（`rebuild` / `system-fallback`）、`fallback-started`（回退后端已启动，`backend: sck-system-wide`）；产品事件 `{"event":"fallback","mode":"system","reason":"chrome-duplex"}` 不受诊断开关影响，主进程据此在快照里设置 `captureNotice` 并显示「系统声音模式」。

判定路径：`ioCallbacks`/`frames` 不涨 = 图未运行或没有回调；两者增长而 `nonzeroFrames` 为 0 = 收到的是全零缓冲；成员 `output=1` 而 `nonzeroFrames` 为 0 = **采集盲区**（HAL 说目标在输出，tap 里却没有它的音频）；helper 有峰值而应用侧 `pcm` 为 0 = 问题在 IPC/VAD 链路。诊断只输出计数与元数据，不写音频文件、不上传、不改变采集行为；不得以全零推断权限被拒。

### 4.7 采集盲区检测、有界重建与双工回退

判定不靠“静音”：仅当某个成员进程对象报告 `kAudioProcessPropertyIsRunningOutput != 0`、且 tap 已连续 ≥2 秒只收到全零（且有回调数据）时，才判定为盲区。此时按证据分派：

- 分派依据：任一准入成员对象报告 `kAudioProcessPropertyIsRunningInput != 0`。这是 VoiceProcessing 双工状态的直接证据；该状态下按应用归属的采集（tap 任意集合、SCK app-scoped）已实测全部拿不到音频，重建无效。
- 双工盲区（成员正在使用麦克风）：**一次性**切换为系统输出采集。输出不受诊断开关影响的 `fallback` 事件（`mode: "system"`、`reason: "chrome-duplex"`）；停掉 tap 图，改用 ScreenCaptureKit 系统级后端继续输出 16 kHz mono Float32；UI 在「监听中」旁显示「系统声音模式」徽标（悬停有完整说明），采集结束时清除。切换是单向的：双工状态持续到 Chrome 重启，而 Chrome 退出本身就结束会话；不重建、不回切。
- 非双工盲区（陈旧图）：输出 `blind` 事件（`action: rebuild`、`attempt`、静音成员列表）；开启诊断时另外输出 `blind-hal`——一次完整 HAL 进程清单快照。用**同一可信成员名单**重建采集图（close + 重新创建 tap/aggregate/IO，新 UUID），并重置盲区计时。
- 重建有界：同一次会话最多 5 次、之间至少 15 秒；仍不能恢复时只停止重试并保留诊断。除上述双工回退外，不扩大采集范围、不改用全局捕获、不抩其他应用。
- 普通静音（暂停/无声内容）不会触发；成员 `output` 为 0 时一律不触发。

已知平台限制（2026-10-03 定位；2026-10-04 以双工回退收口）：

- 触发条件：被监听的应用（Chrome）打开麦克风。应用一开麦，macOS 上 Chrome 会打开 VoiceProcessing 音频单元（其二进制中存在 `OpenVoiceProcessingAU` 符号），并从此把**全部输出**改走双工语音处理路径，直到该应用重启为止（重启后恢复）。
- 实测证据（本机可复现的 WebRTC 面试模拟：麦克风+摄像头+远端音频）：
  - 未开麦：进程 tap 采到远端音频（峰值 0.15）；探测工具对照 afplay 同样得到 0.15，说明测量链可靠。
  - 开麦后（无论 AEC 用浏览器软件实现还是系统实现）：产品 tap = 全零；**把所有 27 个进程对象都放进 tap** = 全零（因此不是成员名单问题）；SCK 的 app-scoped 音频采集 = 全零。
  - 同时音频确实还在输出：`kAudioDevicePropertyDeviceIsRunningSomewhere` 为 1；Chrome 音频服务进程对象仍报 `output=1` 且 `kAudioProcessPropertyDevices` 指向默认输出设备（Built-in Output，正常 UID）——不是设备切换、也没有隐藏的语音处理聚合设备。
  - 释放麦克风后该状态**不恢复**，只有重启该应用才恢复（与现场 A/B/C 三条日志完全一致）。
  - 尝试过 `--no-audio-service-aec`、`--disable-features=ChromeWideAEC,LoopbackAEC,SystemLoopbackAsAecReference,EnforceSystemEchoCancellation` 等组合，均不能避免该状态。
- 结论：该状态下音频不再进入"进程 I/O"，因此**任何按应用归属的采集（CATap 任意进程集合、SCK app-scoped）都拿不到**；只有设备/系统级采集（SCK 的 display/system 音频，即产品里的"系统全部声音"）能看到它（用户现场已验证）。这是平台限制，不是成员选择或图生命周期问题：有界重建无法恢复（已现场与本地验证）。
- 决策（2026-10-04）：采用（A）并加证据门槛——仅在上述双工证据成立时自动降级为系统输出采集；按应用过滤仍是第一优先级，因此该降级只允许一次、必须发出 `fallback` 事件并在 UI 提示、不得成为普通失败路径的默认行为。（B）被否：开麦正是面试的核心场景，只报错等于完全不可用。

复现与调试工具（诊断专用，默认关闭、不输出音频内容）：

- `scripts/audio-tap.swift` 子命令：`procs [bundleId]`（进程对象 + 所在设备）、`devices`（HAL 设备清单，含 `running`/`runningSomewhere`）、`probe [--seconds=N] [--device=UID] [objectId...]`（对指定/全部对象建一次私有 tap，逐个报峰值与非零帧）、`capture-sck <bundleId>`（强制 SCK 后端用于对比）。`probe` 需要 `DREAMCODE_AUDIO_DIAG=1`；`capture-sck` 仅用于对照实验，不得接入产品路径。
- 本机模拟面试页面：本地 HTTP 服务下的页面，`getUserMedia({audio:{echoCancellation:true,echoCancellationType:'system'|'browser'},video:true})` + 页内 WebRTC 环回（振荡器经 pc1→pc2 播放 997 Hz）——`?mode=none|browser|system` 控制是否开麦及其 AEC 模式。Chrome 需 `--use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required`。

## 5. 配置

`AppConfig.voice`（`src/shared/settings.ts`，`normalizeVoiceConfig` 负责兼容旧配置）：

```ts
{
  audioAppId: string,            // 指定软件；空 = 全部系统声音
  audioAppName: string,          // 该软件不在运行时的回显名
  stt: {
    provider: 'siliconflow' | 'openai' | 'groq' | 'grok2api' | 'custom',
    apiBaseURL, apiKey, model, language, extraHeaders, proxyUrl
  },
  llmMode: 'shared' | 'custom',
  llm: ProviderConfig,
  answerPrompt: string,
  vad: { thresholdDb, silenceMs, minSpeechMs, maxSegmentMs },
  autoOpenPage: boolean
}
```

设置仍需显式点「保存」才生效；「录音测试」用的是页面上未保存的值，方便调参。

- 旧配置的兼容（`normalizeVoiceStt`）：只存了 Base URL（更早的版本没有「调用协议」字段）时，按 Base URL 匹配已知预设，匹配不上则按 `openai`（通用 OpenAI 兼容路径）处理，不会覆盖用户已填的地址与模型。

## 6. 文件清单

| 文件 | 作用 |
| --- | --- |
| `src/shared/settings.ts` | `VoiceConfig` / `VoiceSttConfig` 类型、协议预设、默认值与归一化 |
| `src/shared/voice.ts` | 运行时快照 / 命令 / 段音频 / 选中范围 IPC 类型 |
| `src/main/voice.ts` | 状态机、IPC、选中与发送语义、`setDisplayMediaRequestHandler` |
| `src/main/stt.ts` | STT 客户端（OpenAI 兼容分支 + Grok2API `/stt` 分支） |
| `src/main/app-audio.ts` | 指定应用的 helper 进程管理、重采样、静音补齐 |
| `src/main/ai.ts` | `createLanguageModel()`、`getVoiceAnswerStream()`、Provider 组复用 |
| `src/main/stream-utils.ts` | 从 shortcuts.ts 抽出的 `ThinkTagStreamFilter` / `extractErrorMessage` |
| `src/main/prompts-voice.md` | 语音解答默认系统提示词 |
| `scripts/audio-tap.swift` / `scripts/chrome-audio.swift` / `scripts/audio-support.{c,h}` | macOS 双后端入口、Chrome 身份/图生命周期、实时缓冲 |
| `scripts/build-audio-tap.sh` / `resources/bin/audio-tap.app` | universal helper 构建与 bundle 产物 |
| `scripts/test-audio-tap.sh` / `tests/native-audio.swift` | 无设备的生产原生逻辑测试 |
| `src/renderer/src/voice/audio/{capture,vad,wav}.ts` | 采集（含指定应用的 PCM 入口）、断句、WAV 编码 |
| `src/renderer/public/pcm-forwarder.worklet.js` | AudioWorklet，把音频流切成 20 ms 帧 |
| `src/renderer/src/voice/VoiceCaptureController.tsx` | 常驻桥接组件 |
| `src/renderer/src/voice/index.tsx` | 语音助手页（含选中高亮与底部操作栏） |
| `src/renderer/src/settings/VoiceSettings.tsx` | 设置页「语音助手」区块（含录音测试） |
| `src/renderer/src/lib/store/voice.ts` | renderer 侧镜像 store |

## 7. 已验证

### 7.1 基础链路（2026-09-23，macOS 13 Ventura x64，Electron 37.3.1）

用 `electron-vite dev -- --remote-debugging-port=9222` 启动，通过 CDP 调用 `window.api.*`，并用本地 mock 服务替代真实 STT / LLM 接口，验证了：

- 「系统音频」来源在 macOS 13 上可用：`getDisplayMedia` 返回 label 为 `System audio`、deviceId 为 `loopback` 的 48 kHz 音轨（无需 BlackHole）。
- 用 `say` 朗读两句英文，VAD 按句间停顿切出 3 段（1.9 s / 6.4 s / 4.9 s），每段以 multipart 上传 16 kHz 单声道 WAV，携带 `model`、`language` 与 `Authorization`。
- 「停止并发送」会等待全部识别完成再拼接问题；LLM 请求带内置语音提示词并流式回写，exchange 状态最终为 `done`。
- 「发送并继续监听」发送后保持 `listening`；「清空」清除历史与上下文。（早期版本的「取消监听（丢弃未发送内容）」已移除：停止监听不再丢弃也不再自动发送，识别内容保留在待发送区；该快捷键现改为「返回监听页面」。）
- 未配置 STT 时按快捷键会跳转语音助手页并给出明确的配置提示。

注意事项：AudioWorklet 必须以静态文件方式提供（`src/renderer/public/pcm-forwarder.worklet.js`），因为渲染进程 CSP 为 `script-src 'self'`，blob: URL 会被拒绝。

### 7.2 Grok2API 协议与断句选择（2026-09-27，同一机器）

同样用 CDP + 本地 mock 网关（不消耗真实额度、不外发 Key）验证：

- **Grok2API 请求形状**：选「Grok2API」后请求打到 `POST {baseURL}/stt`，内容为 multipart：`file=segment.wav`、`model=grok-stt`、填了 `language` 时附 `format=true`；未填 `language` 时不发 `format`（上游对 `format` 无 `language` 返回 400，已按 mock 验证两种分支）。
- **响应解析**：上游返回 `text` 时直接用 `text`；只返回词级 `words[].text`（带时间戳）时按空格拼回整句——两种情况均在页面正常出字。
- **切换协议不丢配置**：在设置页把「自定义」改选为「Grok2API」后，自建的远端 Base URL、模型、语言提示均保留，只把请求路径从 `/audio/transcriptions` 改为 `/stt`。
- **断句选择**：推入 3 段音频得到 3 行转写；`Alt+↓` 在未选中时从最新一句开始选，`Alt+↑` 往上移；`Alt+/` 只把选中的那一句发出（`exchange.question` 仅含该行，其余行保留并仍可发送）；`Alt+Shift+L` 发送其余未发送行（已发送的行被跳过且保留在列表里）。鼠标点击选中、`Shift+点击`连选、选中高亮与「已选中 N 句」提示均在页面上确认。
- **helper 失败路径**：`audio-tap list` 在本机总是超时（原因见 §4.2）；加超时后设置页直接显示「读取屏幕内容超时：请在「系统设置 → 隐私与安全性 → 屏幕录制」中允许 DreamCode，并重新打开应用后重试」，不再出现 `Command failed: ... audio-tap list`。
- **未验证**：「指定软件」真正采到声音（本机 ScreenCaptureKit 不可用，见 §4.2）、Windows 进程回环采集、真实 STT 服务的识别质量（依赖用户自己的服务商）。

## 8. 后续可选增强

- 真流式 STT provider（OpenAI Realtime / DashScope Paraformer WebSocket），逐字上屏。
- Silero VAD 替换能量 VAD，提高嘈杂环境下的断句质量。
- 把识别结果一键转成追问，喂给截图解题的对话（两条链路合并上下文）。
- 在实际 Developer ID 签名和打包启动链上复核 helper 的系统音频授权归属，避免把开发态的授权现象推广到发布版本。
