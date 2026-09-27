# 语音助手（录音辅助解答）设计说明

> 版本：1.3.0 起。本文描述新功能的目标、边界、架构、数据流与可调参数，供后续维护参考。

## 1. 目标与非目标

**目标**

- 在不影响现有截图解题功能的前提下，新增「监听会议音频 → 逐句语音识别 → 一键交给大模型解答」的能力。
- 识别与解答**全部由快捷键手动触发**：手动开始监听、手动停止并发送；不做自动触发。
- 语音识别（STT）与解答用的大模型（LLM）分别独立配置；LLM 也可以直接复用当前 Provider 组。
- 尽量接近「同声」：面试官说完一句，一两秒内文字就出现在窗口里。

**非目标**

- 不做 TTS（文字转语音）。用户描述中的「tts 模型」实际是 STT / ASR（语音识别），本功能按 STT 实现。
- 不做说话人分离（面试官 / 自己）。系统音频回环本身不包含本机麦克风，所以自己的声音默认不会进入转写。
- 不做自动触发：不根据识别文本自动发问，也不做「问句结束检测」，发什么、什么时候发完全由快捷键决定。

## 2. 用户流程

```
Alt+L ──▶ 开始监听（自动跳转语音助手页，可关闭）
            │  会议软件播放的声音被采集，按停顿切成一句句
            │  每句立即送去识别，识别结果逐行出现在「待发送内容」
            ▼
Alt+L ──▶ 停止监听并发送：所有未发送的识别文本合成一个问题 → 大模型流式回答
Alt+Shift+L ──▶ 发送并继续监听（面试官连续追问时用）
Alt+↑ / Alt+↓ ──▶ 在识别记录里上下选择断句（也可鼠标点击，Shift+点击多选）
Alt+/ ──▶ 只发送选中的断句并继续监听；未选中时发送最新一句
Alt+, ──▶ 取消监听并丢弃未发送内容
Alt+Shift+, ──▶ 清空对话（识别记录、回答、LLM 上下文）
Alt+. ──▶ 停止生成（与截图解题共用）
```

「发送全部」与「发送选中」的区别：前者把所有**尚未发送**的行拼成一个问题（已发送的行留在原处、置灰并跳过），后者只发送选中的行。发送后已发送行不会被删除，方便回看；「清空」才真正清掉。

七个新快捷键均可在设置页自定义，帮助页同步展示。

## 3. 架构

```
┌──────────── renderer ────────────┐        ┌──────────── main ────────────┐
│ VoiceCaptureController (常驻)     │        │ voice.ts  状态机 / 单一事实源  │
│  ├ 系统音频/麦克风：mediaDevices  │        │  ├ segments: 待发送转写行      │
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

设置页「音频来源」是两行单选：系统音频（可再选只监听某个软件）、输入设备。

| 来源 | 实现 | 平台说明 |
| --- | --- | --- |
| 系统音频（全部） | `getDisplayMedia({audio:true})` + main 端 `setDisplayMediaRequestHandler` 返回 `audio:'loopback'`，视频轨立即停止 | Windows 官方支持；macOS 13+ 依赖 Chromium 的 ScreenCaptureKit 回环（需「屏幕录制」权限）。回环只含系统输出，不含本机麦克风 |
| 系统音频（指定软件） | main 起原生 helper，PCM 经 IPC 回 renderer：macOS `resources/bin/audio-tap`（ScreenCaptureKit `SCContentFilter` 只包含目标应用），Windows `application-loopback`（WASAPI 进程回环，按进程树）| macOS 13+；Windows 10 2004+ x64。需要目标软件正在运行且**正在播放声音** |
| 输入设备 | `getUserMedia({deviceId})`，关闭 AEC/NS/AGC | 任意麦克风或虚拟声卡。macOS 若系统音频不可用，装 BlackHole 并把会议软件输出到它 |

### 4.1 指定软件的采集链路

```
voice:appCaptureStart(appId) ─▶ main 起 helper（macOS: audio-tap capture <bundleId>；Windows: ApplicationLoopback.exe <pid>）
helper stdout（macOS float32 / Windows PCM16 48k stereo）─▶ 重采样为 16 kHz 单声道 ─▶ SilencePadder（补齐静音，让 VAD 能收口）
─▶ voice-app-pcm ─▶ renderer Framer ─▶ 与系统音频/麦克风完全相同的 VAD → WAV → STT 链路
```

- 两端的 PCM 都归一化成 16 kHz 单声道 float32，**断句与识别只此一份实现**。
- helper 静音时完全不发包，因此 main 侧有 `SilencePadder` 按墙钟补静音，否则 VAD 永远等不到「停顿」。
- macOS helper 走 stderr 的 JSON 事件（`started` / `format` / `error`）与 main 通信；`stdin` 关闭即退出，父进程死了不会残留。
- macOS 构建：`scripts/build-audio-tap.sh` 编译 x86_64 + arm64 并 `lipo` 成通用二进制，写入 `resources/bin/audio-tap`（产物入库，CI 按宿主架构重编，见 CHANGELOG / CI 配置）。

### 4.2 macOS 上 ScreenCaptureKit 的实测限制

「指定软件」在 macOS 依赖 `SCShareableContent`（列应用）与 `SCStream`（取音频）。在本机（macOS 13.0 Ventura x64）实测：

- `audio-tap list` 几乎总是**永久挂起**，`SCShareableContent` 的四种调用形式（`current`、`excludingDesktopWindows` 的 onScreen true/false、excludingDesktopWindows true）全部不返回；十余次调用中仅成功过一次。
- 同时 `screencapture`（CoreGraphics）在同一进程链下正常出图，TCC 日志（`log show --predicate 'subsystem CONTAINS "TCC"'`）显示 `kTCCServiceScreenCapture` 请求已附权（responsible = Kaku，authValue=2），即**非权限问题**；系统里也找不到 ScreenCaptureKit 的 XPC 服务/`SCStreamAgent`（macOS 13.0 的该框架只有 `Resources` + `_CodeSignature`）。
- 结论：这是系统侧 ScreenCaptureKit 的问题（macOS 13.0 + Intel），不是本项目的代码缺陷；helper 已加 20 s 超时，超时后 stderr 输出可操作的中文提示，设置页直接展示该提示。

因此 macOS 上的降级路径是：用「全部系统声音」（回环，不依赖 `SCShareableContent`），或装 BlackHole 后改用「输入设备」。自检命令：`resources/bin/audio-tap list`（正常应在 1 s 内输出应用列表 JSON）。

## 5. 配置

`AppConfig.voice`（`src/shared/settings.ts`，`normalizeVoiceConfig` 负责兼容旧配置）：

```ts
{
  audioSource: 'system' | 'microphone',
  audioDeviceId: string,
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
| `scripts/audio-tap.swift` / `build-audio-tap.sh` / `resources/bin/audio-tap` | macOS 按应用采集 helper（源码 / 构建 / 入库的通用二进制） |
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
- 「发送并继续监听」发送后保持 `listening`；「取消」丢弃未发送段并回到 `idle`；「清空」清除历史与上下文。
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
- 若确认 macOS 上 SCK 挂起来自「非 bundle 的 helper 进程」，可把 `audio-tap` 包成带 Info.plist 的 `.app`（独立 bundle id + 自己的屏幕录制授权）再试。
