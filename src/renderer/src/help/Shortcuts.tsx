import { Keyboard } from 'lucide-react'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { HelpSection } from './components'

export function Shortcuts() {
  return (
    <HelpSection
      Icon={Keyboard}
      title="快捷键"
      description="快捷键是操作应用的主要方式，您可以在设置中自定义快捷键。"
    >
      <ShortcutItemGroup category="Window Management" />
      <ShortcutItemGroup category="Screenshot & AI" />
      <ShortcutItemGroup category="Voice Assistant" />
      <ShortcutItemGroup category="Navigation" />
      <ShortcutItemGroup category="Memory Cards" />
      <ShortcutItemGroup category="Window Movement" />
      <ShortcutItemGroup category="Provider 组" />
      <ShortcutItemGroup category="Prompt 组" />
    </HelpSection>
  )
}

function ShortcutItemGroup({ category }: { category: string }) {
  const { shortcuts } = useShortcutsStore()
  return (
    <div className="space-y-2">
      <h3 className="text-sm text-gray-500 dark:text-gray-400">{getCategoryName(category)}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Object.values(shortcuts)
          .filter((shortcut) => shortcut.category === category)
          .map((shortcut, index) => (
            <ShortcutItem key={index} action={shortcut.action} shortcutKey={shortcut.key} />
          ))}
      </div>
    </div>
  )
}

function ShortcutItem({ action, shortcutKey }: { action: string; shortcutKey: string }) {
  return (
    <div className="flex items-center justify-between rounded border border-gray-400 dark:border-gray-600 px-2 py-1">
      <span className="text-sm">{getShortcutDescription(action)}</span>
      <ShortcutRenderer shortcut={shortcutKey} className="select-none" />
    </div>
  )
}

const getCategoryName = (category: string) => {
  const categoryMap: Record<string, string> = {
    'Window Management': '窗口管理',
    'Screenshot & AI': '截图与AI',
    'Voice Assistant': '语音助手',
    Navigation: '页面导航',
    'Memory Cards': '记忆卡片',
    'Window Movement': '窗口移动',
    'Provider 组': 'Provider 组切换（Command/Alt + F1~F12）',
    'Prompt 组': 'Prompt 组切换（Command/Alt + Shift + 数字键）'
  }
  return categoryMap[category] || category
}

const getShortcutDescription = (action: string) => {
  const descriptionMap: Record<string, string> = {
    hideOrShowMainWindow: '隐藏/显示窗口',
    ignoreOrEnableMouse: '鼠标穿透(窗口对鼠标隐身)',
    takeScreenshot: '截图新开题目（停止截图 2 秒后自动分析）',
    appendScreenshot: '追加截图（2 秒合批，已有回答时保留完整前文）',
    stopSolutionStream: '停止生成',
    toggleVoiceListening: '开始监听 / 停止监听（内容不自动发送）',
    voiceSendNow: '发送已识别内容并继续监听',
    clearVoiceSession: '清空语音对话',
    voiceSelectPrev: '选中上一句识别内容',
    voiceSelectNext: '选中下一句识别内容',
    voiceSendSelected: '只发送选中的断句（未选中时发送最新一句）',
    pageUp: '向上翻页',
    pageDown: '向下翻页',
    backToCoderPage: '返回主解题页',
    backToVoicePage: '返回语音监听页',
    switchToCard1: '切换到卡片 1',
    switchToCard2: '切换到卡片 2',
    switchToCard3: '切换到卡片 3',
    switchToCard4: '切换到卡片 4',
    switchToCard5: '切换到卡片 5',
    switchToCard6: '切换到卡片 6',
    switchToCard7: '切换到卡片 7',
    switchToCard8: '切换到卡片 8',
    switchToCard9: '切换到卡片 9',
    moveMainWindowUp: '向上移动窗口',
    moveMainWindowDown: '向下移动窗口',
    moveMainWindowLeft: '向左移动窗口',
    moveMainWindowRight: '向右移动窗口'
  }
  const providerMatch = action.match(/^switchToProviderGroup(\d+)$/)
  if (providerMatch) return `切换到 Provider 组 ${providerMatch[1]}`
  const promptMatch = action.match(/^switchToPromptGroup(\d+)$/)
  if (promptMatch) return `切换到 Prompt 组 ${promptMatch[1]}`
  return descriptionMap[action] || action
}
