import { ipcMain } from 'electron'
import { takeScreenshot } from './take-screenshot'
import { getGeneralStream } from './ai'
import { settings } from './settings'
import { state } from './state'
import { ThinkTagStreamFilter, extractErrorMessage } from './stream-utils'
import { ScreenshotSession, type ScreenshotRequest } from './screenshot-session'
import type { ScreenshotResult, ScreenshotSnapshot } from '../shared/screenshot'

const SCREENSHOT_IDLE_MS = 2000
const session = new ScreenshotSession()
let captures: Promise<void> = Promise.resolve()
let captureCount = 0
let current: { request: ScreenshotRequest; controller: AbortController } | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let batchReady = false
let wireRevision = 0

function snapshot(): ScreenshotSnapshot {
  return { ...session.snapshot(captureCount > 0), revision: ++wireRevision }
}

function broadcast(): void {
  const win = global.mainWindow
  if (win && !win.isDestroyed()) win.webContents.send('screenshot-state', snapshot())
}

function report(error: unknown): ScreenshotResult {
  const message = extractErrorMessage(error)
  session.reportError(message)
  broadcast()
  return { success: false, error: message }
}

function requireWindow(): void {
  const win = global.mainWindow
  if (!win || win.isDestroyed() || !state.inCoderPage) throw new Error('请先回到解题页面')
}

function pauseBatch(): void {
  if (idleTimer !== null) clearTimeout(idleTimer)
  idleTimer = null
  batchReady = false
}

function scheduleBatch(): void {
  pauseBatch()
  idleTimer = setTimeout(() => {
    idleTimer = null
    batchReady = true
    drainBatch()
  }, SCREENSHOT_IDLE_MS)
}

function drainBatch(): void {
  if (!batchReady || captureCount || current || !session.hasPending()) return
  batchReady = false
  try {
    // Captures were explicitly requested on the coder page. Route changes must not lose them.
    if (!settings.apiKey) throw new Error('请先配置模型 API Key，再追加截图继续')
    void execute(session.begin())
  } catch (error) {
    report(error)
  }
}

function enqueueCapture(action: () => Promise<void>): Promise<void> {
  captureCount++
  // A trigger during a pending burst must stop an imminent send, even before capture resolves.
  if (!session.snapshot().retry) scheduleBatch()
  broadcast()
  const task = captures
    .then(action)
    .catch((error: unknown) => {
      report(error)
    })
    .finally(() => {
      captureCount--
      broadcast()
      drainBatch()
    })
  captures = task
  return task
}

async function execute(request: ScreenshotRequest): Promise<ScreenshotResult> {
  const context = { request, controller: new AbortController() }
  current = context
  broadcast()
  const filter = new ThinkTagStreamFilter()
  let answer = ''
  const fail = (message: string): void => {
    if (!session.isActive(request)) return
    session.fail(request, message)
    // Stop only this attempt. A capture after a stop can re-arm the next attempt.
    pauseBatch()
  }
  const push = (chunk: string): void => {
    if (!chunk || !session.isActive(request) || context.controller.signal.aborted) return
    answer += chunk
    session.append(request, chunk)
    broadcast()
  }
  try {
    const stream = getGeneralStream(request.messages, context.controller.signal)
    for await (const chunk of stream) {
      if (context.controller.signal.aborted || !session.isActive(request)) break
      push(filter.push(chunk))
    }
    if (context.controller.signal.aborted || !session.isActive(request)) {
      fail('生成已停止，输入已保留；追加截图可继续，或新开题目')
      return { success: false, error: '生成已停止' }
    }
    push(filter.finish())
    session.complete(request, answer)
    const succeeded = !session.snapshot().retry
    if (!succeeded) pauseBatch()
    return succeeded ? { success: true } : { success: false, error: '模型未返回有效回答' }
  } catch (error) {
    const message = context.controller.signal.aborted
      ? '生成已停止，输入已保留；追加截图可继续，或新开题目'
      : `${extractErrorMessage(error)}；输入已保留，追加截图可继续，或新开题目`
    fail(message)
    return { success: false, error: message }
  } finally {
    if (current === context) current = null
    broadcast()
    drainBatch()
  }
}

export function collectScreenshot(): Promise<void> {
  return enqueueCapture(async () => {
    requireWindow()
    const kind = session.collectionKind()
    const image = await takeScreenshot()
    if (!image) throw new Error('截图失败，请检查屏幕录制权限后重试')
    session.collect(kind, image)
    scheduleBatch()
  })
}

export function captureNewQuestion(): Promise<void> {
  return enqueueCapture(async () => {
    requireWindow()
    const image = await takeScreenshot()
    if (!image) throw new Error('截图失败，原对话和待分析内容已保留')
    current?.controller.abort()
    session.newQuestion(image)
    scheduleBatch()
  })
}

export async function sendScreenshotFollowUp(question: string): Promise<ScreenshotResult> {
  await captures
  try {
    requireWindow()
    if (current) throw new Error('请等待当前回答结束')
    if (!settings.apiKey) throw new Error('请先配置模型 API Key')
    return await execute(session.beginText(question))
  } catch (error) {
    return report(error)
  }
}

export function stopScreenshotStream(): void {
  pauseBatch()
  const context = current
  if (!context) return
  context.controller.abort()
  session.fail(context.request, '生成已停止，输入已保留；追加截图可继续，或新开题目')
  // Keep the execution lease until the aborted iterator closes: no overlapping provider calls.
  broadcast()
}

ipcMain.handle('screenshot:getState', () => snapshot())
