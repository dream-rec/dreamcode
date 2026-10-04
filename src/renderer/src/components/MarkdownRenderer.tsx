import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import rehypeSlug from 'rehype-slug'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import 'highlight.js/styles/github-dark.css'
import 'katex/dist/katex.min.css'
import { useSettingsStore } from '@/lib/store/settings'

const markdownSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: ['https', 'data']
  }
}

function isSafeDimension(value: string | number | undefined) {
  return (
    (typeof value === 'number' && Number.isFinite(value) && value > 0) ||
    (typeof value === 'string' && /^\d+(?:\.\d+)?(?:px|%)?$/.test(value))
  )
}

function normalizeMathDelimiters(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`)/g)
  return parts
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(
              /\\\[([\s\S]*?)\\\]/g,
              (_, formula: string) => `\n\n$$\n${formula.trim()}\n$$\n\n`
            )
            .replace(/\\\(([^\n]*?)\\\)/g, (_, formula: string) => `$${formula}$`)
    )
    .join('')
}

export default function MarkdownRenderer({ children }: { children: string }) {
  const fontSize = useSettingsStore((s) => s.fontSize)
  const markdown = normalizeMathDelimiters(children)
  return (
    <div
      className="prose max-w-none prose-pre:p-0 prose-pre:overflow-hidden [&_pre_code]:whitespace-pre-wrap [&_pre_code]:break-all prose-headings:text-gray-800 prose-p:text-gray-700 prose-li:text-gray-700 prose-strong:text-gray-800 prose-a:text-blue-700 prose-th:text-gray-900 prose-td:text-gray-800 dark:prose-headings:text-gray-100 dark:prose-p:text-gray-200 dark:prose-li:text-gray-200 dark:prose-strong:text-gray-100 dark:prose-a:text-blue-300 dark:prose-a:decoration-blue-300 dark:prose-th:text-white dark:prose-td:text-gray-100 [&_table]:text-gray-800 dark:[&_table]:text-gray-100 [&_table_th]:bg-gray-100/80 dark:[&_table_th]:bg-gray-700/80 [&_table_th]:font-semibold [&_table_td]:text-gray-800 dark:[&_table_td]:text-gray-100 [&_table_th]:text-gray-900 dark:[&_table_th]:text-white [&_img]:max-w-full [&_img]:h-auto"
      style={{ fontSize: `${fontSize}px` }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, markdownSchema],
          rehypeHighlight,
          rehypeKatex,
          rehypeSlug
        ]}
        components={{
          img({ src, alt, width, height, ...props }) {
            if (!src || !/^(https:|data:image\/)/i.test(src)) return null
            const safeWidth = isSafeDimension(width) ? width : undefined
            const safeHeight = isSafeDimension(height) ? height : undefined
            return (
              <img
                src={src}
                alt={alt ?? ''}
                width={safeWidth}
                height={safeHeight}
                {...props}
                loading="lazy"
              />
            )
          },
          a({ href, children, ...props }) {
            const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
              e.preventDefault()
              if (!href) return
              if (href.startsWith('#')) {
                const id = decodeURIComponent(href.slice(1))
                let target = document.getElementById(id)
                if (!target) {
                  const headings = e.currentTarget
                    .closest('.prose')
                    ?.querySelectorAll('h1, h2, h3, h4, h5, h6')
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
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
