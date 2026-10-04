import type { ModelMessage } from 'ai'
import type { ScreenshotKind, ScreenshotSnapshot } from '../shared/screenshot'

type UserMessage = Extract<ModelMessage, { role: 'user' }>

export interface ScreenshotRequest {
  id: number
  sessionId: number
  kind: ScreenshotKind | 'text'
  images: string[]
  messages: ModelMessage[]
  baseSolution: string
}

function imageMessage(images: string[], feedback: boolean): UserMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: feedback
          ? '以下是运行结果或错误反馈截图。请结合完整题目、之前的回答及历次反馈，定位问题并修正解答。'
          : '这些截图共同组成同一道原始题目，请结合全部图片完整解答，不要遗漏任何部分。'
      },
      ...images.map((image) => ({ type: 'image' as const, image }))
    ]
  }
}

/** Pure state machine: previews never serve as the model's conversation history. */
export class ScreenshotSession {
  private sessionId = 0
  private revision = 0
  private requestId = 0
  private originals: string[] = []
  private history: ModelMessage[] = []
  private pending: { kind: ScreenshotKind; images: string[] } | null = null
  private active: ScreenshotRequest | null = null
  private failed: ScreenshotRequest | null = null
  private committedSolution = ''
  private solution = ''
  private error: string | null = null

  private originalImages(): string[] {
    const request = this.active ?? this.failed
    return request?.kind === 'original' ? request.images : this.originals
  }

  collectionKind(): ScreenshotKind {
    // Freeze the role when collection starts, including while an initial answer is streaming.
    if (this.pending) return this.pending.kind
    if (this.failed) return this.failed.kind === 'original' ? 'original' : 'feedback'
    return this.originals.length && this.history.at(-1)?.role === 'assistant'
      ? 'feedback'
      : 'original'
  }

  collect(kind: ScreenshotKind, image: string): void {
    if (!this.pending) this.pending = { kind, images: [] }
    this.pending.images.push(image)
    this.error = null
    this.revision++
  }

  newQuestion(image: string): void {
    this.sessionId++
    this.originals = []
    this.history = []
    this.pending = { kind: 'original', images: [image] }
    this.active = null
    this.failed = null
    this.committedSolution = ''
    this.solution = ''
    this.error = null
    this.revision++
  }

  hasPending(): boolean {
    return !!this.pending || !!this.failed
  }

  begin(): ScreenshotRequest {
    if (this.active) throw new Error('正在生成回答，请等待完成或先停止')
    if (this.failed) {
      // A new capture resumes the failed input in ONE request, never retry-then-send.
      const failed = this.failed
      const extraImages = this.pending?.images ?? []
      const messages = [...failed.messages]
      const user = messages.at(-1)
      if (user?.role === 'user' && extraImages.length) {
        const content =
          typeof user.content === 'string'
            ? [{ type: 'text' as const, text: user.content }]
            : user.content
        messages[messages.length - 1] = {
          role: 'user',
          content: [...content, ...extraImages.map((image) => ({ type: 'image' as const, image }))]
        }
      }
      const retry = {
        ...failed,
        id: ++this.requestId,
        images: [...failed.images, ...extraImages],
        messages
      }
      this.failed = null
      this.pending = null
      return this.activate(retry)
    }
    const batch = this.pending
    if (!batch?.images.length) throw new Error('没有待分析截图')
    if (batch.kind === 'feedback' && this.history.at(-1)?.role !== 'assistant') {
      throw new Error('请先完成或重试上一轮回答，再发送反馈截图')
    }
    const images =
      batch.kind === 'original' ? [...this.originals, ...batch.images] : [...batch.images]
    const user = imageMessage(images, batch.kind === 'feedback')
    const request: ScreenshotRequest = {
      id: ++this.requestId,
      sessionId: this.sessionId,
      kind: batch.kind,
      images,
      messages: batch.kind === 'original' ? [user] : [...this.history, user],
      baseSolution: batch.kind === 'original' ? '' : this.committedSolution
    }
    this.pending = null
    return this.activate(request)
  }

  beginText(question: string): ScreenshotRequest {
    if (this.active) throw new Error('请先等待或停止当前回答')
    if (this.hasPending()) throw new Error('截图仍待分析或上次请求失败，请追加截图继续，或新开题目')
    if (this.history.at(-1)?.role !== 'assistant') throw new Error('请先完成一次解答再追问')
    const text = question.trim()
    if (!text) throw new Error('追问内容不能为空')
    return this.activate({
      id: ++this.requestId,
      sessionId: this.sessionId,
      kind: 'text',
      images: [],
      messages: [...this.history, { role: 'user', content: [{ type: 'text', text }] }],
      baseSolution: this.committedSolution
    })
  }

  private activate(request: ScreenshotRequest): ScreenshotRequest {
    this.active = request
    this.error = null
    this.solution = request.baseSolution + (request.baseSolution ? '\n\n---\n\n' : '')
    this.revision++
    return request
  }

  isActive(request: ScreenshotRequest): boolean {
    return this.active === request && request.sessionId === this.sessionId
  }

  append(request: ScreenshotRequest, chunk: string): boolean {
    if (!this.isActive(request)) return false
    this.solution += chunk
    this.revision++
    return true
  }

  complete(request: ScreenshotRequest, answer: string): void {
    if (!this.isActive(request)) return
    if (!answer.trim()) {
      this.fail(request, '模型未返回有效回答，请重试')
      return
    }
    this.history = [...request.messages, { role: 'assistant', content: answer }]
    if (request.kind === 'original') this.originals = [...request.images]
    this.committedSolution = this.solution
    this.active = null
    this.failed = null
    this.error = null
    this.revision++
  }

  fail(request: ScreenshotRequest, message: string): void {
    if (!this.isActive(request)) return
    this.failed = request
    this.active = null
    this.error = message
    this.revision++
  }

  reportError(message: string): void {
    this.error = message
    this.revision++
  }

  snapshot(capturing = false): ScreenshotSnapshot {
    const images: string[] = []
    for (const message of this.history) {
      if (message.role !== 'user' || typeof message.content === 'string') continue
      for (const part of message.content) {
        if (part.type === 'image' && typeof part.image === 'string') images.push(part.image)
      }
    }
    const request = this.active ?? this.failed
    const previews =
      request?.kind === 'original' ? [...request.images] : [...images, ...(request?.images ?? [])]
    previews.push(...(this.pending?.images ?? []))
    return {
      sessionId: this.sessionId,
      revision: this.revision,
      pendingKind:
        this.failed?.kind === 'text' ? null : (this.failed?.kind ?? this.pending?.kind ?? null),
      pendingCount: (this.pending?.images.length ?? 0) + (this.failed?.images.length ?? 0),
      originalCount: this.originalImages().length,
      busy: !!this.active,
      capturing,
      retry: !!this.failed,
      hasAnswer: !this.failed && this.history.at(-1)?.role === 'assistant',
      solution: this.solution,
      error: this.error,
      recentScreenshots: previews.slice(-5)
    }
  }
}
