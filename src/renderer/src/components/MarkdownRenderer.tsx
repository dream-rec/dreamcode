import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'

// Ref https://github.com/tailwindlabs/tailwindcss-typography to fine-tune the markdown style
export default function MarkdownRenderer({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none prose-pre:p-0 prose-code:text-xs prose-headings:text-gray-800 prose-p:text-gray-700 prose-li:text-gray-700 prose-strong:text-gray-800 dark:prose-headings:text-gray-200 dark:prose-p:text-gray-300 dark:prose-li:text-gray-300 dark:prose-strong:text-gray-200">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
