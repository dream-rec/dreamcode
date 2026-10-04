export type ScreenshotKind = 'original' | 'feedback'

export interface ScreenshotSnapshot {
  sessionId: number
  revision: number
  pendingKind: ScreenshotKind | null
  pendingCount: number
  originalCount: number
  busy: boolean
  capturing: boolean
  retry: boolean
  hasAnswer: boolean
  solution: string
  error: string | null
  recentScreenshots: string[]
}

export interface ScreenshotResult {
  success: boolean
  error?: string
}
