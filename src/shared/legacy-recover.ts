/** Pull zustand persist blobs out of a Chromium localStorage dump (UTF-16 JSON). */

export interface RecoveredStores {
  settings: unknown | null
  shortcuts: unknown | null
  memoryCards: unknown | null
}

interface Scored {
  value: unknown
  score: number
  index: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function sliceJson(text: string): string | null {
  if (!text.startsWith('{')) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(0, index + 1)
    } else if (char === '\u0000') return null
  }
  return null
}

export function extractZustandStates(buffer: Uint8Array): unknown[] {
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const needle = Buffer.from('{"state"', 'utf16le')
  const found: unknown[] = []
  let offset = 0
  while (offset < bytes.length) {
    const index = bytes.indexOf(needle, offset)
    if (index < 0) break
    if (index % 2 !== 0) {
      offset = index + 1
      continue
    }
    const text = bytes
      .subarray(index, Math.min(bytes.length, index + 4_000_000))
      .toString('utf16le')
    const json = sliceJson(text)
    if (json) {
      try {
        found.push(JSON.parse(json))
      } catch {
        // Snappy-compressed records are not plain UTF-16; skip them.
      }
    }
    offset = index + needle.length
  }
  return found
}

function stateOf(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null
  const state = isRecord(value.state) ? value.state : value
  return isRecord(state) ? state : null
}

function scoreSettings(state: Record<string, unknown>): number {
  const chunks = [state.apiKey, state.customPrompt, state.model]
  if (Array.isArray(state.providerGroups)) chunks.push(state.providerGroups.length)
  return chunks.reduce<number>((total, item) => {
    if (typeof item === 'string') return total + item.trim().length
    if (typeof item === 'number') return total + item
    return total
  }, 0)
}

function scoreShortcuts(state: Record<string, unknown>): number {
  return isRecord(state.shortcuts) ? Object.keys(state.shortcuts).length : 0
}

function scoreCards(state: Record<string, unknown>): number {
  if (Array.isArray(state.cards)) {
    return state.cards.reduce<number>((total, card) => {
      if (!isRecord(card)) return total
      return total + (typeof card.content === 'string' ? card.content.length : 0) + 1
    }, 0)
  }
  return typeof state.content === 'string' ? state.content.length + 1 : 0
}

function classify(value: unknown): keyof RecoveredStores | null {
  const state = stateOf(value)
  if (!state) return null
  if (
    Array.isArray(state.cards) ||
    (typeof state.content === 'string' && !('apiProvider' in state))
  ) {
    return 'memoryCards'
  }
  if (isRecord(state.shortcuts)) return 'shortcuts'
  if ('apiProvider' in state || 'providerGroups' in state || typeof state.apiKey === 'string') {
    return 'settings'
  }
  return null
}

function score(kind: keyof RecoveredStores, value: unknown): number {
  const state = stateOf(value)
  if (!state) return 0
  if (kind === 'settings') return scoreSettings(state)
  if (kind === 'shortcuts') return scoreShortcuts(state)
  return scoreCards(state)
}

export function pickRecoveredStores(payloads: unknown[]): RecoveredStores {
  const best: Record<keyof RecoveredStores, Scored | null> = {
    settings: null,
    shortcuts: null,
    memoryCards: null
  }
  payloads.forEach((value, index) => {
    const kind = classify(value)
    if (!kind) return
    const next = { value, score: score(kind, value), index }
    const current = best[kind]
    if (
      !current ||
      next.score > current.score ||
      (next.score === current.score && next.index > current.index)
    ) {
      best[kind] = next
    }
  })
  return {
    settings: best.settings ? stateOf(best.settings.value) : null,
    shortcuts: best.shortcuts ? stateOf(best.shortcuts.value) : null,
    memoryCards: best.memoryCards ? stateOf(best.memoryCards.value) : null
  }
}

export function chooseNewestExisting(
  entries: { path: string; mtimeMs: number; sameAsDestination: boolean }[]
): string | null {
  const ranked = entries
    .filter((entry) => !entry.sameAsDestination)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  return ranked[0]?.path ?? null
}
