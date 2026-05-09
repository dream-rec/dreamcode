import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import rehypeSlug from 'rehype-slug'
import 'highlight.js/styles/github-dark.css'
import 'katex/dist/katex.min.css'
import { useSettingsStore } from '@/lib/store/settings'

export default function MarkdownRenderer({ children }: { children: string }) {
  const fontSize = useSettingsStore((s) => s.fontSize)
  return (
    <div
      className="prose max-w-none prose-pre:p-0 prose-pre:overflow-hidden [&_pre_code]:whitespace-pre-wrap [&_pre_code]:break-all prose-headings:text-gray-800 prose-p:text-gray-700 prose-li:text-gray-700 prose-strong:text-gray-800 dark:prose-headings:text-gray-200 dark:prose-p:text-gray-300 dark:prose-li:text-gray-300 dark:prose-strong:text-gray-200"
      style={{ fontSize: `${fontSize}px` }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeHighlight, rehypeKatex, rehypeSlug]}
        components={{
          a({ href, children, ...props }) {
            const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
              e.preventDefault()
              if (!href) return
              if (href.startsWith('#')) {
                const id = decodeURIComponent(href.slice(1))
                let target = document.getElementById(id)
                if (!target) {
                  const headings = e.currentTarget.closest('.prose')?.querySelectorAll(
                    'h1, h2, h3, h4, h5, h6'
                  )
                  if (headings) {
                    for (const h of headings) {
                      const slug = (h.textContent || '')
                        .toLowerCase()
                        .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
                        .replace(/ /g, '-')
                      if (slug === id) {
                        target = h as HTMLElement
                        break
                      }
                    }
                  }
                }
                target?.scrollIntoView({ behavior: 'smooth' })
              } else {
                window.open(href, '_blank')
              }
            }
            return (
              <a href={href} onClick={handleClick} {...props}>
                {children}
              </a>
            )
          }
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
