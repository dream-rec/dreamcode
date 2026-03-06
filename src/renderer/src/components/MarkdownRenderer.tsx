import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'
import { useSettingsStore } from '@/lib/store/settings'

// Ref https://github.com/tailwindlabs/tailwindcss-typography to fine-tune the markdown style
export default function MarkdownRenderer({ children }: { children: string }) {
  const fontSize = useSettingsStore((s) => s.fontSize)
  return (
    <div
      className="prose max-w-none prose-pre:p-0 prose-headings:text-gray-800 prose-p:text-gray-700 prose-li:text-gray-700 prose-strong:text-gray-800 dark:prose-headings:text-gray-200 dark:prose-p:text-gray-300 dark:prose-li:text-gray-300 dark:prose-strong:text-gray-200"
      style={{ fontSize: `${fontSize}px` }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
