import { BookOpen } from 'lucide-react'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { HelpSection } from './components'

const faqs = [
  {
    question: '如何截取屏幕截图？',
    answer: (
      <span>
        按下
        <ShortcutRenderer shortcut="Alt+Enter" className="text-xs mx-1" />
        快捷键即可截取当前屏幕的截图。截图会自动显示在应用中。
      </span>
    )
  },
  {
    question: '如何处理题目超过一屏的情况？',
    answer: (
      <span>
        按下
        <ShortcutRenderer shortcut="Alt+Shift+Enter" className="text-xs mx-1" />
        快捷键即可在当前对话中追加截图并生成解题建议。
      </span>
    )
  },
  {
    question: '分享屏幕时，对方能看到应用吗？',
    answer: (
      <span>
        工具窗口在共享屏幕时自动隐藏(对方不可见)，但小部分会议软件可能需要配置才能隐藏。所以如果你对隐身功能有需求，务必在正式使用前用「当前电脑」+「当前会议软件」测试一下。更多细节请参考{' '}
        <a
          href="https://github.com/dream-rec/dreamcode/wiki/隐身配置"
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 hover:underline"
        >
          GitHub Wiki
        </a>
        。
      </span>
    )
  },
  {
    question: '鼠标移过窗口时，光标会不会变？',
    answer: (
      <span>
        本工具提供了开关，可以开启或关闭鼠标穿透。开启鼠标穿透时，窗口对鼠标隐身，你需要通过快捷键来操作窗口。切换「鼠标穿透」开关的快捷键是{' '}
        <ShortcutRenderer shortcut="Alt+M" className="text-xs" /> 。窗口右下角会显示当前状态。
      </span>
    )
  }
]

export function FAQ() {
  return (
    <HelpSection Icon={BookOpen} title="常见问题">
      {faqs.map((faq, index) => (
        <div key={index} className="border border-gray-400 dark:border-gray-600 rounded-lg p-4">
          <h3 className="font-semibold mb-2">{faq.question}</h3>
          <p className="text-sm text-gray-700 dark:text-gray-300">{faq.answer}</p>
        </div>
      ))}
    </HelpSection>
  )
}
