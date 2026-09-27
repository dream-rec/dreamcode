import { useState, useEffect, useCallback, createContext, useContext } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { isModifierKey, getShortcutAccelerator } from '@/lib/utils/keyboard'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { useMemoryCardsStore } from '@/lib/store/memory-cards'
import { useSettingsStore } from '@/lib/store/settings'

const ShortcutsContext = createContext<{
  recordingAction: string | null
  setRecordingAction: (action: string | null) => void
}>({
  recordingAction: null,
  setRecordingAction: () => {}
})

export function CustomShortcuts() {
  const { shortcuts, updateShortcut } = useShortcutsStore()
  const { cards } = useMemoryCardsStore()
  const { providerGroups, promptGroups } = useSettingsStore()
  const [recordingAction, setRecordingAction] = useState<string | null>(null)

  const onShortcutChange = useCallback(
    (action: string, key: string) => {
      const newShortcut = { ...shortcuts[action], key }
      updateShortcut(action, newShortcut)
      window.api.updateShortcuts([newShortcut])
    },
    [shortcuts, updateShortcut]
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!recordingAction) return

      e.preventDefault()

      if (isModifierKey(e.code)) return
      const accelerator = getShortcutAccelerator(e)
      if (e.code === 'Escape' && !accelerator) {
        setRecordingAction(null)
      }
      if (!accelerator) return
      onShortcutChange(recordingAction, accelerator)
      setRecordingAction(null)
    },
    [recordingAction, onShortcutChange]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleKeyDown])

  return (
    <ShortcutsContext.Provider value={{ recordingAction, setRecordingAction }}>
      <div className="space-y-4">
        {/* Window Management */}
        <div className="space-y-2">
          <h3 className="text-sm text-gray-500 dark:text-gray-400">窗口管理</h3>
          <Shortcut label="隐藏/显示窗口" shortcut="hideOrShowMainWindow" />
          <Shortcut
            label="鼠标穿透"
            description="启用后窗口对鼠标穿透，可以点击窗口背后的内容"
            shortcut="ignoreOrEnableMouse"
          />
        </div>

        {/* Screenshot & AI */}
        <div className="space-y-2">
          <h3 className="text-sm text-gray-500 dark:text-gray-400">截图与AI</h3>
          <Shortcut
            label="截图"
            description="截图并生成解题建议（会新开对话）"
            shortcut="takeScreenshot"
          />
          <Shortcut
            label="追加截图"
            description="在当前对话中追加截图并生成解题建议，适用于长题目等场景"
            shortcut="appendScreenshot"
          />
          <Shortcut
            label="停止生成"
            description="同时也会停止语音助手的回答"
            shortcut="stopSolutionStream"
          />
        </div>

        {/* Voice assistant */}
        <div className="space-y-2">
          <h3 className="text-sm text-gray-500 dark:text-gray-400">语音助手</h3>
          <Shortcut
            label="开始 / 停止监听"
            description="第一次按开始监听，再按一次停止监听并把识别内容发给大模型"
            shortcut="toggleVoiceListening"
          />
          <Shortcut
            label="发送并继续监听"
            description="把目前识别到的内容发出去，同时继续监听后面的话"
            shortcut="voiceSendNow"
          />
          <Shortcut
            label="取消监听"
            description="停止监听并丢弃未发送的内容"
            shortcut="cancelVoiceListening"
          />
          <Shortcut
            label="清空语音对话"
            description="清除识别记录、回答和上下文"
            shortcut="clearVoiceSession"
          />
          <Shortcut
            label="选中上一句"
            description="在语音助手页的识别记录中向上选择断句（也可以直接鼠标点击，Shift+点击多选）"
            shortcut="voiceSelectPrev"
          />
          <Shortcut label="选中下一句" shortcut="voiceSelectNext" />
          <Shortcut
            label="发送选中断句"
            description="只把选中的断句发给大模型并继续监听；未选中时发送最新一句"
            shortcut="voiceSendSelected"
          />
        </div>

        <div className="space-y-2">
          <h3 className="text-sm text-gray-500 dark:text-gray-400">Provider 组切换</h3>
          {providerGroups.map((group, index) => (
            <Shortcut
              key={group.id}
              label={group.name || `Provider 组 ${index + 1}`}
              shortcut={`switchToProviderGroup${index + 1}`}
            />
          ))}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm text-gray-500 dark:text-gray-400">Prompt 组切换</h3>
          {promptGroups.map((group, index) => (
            <Shortcut
              key={group.id}
              label={group.name || `Prompt 组 ${index + 1}`}
              shortcut={`switchToPromptGroup${index + 1}`}
            />
          ))}
        </div>

        {/* Navigation */}
        <div className="space-y-2">
          <h3 className="text-sm text-gray-500 dark:text-gray-400">页面导航</h3>
          <Shortcut label="向上翻页" shortcut="pageUp" />
          <Shortcut label="向下翻页" shortcut="pageDown" />
          <Shortcut label="返回主页面" shortcut="backToCoderPage" />
        </div>

        {/* Memory Cards */}
        <div className="space-y-2">
          <h3 className="text-sm text-gray-500 dark:text-gray-400">
            记忆卡片
            <span className="ml-2 text-xs font-light">点击快捷键可自定义绑定</span>
          </h3>
          {cards.slice(0, 9).map((card, index) => (
            <Shortcut
              key={card.id}
              label={`记忆卡片${index + 1}`}
              shortcut={`switchToCard${index + 1}`}
            />
          ))}
        </div>

        {/* Window Movement */}
        <div className="space-y-2">
          <h3 className="text-sm text-gray-500 dark:text-gray-400">窗口移动</h3>
          <Shortcut label="向上移动窗口" shortcut="moveMainWindowUp" />
          <Shortcut label="向下移动窗口" shortcut="moveMainWindowDown" />
          <Shortcut label="向左移动窗口" shortcut="moveMainWindowLeft" />
          <Shortcut label="向右移动窗口" shortcut="moveMainWindowRight" />
        </div>
      </div>
    </ShortcutsContext.Provider>
  )
}

function Shortcut({
  label,
  description,
  shortcut: shortcutAction
}: {
  label: string
  description?: string
  shortcut: string
}) {
  const { shortcuts } = useShortcutsStore()
  const { recordingAction, setRecordingAction } = useContext(ShortcutsContext)
  const shortcut = shortcuts[shortcutAction]
  const isRecording = recordingAction === shortcutAction

  return shortcut ? (
    <div className="flex items-center justify-between">
      <div className="flex gap-2 items-center">
        <label className="text-sm font-medium">{label}</label>
        {description && <p className="text-xs font-light">{description}</p>}
      </div>
      <span
        className="cursor-pointer"
        onClick={() => setRecordingAction(isRecording ? null : shortcutAction)}
      >
        {!isRecording ? (
          <ShortcutRenderer shortcut={shortcut.key} />
        ) : (
          <span className="font-mono text-sm align-middle rounded-md pl-2 pr-1 py-1 transition-colors bg-gray-200 dark:bg-gray-600 animate-pulse">
            请按下自定义快捷键...
          </span>
        )}
      </span>
    </div>
  ) : null
}

export function ResetDefaultShortcuts() {
  const { shortcuts, resetShortcuts } = useShortcutsStore()
  return (
    <Button
      variant="outline"
      size="sm"
      className="ml-auto"
      onClick={async () => {
        await window.api.updateShortcuts(
          Object.values(shortcuts)
            .filter(({ key, defaultKey }) => key !== defaultKey)
            .map((shortcut) => ({
              ...shortcut,
              key: shortcut.defaultKey
            }))
        )
        resetShortcuts()
        toast.success('重置默认快捷键成功')
      }}
    >
      重置默认快捷键
    </Button>
  )
}
