import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import {
  ArrowLeft,
  Eraser,
  Mic,
  MicOff,
  OctagonX,
  Pointer,
  PointerOff,
  Send,
  SendHorizontal,
  SettingsIcon,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import MarkdownRenderer from '@/components/MarkdownRenderer'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { useAppStore } from '@/lib/store/app'
import { useSettingsStore } from '@/lib/store/settings'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import {
  useVoiceStore,
  type TranscriptSegment,
  type TranscriptSelection,
  type VoiceExchange
} from '@/lib/store/voice'
import { LevelMeter } from './LevelMeter'

const SCROLL_OFFSET = 120

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })
}

export default function VoicePage() {
  const navigate = useNavigate()
  const { ignoreMouse, syncAppState } = useAppStore()
  const { captureState, answering, segments, selection, exchanges, error, captureNotice, level } =
    useVoiceStore()
  const thresholdDb = useSettingsStore((state) => state.voice.vad.thresholdDb)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    window.api.onSyncAppState((state) => syncAppState(state))
    return () => window.api.removeSyncAppStateListener()
  }, [syncAppState])

  useEffect(() => {
    window.api.onScrollPageUp(() => {
      const container = contentRef.current
      if (!container) return
      container.scrollTo({
        top: container.scrollTop - window.innerHeight + SCROLL_OFFSET,
        behavior: 'smooth'
      })
    })
    window.api.onScrollPageDown(() => {
      const container = contentRef.current
      if (!container) return
      container.scrollTo({
        top: container.scrollTop + window.innerHeight - SCROLL_OFFSET,
        behavior: 'smooth'
      })
    })
    return () => {
      window.api.removeScrollPageUpListener()
      window.api.removeScrollPageDownListener()
    }
  }, [])

  // Follow the streaming answer unless the user scrolled up to read something.
  useEffect(() => {
    const container = contentRef.current
    if (!container || !stickToBottomRef.current) return
    container.scrollTop = container.scrollHeight
  }, [exchanges, segments])

  const handleScroll = () => {
    const container = contentRef.current
    if (!container) return
    stickToBottomRef.current =
      container.scrollHeight - container.scrollTop - container.clientHeight < 80
  }

  const isListening = captureState === 'listening'
  const isBusy = captureState === 'starting' || captureState === 'stopping'
  const isEmpty = segments.length === 0 && exchanges.length === 0
  const unsent = segments.filter((segment) => !segment.sent)

  return (
    <>
      <div id="app-header" className="flex items-center justify-between px-3">
        <div className={`actions ${ignoreMouse ? 'pointer-events-none' : ''}`}>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 hover:bg-black/10 dark:hover:bg-white/10 rounded-md"
            onClick={() => navigate('/')}
            title="返回解题页"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </div>
        <div className="font-medium select-none flex items-center gap-2">
          语音助手
          {isListening && (
            <span className="inline-flex items-center gap-1 text-xs text-red-500">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              监听中
            </span>
          )}
          {isListening && captureNotice && (
            <span className="text-xs text-amber-600 dark:text-amber-400" title={captureNotice}>
              系统声音模式
            </span>
          )}
        </div>
        <div className={`actions ${ignoreMouse ? 'pointer-events-none' : ''}`}>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 hover:bg-black/10 dark:hover:bg-white/10 rounded-md"
            onClick={() => navigate('/settings')}
            title="设置"
          >
            <SettingsIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div id="app-content" ref={contentRef} onScroll={handleScroll} className="px-6 py-4 pb-12">
        {error && (
          <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded-lg flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-red-400 font-medium text-sm">语音助手出错</p>
              <p className="text-red-300/80 text-sm mt-0.5 break-words">{error}</p>
            </div>
            <button
              onClick={() => window.api.voiceDismissError()}
              className="text-red-400/80 hover:text-red-300 flex-shrink-0"
              title="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {(isListening || isBusy || segments.length > 0) && (
          <TranscriptPanel
            segments={segments}
            selection={selection}
            level={level}
            thresholdDb={thresholdDb}
            listening={isListening}
            busy={isBusy}
          />
        )}

        {isEmpty && !isListening && !isBusy ? (
          <EmptyTip />
        ) : (
          <div className="space-y-6">
            {exchanges.map((exchange) => (
              <ExchangeView key={exchange.id} exchange={exchange} />
            ))}
          </div>
        )}
      </div>

      <VoiceStatusBar
        listening={isListening}
        busy={isBusy}
        answering={answering}
        hasPending={unsent.some((segment) => segment.status !== 'error')}
        hasSendable={segments.some((segment) => segment.status === 'done' && !!segment.text)}
        hasSelection={!!selection}
        hasHistory={exchanges.length > 0}
      />
    </>
  )
}

function EmptyTip() {
  const { shortcuts } = useShortcutsStore()
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400 select-none">
      <Mic className="h-10 w-10 opacity-60" />
      <div className="text-lg">
        按下
        <ShortcutRenderer
          shortcut={shortcuts.toggleVoiceListening.key}
          className="mx-1 font-bold text-black dark:text-white"
        />
        开始监听会议音频
      </div>
      <div className="text-sm text-center leading-6">
        面试官说话时会逐句转成文字；再按一次同一快捷键停止监听并把内容发给大模型解答。
        <br />
        按
        <ShortcutRenderer
          shortcut={shortcuts.voiceSendNow.key}
          className="mx-1 scale-90 inline-block"
        />
        可以先发送已识别内容、继续监听。
        <br />
        只想问其中一句：点击识别记录（Shift+点击多选），或用
        <ShortcutRenderer
          shortcut={shortcuts.voiceSelectPrev.key}
          className="mx-1 scale-90 inline-block"
        />
        /
        <ShortcutRenderer
          shortcut={shortcuts.voiceSelectNext.key}
          className="mx-1 scale-90 inline-block"
        />
        上下选择，再按
        <ShortcutRenderer
          shortcut={shortcuts.voiceSendSelected.key}
          className="mx-1 scale-90 inline-block"
        />
        只发送选中的断句。
      </div>
    </div>
  )
}

/** seqs covered by the selection range, in transcript order. */
function getSelectedSeqs(
  segments: TranscriptSegment[],
  selection: TranscriptSelection | null
): Set<number> {
  if (!selection) return new Set()
  const anchor = segments.findIndex((segment) => segment.seq === selection.anchor)
  const focus = segments.findIndex((segment) => segment.seq === selection.focus)
  if (anchor < 0 || focus < 0) return new Set()
  const [from, to] = anchor <= focus ? [anchor, focus] : [focus, anchor]
  return new Set(segments.slice(from, to + 1).map((segment) => segment.seq))
}

function TranscriptPanel({
  segments,
  selection,
  level,
  thresholdDb,
  listening,
  busy
}: {
  segments: TranscriptSegment[]
  selection: TranscriptSelection | null
  level: number
  thresholdDb: number
  listening: boolean
  busy: boolean
}) {
  const { ignoreMouse } = useAppStore()
  const { shortcuts } = useShortcutsStore()
  const selected = getSelectedSeqs(segments, selection)
  const focusRef = useRef<HTMLLIElement>(null)

  // Keep the keyboard-selected line visible while stepping through with shortcuts.
  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selection?.focus])

  return (
    <div className="mb-4 rounded-xl border border-gray-200/60 dark:border-gray-700/60 bg-white/50 dark:bg-gray-800/50 p-3">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
          {listening ? '正在监听' : busy ? '处理中…' : '待发送内容'}
        </span>
        <LevelMeter level={level} thresholdDb={thresholdDb} active={listening} className="flex-1" />
      </div>
      {segments.length === 0 ? (
        <p className="text-sm text-gray-400">等待语音…</p>
      ) : (
        <>
          <ul className={`space-y-0.5 ${ignoreMouse ? 'pointer-events-none' : ''}`}>
            {segments.map((segment) => {
              const isSelected = selected.has(segment.seq)
              const selectable = segment.status === 'done'
              return (
                <li
                  key={segment.seq}
                  ref={segment.seq === selection?.focus ? focusRef : undefined}
                  className={`flex gap-2 text-sm leading-6 rounded-md px-1.5 -mx-1.5 select-none ${selectable ? 'cursor-pointer' : ''} ${isSelected ? 'bg-blue-500/15 ring-1 ring-blue-500/50' : selectable ? 'hover:bg-black/5 dark:hover:bg-white/5' : ''} ${segment.sent && !isSelected ? 'opacity-50' : ''}`}
                  onClick={(event) => {
                    if (selectable) void window.api.voiceSelectSegment(segment.seq, event.shiftKey)
                  }}
                >
                  <span className="text-xs text-gray-400 font-mono pt-1 whitespace-nowrap">
                    {formatTime(segment.startedAt)}
                  </span>
                  {segment.status === 'pending' ? (
                    <span className="flex items-center gap-2 text-gray-400">
                      <span className="animate-spin rounded-full h-3 w-3 border-b-2 border-r-2 border-current" />
                      识别中（{(segment.durationMs / 1000).toFixed(1)}s）
                    </span>
                  ) : segment.status === 'error' ? (
                    <span className="text-red-400 break-words">识别失败：{segment.error}</span>
                  ) : (
                    <span className="break-words flex-1">
                      {segment.text}
                      {segment.sent && (
                        <span className="ml-2 text-[10px] text-gray-400 whitespace-nowrap">
                          已发送
                        </span>
                      )}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
          {selected.size > 0 && (
            <p className="mt-2 text-xs text-blue-500/90 dark:text-blue-300/90">
              已选中 {selected.size} 句，按
              <ShortcutRenderer
                shortcut={shortcuts.voiceSendSelected.key}
                className="mx-1 inline-block scale-90"
              />
              只发送选中内容
            </p>
          )}
        </>
      )}
    </div>
  )
}

function ExchangeView({ exchange }: { exchange: VoiceExchange }) {
  return (
    <div>
      <div className="mb-2 rounded-lg bg-gray-200/60 dark:bg-gray-700/60 px-3 py-2 text-sm">
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mb-1">
          <Mic className="h-3 w-3" />
          {formatTime(exchange.askedAt)}
        </div>
        <div className="whitespace-pre-wrap break-words">{exchange.question}</div>
      </div>
      {exchange.status === 'error' ? (
        <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-sm text-red-300/90">
          API 调用失败：{exchange.error}
        </div>
      ) : (
        <>
          <MarkdownRenderer>{exchange.answer}</MarkdownRenderer>
          {exchange.status === 'stopped' && (
            <p className="text-xs text-gray-400 mt-1">（已停止生成）</p>
          )}
        </>
      )}
    </div>
  )
}

function VoiceStatusBar({
  listening,
  busy,
  answering,
  hasPending,
  hasSendable,
  hasSelection,
  hasHistory
}: {
  listening: boolean
  busy: boolean
  answering: boolean
  hasPending: boolean
  hasSendable: boolean
  hasSelection: boolean
  hasHistory: boolean
}) {
  const { ignoreMouse } = useAppStore()
  const { shortcuts } = useShortcutsStore()
  const hint = 'inline-block scale-75 text-xs border border-current bg-transparent py-0 px-1'

  return (
    <div className="absolute bottom-0 flex items-center justify-between w-full text-gray-500 bg-white/40 dark:bg-black/40 backdrop-blur-sm border-t border-gray-200/50 dark:border-gray-700/50 px-4 pb-1">
      <div className="flex items-center gap-2 text-sm">
        {answering && (
          <>
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-r-2 border-[currentColor]" />
            <span>正在生成...</span>
            <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex justify-center z-50 pointer-events-none">
              <Button
                variant="secondary"
                className="h-8 px-4 text-base shadow-lg pointer-events-auto"
                onClick={() => window.api.voiceStopAnswer()}
              >
                <OctagonX className="w-4 h-4" />
                停止生成
                <ShortcutRenderer
                  shortcut={shortcuts.stopSolutionStream.key}
                  className="inline-block border bg-transparent py-0 px-1"
                />
              </Button>
            </div>
          </>
        )}
        {!answering && busy && <span className="text-xs">处理中…</span>}
      </div>

      <div
        className={`flex items-center gap-1 select-none ${ignoreMouse ? 'pointer-events-none' : ''}`}
      >
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={busy}
          onClick={() => window.api.voiceToggleListening()}
          title={listening ? '停止监听并发送' : '开始监听'}
        >
          {listening ? <MicOff className="w-4 h-4 mr-1" /> : <Mic className="w-4 h-4 mr-1" />}
          {listening ? '停止并发送' : '开始监听'}
          <ShortcutRenderer shortcut={shortcuts.toggleVoiceListening.key} className={hint} />
        </Button>
        {(listening || hasPending) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={busy}
            onClick={() => window.api.voiceSendNow()}
            title="发送已识别内容并继续监听"
          >
            <Send className="w-4 h-4 mr-1" />
            发送并继续
            <ShortcutRenderer shortcut={shortcuts.voiceSendNow.key} className={hint} />
          </Button>
        )}
        {hasSendable && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => window.api.voiceSendSelected()}
            title={hasSelection ? '只发送选中的断句并继续监听' : '只发送最新一句并继续监听'}
          >
            <SendHorizontal className="w-4 h-4 mr-1" />
            {hasSelection ? '发送选中' : '发送最新一句'}
            <ShortcutRenderer shortcut={shortcuts.voiceSendSelected.key} className={hint} />
          </Button>
        )}
        {(listening || hasPending) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={busy}
            onClick={() => window.api.voiceCancel()}
            title="停止监听并丢弃未发送内容"
          >
            <X className="w-4 h-4 mr-1" />
            取消
            <ShortcutRenderer shortcut={shortcuts.cancelVoiceListening.key} className={hint} />
          </Button>
        )}
        {hasHistory && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => window.api.voiceClearSession()}
            title="清空对话（新话题）"
          >
            <Eraser className="w-4 h-4 mr-1" />
            清空
            <ShortcutRenderer shortcut={shortcuts.clearVoiceSession.key} className={hint} />
          </Button>
        )}
        <div className="flex items-center ml-2">
          {ignoreMouse ? <PointerOff className="w-4 h-4" /> : <Pointer className="w-4 h-4" />}
        </div>
      </div>
    </div>
  )
}
