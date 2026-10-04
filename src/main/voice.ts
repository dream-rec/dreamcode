import { desktopCapturer, ipcMain, session } from 'electron'
import type { ModelMessage } from 'ai'
import {
  VOICE_HISTORY_EXCHANGES,
  VOICE_MAX_EXCHANGES,
  VOICE_MAX_SEGMENTS,
  type TranscriptSegment,
  type TranscriptSelection,
  type VoiceCaptureCommand,
  type VoiceExchange,
  type VoiceSegmentPayload,
  type VoiceSnapshot
} from '../shared/voice'
import { normalizeVoiceConfig, type VoiceSttConfig } from '../shared/settings'
import { settings, onCaptureTargetChange } from './settings'
import { getVoiceAnswerStream, getVoiceProviderConfig } from './ai'
import { transcribeAudio } from './stt'
import { ThinkTagStreamFilter, extractErrorMessage } from './stream-utils'
import {
  ensureCapturePermission,
  listAudioApps,
  startAppCapture,
  type AppCapture
} from './app-audio'

/**
 * Voice assistant state machine (single source of truth lives here).
 *
 *   renderer capture ──segments──▶ main STT ──text──▶ pending transcript
 *   shortcut "stop & send" / "send now" ──▶ pending transcript ──▶ LLM stream ──▶ renderer
 *   shortcut "select prev/next" + "send selected" ──▶ chosen lines only ──▶ LLM stream
 *
 * Per-app capture: the renderer asks main to spawn a native helper (see app-audio.ts) and
 * receives its PCM over IPC, so VAD/segmenting stays in one place for every source.
 */

type AbortReason = 'user' | 'new-request'

interface AnswerContext {
  controller: AbortController
  reason: AbortReason | null
  exchangeId: string
}

const snapshot: VoiceSnapshot = {
  captureState: 'idle',
  answering: false,
  segments: [],
  selection: null,
  exchanges: [],
  error: null,
  captureNotice: null
}

let conversation: ModelMessage[] = []
let currentAnswer: AnswerContext | null = null
const pendingTranscriptions = new Map<number, Promise<void>>()
let requestCounter = 0
let segmentCounter = 0
let sendGeneration = 0
let activeCaptureId: string | null = null
let captureLease: { id: string; owner: 'voice' | 'test' } | null = null
let retiringCapture: Promise<void> | null = null
let startTimer: ReturnType<typeof setTimeout> | null = null
/** Resolvers for capture commands that need a renderer acknowledgement. */
const pendingAcks = new Map<string, () => void>()

function getMainWindow() {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return null
  return mainWindow
}

/** Drops a selection whose lines were discarded (empty transcription, cleared, trimmed). */
function normalizeSelection() {
  const selection = snapshot.selection
  if (!selection) return
  const hasLine = (seq: number) => snapshot.segments.some((segment) => segment.seq === seq)
  if (!hasLine(selection.anchor) || !hasLine(selection.focus)) snapshot.selection = null
}

function broadcast() {
  normalizeSelection()
  const mainWindow = getMainWindow()
  if (!mainWindow) return
  mainWindow.webContents.send('voice-state', structuredClone(snapshot))
}

function setError(message: string | null) {
  snapshot.error = message
  broadcast()
}

function nextRequestId(prefix: string) {
  requestCounter += 1
  return `${prefix}-${Date.now()}-${requestCounter}`
}

function sendCaptureCommand(command: VoiceCaptureCommand) {
  const mainWindow = getMainWindow()
  if (!mainWindow) return false
  mainWindow.webContents.send('voice-capture-command', command)
  return true
}

function waitForAck(requestId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAcks.delete(requestId)
      resolve(false)
    }, timeoutMs)
    pendingAcks.set(requestId, () => {
      clearTimeout(timer)
      pendingAcks.delete(requestId)
      resolve(true)
    })
  })
}

function resolveAck(requestId: string) {
  pendingAcks.get(requestId)?.()
}

function getSttConfigError(config: VoiceSttConfig): string | null {
  if (!config.apiBaseURL.trim()) return '请先在设置中填写语音识别 Base URL'
  if (!config.apiKey.trim()) return '请先在设置中填写语音识别 API Key'
  if (!config.model.trim()) return '请先在设置中填写语音识别模型'
  return null
}

// ---------------------------------------------------------------------------
// Listening lifecycle
// ---------------------------------------------------------------------------

export function startListening(): boolean {
  if (retiringCapture || snapshot.captureState !== 'idle') return false
  const mainWindow = getMainWindow()
  if (!mainWindow) return false
  if (captureLease) {
    setError('录音测试仍在运行，请先停止测试再开始监听')
    return false
  }
  const voice = settings.voice
  const configError = getSttConfigError(voice.stt)
  if (configError) {
    setError(configError)
    return false
  }
  const id = nextRequestId('capture')
  activeCaptureId = id
  captureLease = { id, owner: 'voice' }
  snapshot.captureState = 'starting'
  snapshot.error = null
  snapshot.captureNotice = null
  broadcast()
  if (voice.autoOpenPage) mainWindow.webContents.send('navigate-voice-page')
  startTimer = setTimeout(() => {
    if (activeCaptureId !== id || snapshot.captureState !== 'starting') return
    void retireCapture()
      .then(() => setError('音频采集启动超时，请检查目标应用和权限后重试'))
      .catch((error: unknown) => setError(extractErrorMessage(error)))
  }, 55_000)
  if (
    !sendCaptureCommand({
      type: 'start',
      sessionId: id,
      requestId: id,
      config: {
        source: voice.audioSource,
        appId: voice.audioAppId,
        vad: { ...voice.vad }
      }
    })
  ) {
    void retireCapture().catch((error: unknown) => setError(extractErrorMessage(error)))
    return false
  }
  return true
}

async function stopListening(discard: boolean): Promise<void> {
  if (retiringCapture) return retiringCapture
  const id = activeCaptureId
  if (!id) return
  snapshot.captureState = 'stopping'
  if (startTimer) clearTimeout(startTimer)
  startTimer = null
  broadcast()
  const requestId = nextRequestId('stop')
  const ack = waitForAck(requestId, 5000)
  if (!sendCaptureCommand({ type: 'stop', sessionId: id, requestId, discard }))
    resolveAck(requestId)
  retiringCapture = (async () => {
    await stopAppCapture(id)
    const acknowledged = await ack
    if (activeCaptureId === id) {
      if (!acknowledged) {
        setError('采集停止确认超时，请再次保存或取消监听重试')
        throw new Error('采集停止确认超时，尚未确认旧音源已释放')
      }
      activeCaptureId = null
      if (captureLease?.id === id) captureLease = null
      snapshot.captureState = 'idle'
      snapshot.captureNotice = null
      if (discard) {
        snapshot.segments = []
        snapshot.selection = null
        pendingTranscriptions.clear()
      }
      broadcast()
    }
  })().finally(() => {
    retiringCapture = null
  })
  return retiringCapture
}

/** Changing a target retires capture, not the transcript or answer history. */
async function retireCapture(): Promise<void> {
  sendGeneration++
  if (activeCaptureId) {
    await stopListening(false)
  } else if (captureLease) {
    const id = captureLease.id
    getMainWindow()?.webContents.send('voice-app-ended', {
      id,
      reason: '音频目标已更改，请重新开始测试'
    })
    await stopAppCapture(id)
    if (captureLease?.id === id) captureLease = null
  }
}

onCaptureTargetChange(retireCapture)

/** Shortcut: idle → start listening; listening → stop listening and send the transcript. */
export async function toggleListening(): Promise<void> {
  if (snapshot.captureState === 'idle') {
    startListening()
    return
  }
  if (snapshot.captureState === 'stopping' && !retiringCapture) {
    await stopListening(false)
    return
  }
  if (snapshot.captureState === 'listening') {
    const generation = ++sendGeneration
    await stopListening(false)
    await sendPendingTranscript(generation)
  }
}

/** Shortcut: send whatever has been transcribed so far but keep listening. */
export async function sendNow(): Promise<void> {
  if (snapshot.captureState === 'starting' || snapshot.captureState === 'stopping') return
  const generation = ++sendGeneration
  if (snapshot.captureState === 'listening') {
    const requestId = nextRequestId('flush')
    const ackPromise = waitForAck(requestId, 3000)
    if (!sendCaptureCommand({ type: 'flush', sessionId: activeCaptureId ?? '', requestId }))
      resolveAck(requestId)
    const acknowledged = await ackPromise
    if (generation !== sendGeneration) return
    if (!acknowledged) {
      setError('音频分段确认超时，请重试发送')
      return
    }
  }
  await sendPendingTranscript(generation)
}

/** Shortcut: stop listening and throw away the un-sent transcript. */
export async function cancelListening(): Promise<void> {
  sendGeneration++
  if (snapshot.captureState === 'idle') {
    if (snapshot.segments.length) {
      snapshot.segments = []
      broadcast()
    }
    return
  }
  await stopListening(true)
}

/** Clears transcript, answers and LLM conversation history (listening state is untouched). */
export function clearSession(): void {
  sendGeneration++
  abortAnswer('user')
  snapshot.segments = []
  snapshot.selection = null
  snapshot.exchanges = []
  snapshot.error = null
  conversation = []
  pendingTranscriptions.clear()
  broadcast()
}

export function isListening(): boolean {
  return snapshot.captureState === 'listening' || snapshot.captureState === 'starting'
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

function upsertSegment(segment: TranscriptSegment) {
  const index = snapshot.segments.findIndex((item) => item.seq === segment.seq)
  if (index >= 0) {
    snapshot.segments[index] = segment
  } else {
    snapshot.segments.push(segment)
    snapshot.segments.sort((a, b) => a.seq - b.seq)
    if (snapshot.segments.length > VOICE_MAX_SEGMENTS) {
      snapshot.segments = snapshot.segments.slice(-VOICE_MAX_SEGMENTS)
    }
  }
  broadcast()
}

async function handleSegment(payload: VoiceSegmentPayload): Promise<void> {
  const seq = ++segmentCounter
  const segment: TranscriptSegment = {
    seq,
    startedAt: payload.startedAt,
    durationMs: payload.durationMs,
    text: '',
    status: 'pending'
  }
  upsertSegment(segment)

  const wav = payload.wav instanceof Uint8Array ? payload.wav : new Uint8Array(payload.wav)
  const job = transcribeAudio(wav, settings.voice.stt)
    .then((text) => {
      const current = snapshot.segments.find((item) => item.seq === seq)
      if (!current) return // discarded meanwhile
      if (!text) {
        // Silence / noise recognised as nothing: drop the line rather than show an empty row.
        snapshot.segments = snapshot.segments.filter((item) => item.seq !== seq)
        broadcast()
        return
      }
      upsertSegment({ ...current, text, status: 'done' })
    })
    .catch((error) => {
      const current = snapshot.segments.find((item) => item.seq === seq)
      if (!current) return
      console.error('Voice transcription failed:', error)
      upsertSegment({ ...current, status: 'error', error: extractErrorMessage(error) })
    })
    .finally(() => {
      pendingTranscriptions.delete(seq)
    })
  pendingTranscriptions.set(seq, job)
  await job
}

async function waitForTranscriptions(seqs: Set<number>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 50_000)
  })
  const jobs = [...seqs]
    .map((seq) => pendingTranscriptions.get(seq))
    .filter((job) => job !== undefined)
  try {
    await Promise.race([Promise.allSettled(jobs), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// LLM answer
// ---------------------------------------------------------------------------

function abortAnswer(reason: AbortReason) {
  if (!currentAnswer) return
  currentAnswer.reason = reason
  currentAnswer.controller.abort()
}

export function stopAnswer(): boolean {
  if (!currentAnswer) return false
  abortAnswer('user')
  return true
}

function isSendable(segment: TranscriptSegment): boolean {
  return segment.status === 'done' && !!segment.text.trim()
}

function buildQuestion(segments: TranscriptSegment[]): string {
  return segments
    .filter(isSendable)
    .map((segment) => segment.text.trim())
    .join('\n')
}

/** Sends every line not sent yet, then starts a fresh transcript. */
async function sendPendingTranscript(generation: number): Promise<void> {
  if (generation !== sendGeneration) return
  const batch = new Set(
    snapshot.segments.filter((segment) => !segment.sent).map((segment) => segment.seq)
  )
  await waitForTranscriptions(batch)
  if (generation !== sendGeneration) return
  const segments = snapshot.segments.filter((segment) => batch.has(segment.seq) && !segment.sent)
  const sendable = segments.filter(isSendable)
  const question = buildQuestion(sendable)
  if (!question) {
    const hasErrors = segments.some((segment) => segment.status === 'error')
    setError(hasErrors ? '语音识别失败，未获得可用文本' : '没有识别到内容，请重新监听')
    snapshot.segments = snapshot.segments.filter(
      (segment) => !batch.has(segment.seq) || segment.status === 'pending'
    )
    broadcast()
    return
  }
  const sent = new Set(sendable.map((segment) => segment.seq))
  snapshot.segments = snapshot.segments.filter((segment) => !sent.has(segment.seq))
  normalizeSelection()
  await askLlm(question)
}

// ---------------------------------------------------------------------------
// Line selection ("send only this sentence")
// ---------------------------------------------------------------------------

function selectedSegments(): TranscriptSegment[] {
  const selection = snapshot.selection
  if (!selection) return []
  const anchorIndex = snapshot.segments.findIndex((segment) => segment.seq === selection.anchor)
  const focusIndex = snapshot.segments.findIndex((segment) => segment.seq === selection.focus)
  if (anchorIndex < 0 || focusIndex < 0) return []
  const [from, to] =
    anchorIndex <= focusIndex ? [anchorIndex, focusIndex] : [focusIndex, anchorIndex]
  return snapshot.segments.slice(from, to + 1)
}

/** Mouse: plain click selects one line (click again to deselect), shift+click extends. */
export function selectSegment(seq: number, extend: boolean): void {
  if (!snapshot.segments.some((segment) => segment.seq === seq)) return
  const current = snapshot.selection
  let next: TranscriptSelection | null
  if (extend && current) {
    next = { anchor: current.anchor, focus: seq }
  } else if (current && current.anchor === seq && current.focus === seq) {
    next = null
  } else {
    next = { anchor: seq, focus: seq }
  }
  snapshot.selection = next
  broadcast()
}

/**
 * Shortcut: move the selection one line up (-1) or down (+1) among recognised lines.
 * With nothing selected either direction starts at the newest line, which is what you
 * usually want right after the interviewer finishes a question.
 */
export function moveSelection(delta: -1 | 1): void {
  const candidates = snapshot.segments.filter(isSendable)
  if (!candidates.length) return
  const focus = snapshot.selection?.focus
  const index = focus === undefined ? -1 : candidates.findIndex((segment) => segment.seq === focus)
  let nextIndex: number
  if (index < 0) {
    nextIndex = candidates.length - 1
  } else {
    nextIndex = Math.min(candidates.length - 1, Math.max(0, index + delta))
  }
  const seq = candidates[nextIndex].seq
  snapshot.selection = { anchor: seq, focus: seq }
  broadcast()
}

export function clearSelection(): void {
  if (!snapshot.selection) return
  snapshot.selection = null
  broadcast()
}

/**
 * Shortcut: send only the selected lines (the newest line when nothing is selected) and
 * keep listening. Sent lines stay visible, marked as sent, and are skipped by later
 * "send all" actions.
 */
export async function sendSelected(): Promise<void> {
  sendGeneration++
  let chosen = selectedSegments()
  if (!chosen.length) {
    const latest = snapshot.segments.filter(isSendable).at(-1)
    chosen = latest ? [latest] : []
  }
  const question = buildQuestion(chosen)
  if (!question) {
    setError('没有可发送的断句：请等识别完成后再选择')
    return
  }
  const chosenSeqs = new Set(chosen.map((segment) => segment.seq))
  snapshot.segments = snapshot.segments.map((segment) =>
    chosenSeqs.has(segment.seq) ? { ...segment, sent: true } : segment
  )
  snapshot.selection = null
  await askLlm(question)
}

async function askLlm(question: string): Promise<void> {
  const mainWindow = getMainWindow()
  if (!mainWindow) return

  const providerConfig = getVoiceProviderConfig()
  if (!providerConfig.apiKey || !providerConfig.model) {
    setError(
      settings.voice.llmMode === 'custom'
        ? '请先在设置中配置语音助手使用的大模型'
        : '当前 Provider 组未配置 API Key 或模型'
    )
    return
  }

  abortAnswer('new-request')
  const exchange: VoiceExchange = {
    id: nextRequestId('exchange'),
    askedAt: Date.now(),
    question,
    answer: '',
    status: 'streaming'
  }
  snapshot.exchanges.push(exchange)
  if (snapshot.exchanges.length > VOICE_MAX_EXCHANGES) {
    snapshot.exchanges = snapshot.exchanges.slice(-VOICE_MAX_EXCHANGES)
  }
  snapshot.answering = true
  snapshot.error = null
  broadcast()

  const context: AnswerContext = {
    controller: new AbortController(),
    reason: null,
    exchangeId: exchange.id
  }
  currentAnswer = context

  const history = conversation.slice(-VOICE_HISTORY_EXCHANGES * 2)
  const messages: ModelMessage[] = [...history, { role: 'user', content: question }]
  const filter = new ThinkTagStreamFilter()
  let answer = ''

  const pushChunk = (chunk: string) => {
    if (!chunk) return
    answer += chunk
    exchange.answer = answer
    mainWindow.webContents.send('voice-answer-chunk', { id: exchange.id, chunk })
  }

  try {
    const stream = getVoiceAnswerStream(messages, context.controller.signal)
    for await (const chunk of stream) {
      if (context.controller.signal.aborted) break
      pushChunk(filter.push(chunk))
    }
    if (!context.controller.signal.aborted) pushChunk(filter.finish())

    if (context.controller.signal.aborted) {
      exchange.status = 'stopped'
    } else {
      exchange.status = 'done'
      conversation.push({ role: 'user', content: question })
      if (answer) conversation.push({ role: 'assistant', content: answer })
    }
  } catch (error) {
    if (context.controller.signal.aborted) {
      exchange.status = 'stopped'
    } else {
      console.error('Voice answer failed:', error)
      exchange.status = 'error'
      exchange.error = extractErrorMessage(error)
    }
  } finally {
    if (currentAnswer === context) {
      currentAnswer = null
      snapshot.answering = false
    }
    broadcast()
  }
}

// ---------------------------------------------------------------------------
// IPC + display-media handler
// ---------------------------------------------------------------------------

export function initVoice(): void {
  // getDisplayMedia() in the renderer is how Chromium exposes system-audio loopback.
  // We only need the audio track; the renderer stops the video track immediately.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .then((sources) => {
        const source = sources[0]
        if (!source) {
          callback(null as unknown as Electron.Streams)
          return
        }
        callback({ video: source, audio: 'loopback' })
      })
      .catch((error) => {
        console.error('Display media request failed:', error)
        callback(null as unknown as Electron.Streams)
      })
  })
}

ipcMain.handle('voice:getSnapshot', () => structuredClone(snapshot))
ipcMain.handle('voice:toggleListening', () => toggleListening())
ipcMain.handle('voice:sendNow', () => sendNow())
ipcMain.handle('voice:cancel', () => cancelListening())
ipcMain.handle('voice:clearSession', () => clearSession())
ipcMain.handle('voice:stopAnswer', () => stopAnswer())
ipcMain.handle('voice:dismissError', () => setError(null))
ipcMain.handle('voice:selectSegment', (_event, seq: number, extend: boolean) =>
  selectSegment(seq, extend)
)
ipcMain.handle('voice:moveSelection', (_event, delta: -1 | 1) => moveSelection(delta))
ipcMain.handle('voice:clearSelection', () => clearSelection())
ipcMain.handle('voice:sendSelected', () => sendSelected())

// ---- Per-application capture (native helper → PCM over IPC) ----

let appCapture: { id: string; controller: AbortController; promise: Promise<AppCapture> } | null =
  null

async function stopAppCapture(id?: string): Promise<void> {
  const current = appCapture
  if (!current || (id !== undefined && current.id !== id)) return
  current.controller.abort()
  try {
    await (await current.promise).stop()
  } catch {
    /* Cancelled startup has already cleaned up. */
  }
  if (appCapture === current) appCapture = null
}

ipcMain.handle('voice:listAudioApps', () => listAudioApps())
ipcMain.handle('voice:ensureCapturePermission', () => ensureCapturePermission())
ipcMain.handle('voice:reserveCapture', (_event, id: string, owner: 'voice' | 'test') => {
  if (!id || (owner !== 'voice' && owner !== 'test')) throw new Error('无效的采集会话')
  if (retiringCapture) throw new Error('旧采集正在停止，请稍后重试')
  if (owner === 'voice' && id !== activeCaptureId) throw new Error('监听启动已失效')
  if (owner === 'test' && snapshot.captureState !== 'idle')
    throw new Error('请先停止正式监听，再进行录音测试')
  if (captureLease && captureLease.id !== id) throw new Error('另一个录音会话正在运行，请先停止它')
  captureLease = { id, owner }
})
ipcMain.handle('voice:releaseCapture', async (_event, id: string) => {
  await stopAppCapture(id)
  if (captureLease?.id === id) captureLease = null
})
ipcMain.handle('voice:appCaptureStart', async (event, appId: string, id: string): Promise<void> => {
  if (captureLease?.id !== id || retiringCapture) throw new Error('音频采集会话已失效')
  if (appCapture) throw new Error('旧应用采集尚未结束，请稍后重试')
  const controller = new AbortController()
  const sender = event.sender
  const promise = startAppCapture(
    appId,
    {
      onPcm: (samples) => {
        if (captureLease?.id === id && !controller.signal.aborted && !sender.isDestroyed()) {
          sender.send('voice-app-pcm', { id, samples })
        }
      },
      onEnded: (reason) => {
        if (captureLease?.id === id && !controller.signal.aborted && !sender.isDestroyed()) {
          sender.send('voice-app-ended', { id, reason })
        }
      },
      onFallback: () => {
        // 目标应用开麦进入双工后，helper 已切换为系统声音采集；这是行为提示，不是错误。
        if (
          captureLease?.id === id &&
          captureLease?.owner === 'voice' &&
          !controller.signal.aborted
        ) {
          snapshot.captureNotice =
            '目标应用正在使用麦克风，已切换为采集全部系统声音（可能包含其他应用的声音）'
          broadcast()
        }
      }
    },
    controller.signal
  )
  const current = { id, controller, promise }
  appCapture = current
  try {
    const capture = await promise
    if (captureLease?.id !== id || controller.signal.aborted) {
      await capture.stop()
      throw new Error('音频采集启动已取消')
    }
  } catch (error) {
    if (appCapture === current) appCapture = null
    throw error
  }
})
ipcMain.handle('voice:appCaptureStop', (_event, id: string) => stopAppCapture(id))

ipcMain.handle('voice:captureStarted', (_event, id: string) => {
  if (activeCaptureId !== id || snapshot.captureState !== 'starting') return
  if (startTimer) clearTimeout(startTimer)
  startTimer = null
  snapshot.captureState = 'listening'
  broadcast()
})
ipcMain.handle('voice:captureStopped', (_event, id: string, requestId: string) => {
  if (activeCaptureId === id) resolveAck(requestId)
})
ipcMain.handle('voice:flushed', (_event, id: string, requestId: string) => {
  if (activeCaptureId === id) resolveAck(requestId)
})
ipcMain.handle('voice:captureError', async (_event, id: string, message: string) => {
  if (activeCaptureId !== id || snapshot.captureState === 'stopping') return
  if (startTimer) clearTimeout(startTimer)
  startTimer = null
  await stopAppCapture(id)
  if (activeCaptureId !== id) return
  activeCaptureId = null
  if (captureLease?.id === id) captureLease = null
  snapshot.captureState = 'idle'
  snapshot.captureNotice = null
  setError(message)
})
ipcMain.handle('voice:pushSegment', (_event, payload: VoiceSegmentPayload) => {
  if (payload.sessionId === activeCaptureId) void handleSegment(payload)
})

/** Settings-page helper: transcribe a clip with a not-yet-saved config. */
ipcMain.handle(
  'voice:testTranscribe',
  async (_event, rawConfig: unknown, wav: Uint8Array): Promise<string> => {
    const config = normalizeVoiceConfig(rawConfig).stt
    const configError = getSttConfigError(config)
    if (configError) throw new Error(configError)
    const data = wav instanceof Uint8Array ? wav : new Uint8Array(wav)
    return transcribeAudio(data, config)
  }
)
