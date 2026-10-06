// 从 CHANGELOG.md 摘出当前 tag 对应的小节，作为 GitHub Release 的说明正文。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)
const version = (process.env.GITHUB_REF_NAME ?? '').replace(/^v/, '')
const output = process.argv[2] ?? fileURLToPath(new URL('RELEASE_NOTES.md', root))

const lines = readFileSync(new URL('CHANGELOG.md', root), 'utf8').split('\n')
const start = version ? lines.findIndex((line) => line.startsWith(`## [${version}]`)) : -1
const tail = start === -1 ? [] : lines.slice(start + 1)
const stop = tail.findIndex((line) => line.startsWith('## ['))
const notes = (stop === -1 ? tail : tail.slice(0, stop)).join('\n').trim()

if (notes) {
  writeFileSync(output, `${notes}\n`)
  console.log(`已写入 ${version} 的发布说明（${notes.split('\n').length} 行）`)
} else {
  console.error(`CHANGELOG.md 中没有找到 ${version || '（未提供 tag）'} 的小节，写入占位说明`)
  writeFileSync(
    output,
    `本次更新说明待补充：CHANGELOG.md 中没有 ${version || '对应版本'} 的小节。\n`
  )
}
