import { createDefaultShortcuts, normalizeShortcutMap, type ShortcutDefinition } from './shortcuts'

export interface AppearanceSettings {
  theme: 'light' | 'dark'
  opacity: number
  fontSize: number
}

export interface MemoryCardRecord {
  id: string
  title: string
  content: string
  color: string
}

export interface MemoryCardsPersisted {
  cards: MemoryCardRecord[]
  selectedCardId: string
  defaultCardId: string
}

export interface UserProfile {
  version: 1
  appearance: AppearanceSettings
  shortcuts: Record<string, ShortcutDefinition>
  memoryCards: MemoryCardsPersisted
}

export const defaultAppearance: AppearanceSettings = {
  theme: 'light',
  opacity: 0.8,
  fontSize: 14
}

const CARD_COLORS = ['#f97316', '#14b8a6', '#3b82f6', '#ef4444', '#22c55e', '#a855f7', '#f59e0b']

export const defaultMemoryCard: MemoryCardRecord = {
  id: 'card-1',
  title: '记忆卡片 1',
  content:
    '# 记忆卡片\n\n在这里记录你临时的笔记、知识点和待办。\n\n- 支持 Markdown\n- 阅读模式下仅展示\n- 编辑模式下可随时修改\n',
  color: CARD_COLORS[0]
}

export const defaultMemoryCards: MemoryCardsPersisted = {
  cards: [defaultMemoryCard],
  selectedCardId: defaultMemoryCard.id,
  defaultCardId: defaultMemoryCard.id
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function normalizeAppearance(value: unknown): AppearanceSettings {
  const source = isRecord(value) ? value : {}
  return {
    theme: source.theme === 'dark' ? 'dark' : 'light',
    opacity: clamp(source.opacity, defaultAppearance.opacity, 0.1, 1),
    fontSize: clamp(source.fontSize, defaultAppearance.fontSize, 12, 24)
  }
}

function normalizeCard(value: unknown, index: number): MemoryCardRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null
  return {
    id: value.id,
    title: typeof value.title === 'string' ? value.title : `记忆卡片 ${index + 1}`,
    content: typeof value.content === 'string' ? value.content : '',
    color:
      typeof value.color === 'string' && value.color.trim()
        ? value.color
        : CARD_COLORS[index % CARD_COLORS.length]
  }
}

/**
 * Accept the current multi-card file and the v1 single-`content` localStorage shape.
 * Returns `recognized: false` when the payload isn't a card store, so callers don't
 * replace a real library with the built-in sample.
 */
export function normalizeMemoryCards(value: unknown): {
  cards: MemoryCardsPersisted
  recognized: boolean
} {
  const source = isRecord(value) && isRecord(value.memoryCards) ? value.memoryCards : value
  if (!isRecord(source)) return { cards: defaultMemoryCards, recognized: false }

  if (Array.isArray(source.cards)) {
    const cards = source.cards
      .map((card, index) => normalizeCard(card, index))
      .filter((card): card is MemoryCardRecord => card !== null)
    if (!cards.length) return { cards: defaultMemoryCards, recognized: false }
    const selectedCardId =
      typeof source.selectedCardId === 'string' &&
      cards.some((card) => card.id === source.selectedCardId)
        ? source.selectedCardId
        : cards[0].id
    const defaultCardId =
      typeof source.defaultCardId === 'string' &&
      cards.some((card) => card.id === source.defaultCardId)
        ? source.defaultCardId
        : cards[0].id
    return { cards: { cards, selectedCardId, defaultCardId }, recognized: true }
  }

  if (typeof source.content === 'string') {
    const card: MemoryCardRecord = { ...defaultMemoryCard, content: source.content }
    return {
      cards: { cards: [card], selectedCardId: card.id, defaultCardId: card.id },
      recognized: true
    }
  }

  return { cards: defaultMemoryCards, recognized: false }
}

export function createDefaultProfile(isMac: boolean): UserProfile {
  return {
    version: 1,
    appearance: { ...defaultAppearance },
    shortcuts: createDefaultShortcuts(isMac),
    memoryCards: {
      cards: defaultMemoryCards.cards.map((card) => ({ ...card })),
      selectedCardId: defaultMemoryCards.selectedCardId,
      defaultCardId: defaultMemoryCards.defaultCardId
    }
  }
}

function unwrapState(value: unknown): unknown {
  if (isRecord(value) && isRecord(value.state)) return value.state
  return value
}

/** Merge a partial or legacy payload onto the defaults without dropping sibling sections. */
export function normalizeUserProfile(value: unknown, isMac: boolean): UserProfile {
  const defaults = createDefaultProfile(isMac)
  const source = isRecord(value) ? value : {}
  const state = unwrapState(source)
  const record = isRecord(state) ? state : {}
  const appearanceSource = isRecord(record.appearance)
    ? record.appearance
    : {
        theme: record.theme,
        opacity: record.opacity,
        fontSize: record.fontSize
      }
  const memory = normalizeMemoryCards(
    isRecord(record.memoryCards) ||
      Array.isArray(record.cards) ||
      typeof record.content === 'string'
      ? record
      : null
  )
  return {
    version: 1,
    appearance: normalizeAppearance(appearanceSource),
    shortcuts: normalizeShortcutMap(record.shortcuts ?? source, isMac),
    memoryCards: memory.recognized ? memory.cards : defaults.memoryCards
  }
}

export function appearanceFromUnknown(value: unknown): AppearanceSettings | null {
  const state = unwrapState(value)
  if (!isRecord(state)) return null
  if (!('theme' in state) && !('opacity' in state) && !('fontSize' in state)) return null
  return normalizeAppearance(state)
}
