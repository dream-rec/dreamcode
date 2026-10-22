import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { getActivePath, subscribeActivePath } from '@/lib/active-path'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { useSolutionStore } from '@/lib/store/solution'
import MarkdownRenderer from '@/components/MarkdownRenderer'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { useRegisterPageScroll } from '@/lib/use-page-scroll'

export function AppContent() {
  const screenshotData = useSolutionStore((state) => state.screenshotData)
  const errorMessage = useSolutionStore((state) => state.errorMessage)
  const setErrorMessage = useSolutionStore((state) => state.setErrorMessage)
  const screenshotSnapshot = useSolutionStore((state) => state.screenshotSnapshot)
  const syncScreenshot = useSolutionStore((state) => state.syncScreenshot)
  const recentScreenshots = screenshotSnapshot?.recentScreenshots ?? []
  const contentRef = useRegisterPageScroll('/')
  const [solutionText, setSolutionText] = useState(() =>
    useSolutionStore.getState().solutionChunks.join('')
  )

  useEffect(() => {
    const pull = () => {
      if (getActivePath() !== '/') return
      const text = useSolutionStore.getState().solutionChunks.join('')
      setSolutionText((current) => (current === text ? current : text))
    }
    pull()
    const unsubStore = useSolutionStore.subscribe(pull)
    const unsubPath = subscribeActivePath(pull)
    return () => {
      unsubStore()
      unsubPath()
    }
  }, [])

  useEffect(() => {
    let current = true
    const unsubscribe = window.api.onScreenshotState(syncScreenshot)
    window.api
      .getScreenshotState()
      .then((snapshot) => {
        if (current) syncScreenshot(snapshot)
      })
      .catch((error: unknown) => {
        if (current) setErrorMessage(String(error))
      })
    return () => {
      current = false
      unsubscribe()
    }
  }, [syncScreenshot, setErrorMessage])

  return (
    <div ref={contentRef} className="app-content px-6 py-4 pb-10">
      {/* Error Banner */}
      {errorMessage && (
        <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded-lg flex items-start gap-3">
          <svg
            className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-red-400 font-medium text-sm">截图与解答提示</p>
            <p className="text-red-300/80 text-sm mt-0.5 break-words">{errorMessage}</p>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-red-400/80 hover:text-red-300 flex-shrink-0"
            title="关闭"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      )}

      {screenshotSnapshot &&
        (screenshotSnapshot.pendingCount > 0 ||
          screenshotSnapshot.busy ||
          screenshotSnapshot.capturing) && (
          <p role="status" className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            {screenshotSnapshot.capturing
              ? '截图中…'
              : screenshotSnapshot.retry
                ? '输入已保留，追加截图可继续分析，或新开题目'
                : screenshotSnapshot.busy
                  ? '正在分析… 新截图会在本次回答结束后自动分析'
                  : '等待连续截图… 停止截图 2 秒后自动分析'}
          </p>
        )}

      {/* Screenshot Gallery */}
      {recentScreenshots.length > 0 ? (
        <div className="mb-4 flex gap-2 overflow-x-auto pb-2">
          {recentScreenshots.map((data, index) => (
            <img
              key={index}
              src={`data:image/png;base64,${data}`}
              alt={`Screenshot ${index + 1}`}
              className="w-40 h-auto flex-shrink-0 border border-gray-600 rounded-lg shadow-lg hover:shadow-xl transition-shadow"
              title={`第 ${index + 1} 张截图`}
            />
          ))}
        </div>
      ) : screenshotData ? (
        <div className="mb-4">
          <img
            src={`data:image/png;base64,${screenshotData}`}
            alt="Screenshot"
            className="w-40 h-auto border border-gray-600 rounded-lg shadow-lg"
          />
        </div>
      ) : (
        <ShortcutTip />
      )}

      {/* Solution Display */}
      <MarkdownRenderer>{solutionText}</MarkdownRenderer>
    </div>
  )
}

function ShortcutTip() {
  const navigate = useNavigate()
  const { shortcuts } = useShortcutsStore()
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-400 select-none">
      <div className="text-xl">
        请按下快捷键
        <ShortcutRenderer
          shortcut={shortcuts.takeScreenshot.key}
          className="mx-1 font-bold text-black dark:text-white"
        />
        抓取屏幕进行分析
      </div>
      <div className="text-sm">
        长题目先按{' '}
        <ShortcutRenderer shortcut={shortcuts.appendScreenshot.key} className="inline-block" />{' '}
        追加截图，停止截图 2 秒后自动分析；已有回答时自动保留完整前文追问
      </div>
      <button
        type="button"
        className="text-sm rounded-md px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10"
        onClick={() => navigate('/voice')}
      >
        点击进入监听页面，或按
        <ShortcutRenderer
          shortcut={shortcuts.toggleVoiceListening.key}
          className="mx-1 scale-90 inline-block"
        />
        开始监听
      </button>
    </div>
  )
}
