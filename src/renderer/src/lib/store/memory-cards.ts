import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type MemoryCard = {
  id: string
  title: string
  content: string
  color: string
}

interface MemoryCardsState {
  cards: MemoryCard[]
  selectedCardId: string
  defaultCardId: string
}

interface MemoryCardsStore extends MemoryCardsState {
  selectCard: (cardId: string) => void
  openDefaultCard: () => void
  setDefaultCard: (cardId: string) => void
  addCard: () => string
  removeCard: (cardId: string) => void
  reorderCards: (draggedCardId: string, targetCardId: string) => void
  updateCardTitle: (cardId: string, title: string) => void
  updateCardContent: (cardId: string, content: string) => void
}

const CARD_COLORS = ['#f97316', '#14b8a6', '#3b82f6', '#ef4444', '#22c55e', '#a855f7', '#f59e0b']

const defaultCard: MemoryCard = {
  id: 'card-1',
  title: '记忆卡片 1',
  content:
    '# 记忆卡片\n\n在这里记录你临时的笔记、知识点和待办。\n\n- 支持 Markdown\n- 阅读模式下仅展示\n- 编辑模式下可随时修改\n',
  color: CARD_COLORS[0]
}

const defaultState: MemoryCardsState = {
  cards: [defaultCard],
  selectedCardId: defaultCard.id,
  defaultCardId: defaultCard.id
}

type LegacyPersistedState = {
  content?: string
}

type PersistedState = {
  cards?: MemoryCard[]
  selectedCardId?: string
  defaultCardId?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function createCard(index: number): MemoryCard {
  const cardNumber = index + 1
  return {
    id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: `记忆卡片 ${cardNumber}`,
    content: '',
    color: CARD_COLORS[index % CARD_COLORS.length]
  }
}

export const useMemoryCardsStore = create<MemoryCardsStore>()(
  persist(
    (set, get) => ({
      ...defaultState,
      selectCard: (cardId) => {
        set((state) => {
          if (!state.cards.some((card) => card.id === cardId)) return state
          return { selectedCardId: cardId }
        })
      },
      openDefaultCard: () => {
        const { defaultCardId, cards } = get()
        const found = cards.some((card) => card.id === defaultCardId)
        if (!found) return
        set({ selectedCardId: defaultCardId })
      },
      setDefaultCard: (cardId) => {
        set((state) => {
          if (!state.cards.some((card) => card.id === cardId)) return state
          return { defaultCardId: cardId }
        })
      },
      addCard: () => {
        const state = get()
        const next = createCard(state.cards.length)
        set({
          cards: [...state.cards, next],
          selectedCardId: next.id
        })
        return next.id
      },
      removeCard: (cardId) => {
        set((state) => {
          if (state.cards.length <= 1 || !state.cards.some((card) => card.id === cardId)) {
            return state
          }

          const cards = state.cards.filter((card) => card.id !== cardId)
          const fallbackId = cards[0].id
          const selectedCardId =
            state.selectedCardId === cardId ? fallbackId : state.selectedCardId
          const defaultCardId = state.defaultCardId === cardId ? fallbackId : state.defaultCardId
          return { cards, selectedCardId, defaultCardId }
        })
      },
      reorderCards: (draggedCardId, targetCardId) => {
        set((state) => {
          if (draggedCardId === targetCardId) return state

          const fromIndex = state.cards.findIndex((card) => card.id === draggedCardId)
          const toIndex = state.cards.findIndex((card) => card.id === targetCardId)

          if (fromIndex < 0 || toIndex < 0) return state

          const cards = [...state.cards]
          const [moved] = cards.splice(fromIndex, 1)
          cards.splice(toIndex, 0, moved)

          return { cards }
        })
      },
      updateCardTitle: (cardId, title) => {
        set((state) => ({
          cards: state.cards.map((card) =>
            card.id === cardId ? { ...card, title: title || '未命名卡片' } : card
          )
        }))
      },
      updateCardContent: (cardId, content) => {
        set((state) => ({
          cards: state.cards.map((card) => (card.id === cardId ? { ...card, content } : card))
        }))
      }
    }),
    {
      name: 'dreamcode-memory-cards',
      version: 2,
      migrate: (state: unknown, version: number) => {
        if (!isObject(state)) {
          return defaultState
        }

        // From v1 single content to v2 multi cards
        if (version < 2) {
          const legacy = state as LegacyPersistedState
          const migratedCard: MemoryCard = {
            ...defaultCard,
            content: legacy.content || defaultCard.content
          }
          return {
            cards: [migratedCard],
            selectedCardId: migratedCard.id,
            defaultCardId: migratedCard.id
          }
        }

        const next = state as PersistedState
        const cards = Array.isArray(next.cards) && next.cards.length > 0 ? next.cards : [defaultCard]
        const selectedCardId =
          typeof next.selectedCardId === 'string' && cards.some((card) => card.id === next.selectedCardId)
            ? next.selectedCardId
            : cards[0].id
        const defaultCardId =
          typeof next.defaultCardId === 'string' && cards.some((card) => card.id === next.defaultCardId)
            ? next.defaultCardId
            : cards[0].id

        return {
          cards,
          selectedCardId,
          defaultCardId
        }
      }
    }
  )
)
