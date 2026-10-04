import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioLines, Check, Eye, EyeOff, RefreshCw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { isMac, isWindows } from '@/lib/utils/env'
import { LevelMeter } from '@/voice/LevelMeter'
import { AudioCaptureSession, CAPTURE_SAMPLE_RATE } from '@/voice/audio/capture'
import { encodeWav, floatToPcm16 } from '@/voice/audio/wav'
import {
  VOICE_STT_PROVIDERS,
  type ProviderConfig,
  type VoiceConfig,
  type VoiceSttProvider
} from '../../../shared/settings'
import type { AudioApp } from '../../../shared/voice'

interface VoiceSettingsProps {
  value: VoiceConfig
  onChange: (next: VoiceConfig) => void
}

/** Per-app output capture requires a native helper (macOS 13+ or Win10 2004+). */
const APP_CAPTURE_SUPPORTED = isMac || isWindows

const selectClassName =
  'flex-1 min-w-0 h-9 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 text-sm'

function describeIpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

const TEST_DURATION_MS = 8000

type TestLine = { id: number; status: 'pending' | 'done' | 'error'; text: string }

export function VoiceSettings({ value, onChange }: VoiceSettingsProps) {
  const [showSttKey, setShowSttKey] = useState(false)
  const [showLlmKey, setShowLlmKey] = useState(false)
  const [apps, setApps] = useState<AudioApp[]>([])
  const [appsLoading, setAppsLoading] = useState(false)
  const [appsError, setAppsError] = useState<string | null>(null)

  const update = (changes: Partial<VoiceConfig>) => onChange({ ...value, ...changes })
  const updateStt = (changes: Partial<VoiceConfig['stt']>) =>
    update({ stt: { ...value.stt, ...changes } })
  const updateVad = (changes: Partial<VoiceConfig['vad']>) =>
    update({ vad: { ...value.vad, ...changes } })
  const updateLlm = (changes: Partial<ProviderConfig>) =>
    update({ llm: { ...value.llm, ...changes } })

  const refreshApps = useCallback(async (): Promise<boolean> => {
    if (!APP_CAPTURE_SUPPORTED) return false
    setAppsLoading(true)
    setAppsError(null)
    try {
      setApps(await window.api.voiceListAudioApps())
      return true
    } catch (error) {
      setAppsError(describeIpcError(error))
      return false
    } finally {
      setAppsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshApps()
  }, [refreshApps])

  const selectApp = (appId: string) => {
    const app = apps.find((item) => item.id === appId)
    update({
      audioSource: 'system',
      audioAppId: appId,
      audioAppName: app?.name ?? (appId ? value.audioAppName : '')
    })
  }

  const selectSttProvider = (provider: VoiceSttProvider) => {
    const preset = VOICE_STT_PROVIDERS.find((item) => item.id === provider)
    // Only replace fields that are empty or still hold another preset's default, so a
    // self-hosted gateway URL / custom model survives switching the protocol.
    const isDefault = (field: 'apiBaseURL' | 'model') => {
      const current = value.stt[field].trim()
      return !current || VOICE_STT_PROVIDERS.some((item) => item[field] === current)
    }
    updateStt({
      provider,
      ...(preset?.apiBaseURL && isDefault('apiBaseURL') ? { apiBaseURL: preset.apiBaseURL } : {}),
      ...(preset?.model && isDefault('model') ? { model: preset.model } : {})
    })
  }

  const sttPreset = VOICE_STT_PROVIDERS.find((item) => item.id === value.stt.provider)
  const savedAppMissing = !!value.audioAppId && !apps.some((app) => app.id === value.audioAppId)

  return (
    <div className="bg-white/60 dark:bg-gray-800/60 backdrop-blur-sm rounded-xl p-6 border border-gray-200/50 dark:border-gray-700/50 space-y-6">
      <div>
        <h2 className="text-lg font-semibold flex items-center">
          <AudioLines className="h-5 w-5 mr-2" />
          语音助手
        </h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          监听会议软件的声音，按停顿逐句转成文字（语音识别，STT），按快捷键把识别结果交给大模型解答。全程手动触发。
        </p>
      </div>

      {/* Audio source */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium">音频来源</h3>
        <div className="rounded-md border border-gray-300 dark:border-gray-600 divide-y divide-gray-200 dark:divide-gray-700 overflow-hidden">
          <OutputSourceRow
            control={
              <>
                <select
                  id="voice-output-target"
                  className={selectClassName}
                  value={value.audioAppId}
                  disabled={!APP_CAPTURE_SUPPORTED}
                  onChange={(event) => selectApp(event.target.value)}
                >
                  <option value="">全部系统声音</option>
                  {savedAppMissing && (
                    <option value={value.audioAppId}>
                      {value.audioAppName || value.audioAppId}（未运行）
                    </option>
                  )}
                  {apps.map((app) => (
                    <option key={app.id} value={app.id}>
                      {app.name}
                    </option>
                  ))}
                </select>
                <RefreshButton
                  title="刷新正在运行的软件列表"
                  loading={appsLoading}
                  disabled={!APP_CAPTURE_SUPPORTED}
                  onClick={refreshApps}
                />
              </>
            }
            error={appsError}
          />
        </div>
      </section>

      {/* STT */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium">语音识别服务</h3>
        <Field label="调用协议">
          <select
            className={selectClassName}
            value={value.stt.provider}
            onChange={(event) => selectSttProvider(event.target.value as VoiceSttProvider)}
          >
            {VOICE_STT_PROVIDERS.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="API Base URL">
          <Input
            value={value.stt.apiBaseURL}
            placeholder={sttPreset?.apiBaseURL || 'https://your-gateway.example.com/v1'}
            onChange={(event) => updateStt({ apiBaseURL: event.target.value })}
          />
        </Field>
        <Field label="API Key">
          <div className="flex flex-1">
            <Input
              type={showSttKey ? 'text' : 'password'}
              value={value.stt.apiKey}
              placeholder={value.stt.provider === 'grok2api' ? 'g2a_...' : undefined}
              onChange={(event) => updateStt({ apiKey: event.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-1 shrink-0"
              onClick={() => setShowSttKey((visible) => !visible)}
            >
              {showSttKey ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </Button>
          </div>
        </Field>
        <Field label="识别模型">
          <Input
            value={value.stt.model}
            placeholder={sttPreset?.model || 'whisper-1 / gpt-4o-mini-transcribe'}
            onChange={(event) => updateStt({ model: event.target.value })}
          />
        </Field>
        <Field label="语言提示" hint="可选，如 zh / en；留空自动识别">
          <Input
            value={value.stt.language}
            placeholder="zh"
            onChange={(event) => updateStt({ language: event.target.value })}
          />
        </Field>
        <Field label="额外请求头">
          <Textarea
            value={value.stt.extraHeaders}
            placeholder='JSON，如 {"x-api-key":"your-key"}'
            rows={2}
            className="flex-1 font-mono text-xs"
            onChange={(event) => updateStt({ extraHeaders: event.target.value })}
          />
        </Field>
        <Field label="代理地址">
          <Input
            value={value.stt.proxyUrl}
            placeholder="http://127.0.0.1:7890"
            onChange={(event) => updateStt({ proxyUrl: event.target.value })}
          />
        </Field>
      </section>

      {/* VAD */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium">断句检测</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          音量超过阈值视为有人说话；停顿超过「静音时长」就把这一句送去识别。用下方录音测试观察电平条来调阈值。
        </p>
        <SliderRow
          label="触发阈值"
          display={`${value.vad.thresholdDb} dBFS`}
          min={-80}
          max={-20}
          step={1}
          value={value.vad.thresholdDb}
          onChange={(thresholdDb) => updateVad({ thresholdDb })}
        />
        <SliderRow
          label="静音时长（断句）"
          display={`${value.vad.silenceMs} ms`}
          min={300}
          max={3000}
          step={50}
          value={value.vad.silenceMs}
          onChange={(silenceMs) => updateVad({ silenceMs })}
        />
        <SliderRow
          label="最短语音"
          display={`${value.vad.minSpeechMs} ms`}
          min={50}
          max={1000}
          step={50}
          value={value.vad.minSpeechMs}
          onChange={(minSpeechMs) => updateVad({ minSpeechMs })}
        />
        <SliderRow
          label="单段最长"
          display={`${(value.vad.maxSegmentMs / 1000).toFixed(0)} s`}
          min={5000}
          max={60000}
          step={1000}
          value={value.vad.maxSegmentMs}
          onChange={(maxSegmentMs) => updateVad({ maxSegmentMs })}
        />
        <CaptureTest config={value} />
      </section>

      {/* LLM */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium">解答模型</h3>
        <div className="flex rounded-md overflow-hidden border border-gray-300 dark:border-gray-600">
          {(
            [
              ['shared', '复用当前 Provider 组'],
              ['custom', '单独配置']
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={`flex-1 py-2 text-sm font-medium ${value.llmMode === mode ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900' : 'bg-white text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}
              onClick={() => update({ llmMode: mode })}
            >
              {label}
            </button>
          ))}
        </div>
        {value.llmMode === 'custom' && (
          <div className="space-y-3">
            <div className="flex rounded-md overflow-hidden border border-gray-300 dark:border-gray-600">
              {(['openai', 'anthropic'] as const).map((provider) => (
                <button
                  key={provider}
                  type="button"
                  className={`flex-1 py-1.5 text-sm ${value.llm.apiProvider === provider ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900' : 'bg-white text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}
                  onClick={() => updateLlm({ apiProvider: provider })}
                >
                  {provider === 'openai' ? 'OpenAI 兼容' : 'Claude'}
                </button>
              ))}
            </div>
            <Field label="API Base URL">
              <Input
                value={value.llm.apiBaseURL}
                onChange={(event) => updateLlm({ apiBaseURL: event.target.value })}
              />
            </Field>
            <Field label="API Key">
              <div className="flex flex-1">
                <Input
                  type={showLlmKey ? 'text' : 'password'}
                  value={value.llm.apiKey}
                  onChange={(event) => updateLlm({ apiKey: event.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="ml-1 shrink-0"
                  onClick={() => setShowLlmKey((visible) => !visible)}
                >
                  {showLlmKey ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </Button>
              </div>
            </Field>
            <Field label="额外请求头">
              <Textarea
                value={value.llm.extraHeaders}
                placeholder='JSON，如 {"x-api-key":"your-key"}'
                rows={2}
                className="flex-1 font-mono text-xs"
                onChange={(event) => updateLlm({ extraHeaders: event.target.value })}
              />
            </Field>
            <Field label="Model">
              <Input
                value={value.llm.model}
                onChange={(event) => updateLlm({ model: event.target.value })}
              />
            </Field>
            <Field label="代理地址">
              <Input
                value={value.llm.proxyUrl}
                onChange={(event) => updateLlm({ proxyUrl: event.target.value })}
              />
            </Field>
          </div>
        )}
        <Textarea
          value={value.answerPrompt}
          onChange={(event) => update({ answerPrompt: event.target.value })}
          placeholder="留空使用内置的面试口述回答提示词；填写后完全替换"
          rows={5}
        />
      </section>

      <section className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">开始监听时自动跳转到语音助手页</div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            关闭后可以留在记忆卡片等页面，稍后手动进入查看
          </p>
        </div>
        <Switch
          checked={value.autoOpenPage}
          onCheckedChange={(checked) => update({ autoOpenPage: checked })}
        />
      </section>
    </div>
  )
}

function OutputSourceRow({ control, error }: { control: React.ReactNode; error?: string | null }) {
  return (
    <div className="px-3 py-2.5 space-y-1.5 bg-gray-100/80 dark:bg-gray-700/60">
      <div className="flex items-center gap-3">
        <label htmlFor="voice-output-target" className="w-24 shrink-0 text-sm font-medium">
          输出音频
        </label>
        <div className="flex flex-1 min-w-0 items-center gap-2">{control}</div>
      </div>
      {error && <p className="pl-[6.75rem] text-xs text-red-400 break-words">{error}</p>}
    </div>
  )
}

const REFRESH_MIN_BUSY_MS = 450
const REFRESH_DONE_MS = 1500

/**
 * 刷新按钮：IPC 常常几毫秒就返回，因此保证一个最短忙碌时长让动效可见，
 * 成功后短暂显示「已刷新」，失败由调用方的错误文案表达。
 */
function RefreshButton({
  title,
  loading,
  disabled,
  onClick
}: {
  title: string
  loading?: boolean
  disabled?: boolean
  onClick: () => boolean | void | Promise<boolean | void>
}) {
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done'>('idle')
  const running = useRef(false)
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busy = loading || phase === 'busy'

  useEffect(
    () => () => {
      if (doneTimer.current) clearTimeout(doneTimer.current)
    },
    []
  )

  const run = async (): Promise<void> => {
    if (disabled || running.current) return
    running.current = true
    if (doneTimer.current) {
      clearTimeout(doneTimer.current)
      doneTimer.current = null
    }
    setPhase('busy')
    const startedAt = Date.now()
    let ok = true
    try {
      ok = (await onClick()) !== false
    } catch {
      ok = false
    }
    const remaining = REFRESH_MIN_BUSY_MS - (Date.now() - startedAt)
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
    running.current = false
    setPhase(ok ? 'done' : 'idle')
    if (ok) doneTimer.current = setTimeout(() => setPhase('idle'), REFRESH_DONE_MS)
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0 justify-center min-w-[5.5rem]"
      disabled={disabled || busy}
      onClick={() => void run()}
      title={title}
      aria-busy={busy}
    >
      {phase === 'done' && !busy ? (
        <Check className="h-4 w-4 mr-1 text-emerald-500" />
      ) : (
        <RefreshCw className={`h-4 w-4 mr-1 ${busy ? 'animate-spin' : ''}`} />
      )}
      {busy ? '刷新中…' : phase === 'done' ? '已刷新' : '刷新'}
    </Button>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <span className="w-28 shrink-0 pt-2">
        {label}
        {hint && (
          <span className="block text-[10px] font-light text-gray-500 leading-3">{hint}</span>
        )}
      </span>
      <div className="flex flex-1">{children}</div>
    </label>
  )
}

function SliderRow({
  label,
  display,
  min,
  max,
  step,
  value,
  onChange
}: {
  label: string
  display: string
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <label className="text-sm">
        {label}
        <span className="ml-2 text-xs font-light">{display}</span>
      </label>
      <div className="w-60">
        <Slider
          min={min}
          max={max}
          step={step}
          value={[value]}
          onValueChange={(next) => onChange(next[0])}
        />
      </div>
    </div>
  )
}

/** Records for a few seconds with the *unsaved* config and shows what the STT service returns. */
function CaptureTest({ config }: { config: VoiceConfig }) {
  const [running, setRunning] = useState(false)
  const [level, setLevel] = useState(-100)
  const [lines, setLines] = useState<TestLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef<AudioCaptureSession | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idRef = useRef(0)
  const startRef = useRef<AbortController | null>(null)

  const stop = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    const session = sessionRef.current
    sessionRef.current = null
    if (session) {
      session.flush()
      session.stop()
    }
    startRef.current?.abort()
    startRef.current = null
    setRunning(false)
    setLevel(-100)
  }, [])

  useEffect(() => stop, [stop])

  const start = async () => {
    if (startRef.current) return
    const controller = new AbortController()
    startRef.current = controller
    setError(null)
    setLines([])
    setRunning(true)
    try {
      sessionRef.current = await AudioCaptureSession.start(
        {
          source: config.audioSource,
          appId: config.audioAppId,
          vad: config.vad
        },
        {
          onLevel: (db) => {
            if (startRef.current === controller) setLevel(db)
          },
          onEnded: (reason) => {
            if (startRef.current !== controller) return
            setError(reason)
            stop()
          },
          onSegment: (segment) => {
            idRef.current += 1
            const id = idRef.current
            setLines((prev) => [...prev, { id, status: 'pending', text: '' }])
            const wav = encodeWav(floatToPcm16(segment.frames), CAPTURE_SAMPLE_RATE)
            window.api
              .voiceTestTranscribe(config, wav)
              .then((text) =>
                setLines((prev) =>
                  prev.map((line) =>
                    line.id === id ? { ...line, status: 'done', text: text || '（空结果）' } : line
                  )
                )
              )
              .catch((err: unknown) =>
                setLines((prev) =>
                  prev.map((line) =>
                    line.id === id
                      ? {
                          ...line,
                          status: 'error',
                          text: err instanceof Error ? err.message : String(err)
                        }
                      : line
                  )
                )
              )
          }
        },
        { owner: 'test', signal: controller.signal }
      )
      if (controller.signal.aborted) {
        await sessionRef.current?.stop()
        sessionRef.current = null
        return
      }
      timerRef.current = setTimeout(stop, TEST_DURATION_MS)
    } catch (err) {
      if (controller.signal.aborted) return
      startRef.current = null
      setError(err instanceof Error ? err.message : String(err))
      setRunning(false)
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 p-3 space-y-2">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={running ? stop : start}
          title="用当前（未保存的）配置录 8 秒并调用识别服务"
        >
          {running ? <Square className="h-4 w-4 mr-1" /> : <AudioLines className="h-4 w-4 mr-1" />}
          {running ? '停止测试' : '录音测试（8 秒）'}
        </Button>
        <LevelMeter
          level={level}
          thresholdDb={config.vad.thresholdDb}
          active={running}
          className="flex-1"
        />
      </div>
      {error && <p className="text-xs text-red-400 break-words">{error}</p>}
      {lines.length > 0 && (
        <ul className="text-sm space-y-1">
          {lines.map((line) => (
            <li key={line.id} className={line.status === 'error' ? 'text-red-400' : ''}>
              {line.status === 'pending' ? '识别中…' : line.text}
            </li>
          ))}
        </ul>
      )}
      {running && lines.length === 0 && (
        <p className="text-xs text-gray-500">请让所选应用或系统播放声音；仅采集输出音频。</p>
      )}
    </div>
  )
}
