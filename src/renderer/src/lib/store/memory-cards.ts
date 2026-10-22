import { create } from 'zustand'
import { normalizeMemoryCards, type MemoryCardRecord } from '../../../../shared/user-profile'
import { saveMemoryCards } from '../profile-save'

export type MemoryCard = MemoryCardRecord

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

function createCard(index: number): MemoryCard {
  const cardNumber = index + 1
  return {
    id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: `记忆卡片 ${cardNumber}`,
    content: '',
    color: CARD_COLORS[index % CARD_COLORS.length]
  }
}

function persistCards(): void {
  const { cards, selectedCardId, defaultCardId } = useMemoryCardsStore.getState()
  saveMemoryCards({ cards, selectedCardId, defaultCardId })
}

export function hydrateMemoryCards(value: unknown): void {
  const normalized = normalizeMemoryCards(value)
  if (!normalized.recognized) return
  useMemoryCardsStore.setState(normalized.cards)
}

export const useMemoryCardsStore = create<MemoryCardsStore>()((set, get) => ({
  ...defaultState,
  selectCard: (cardId) => {
    const changed =
      get().cards.some((card) => card.id === cardId) && get().selectedCardId !== cardId
    if (!changed) return
    set({ selectedCardId: cardId })
    persistCards()
  },
  openDefaultCard: () => {
    const { defaultCardId, cards, selectedCardId } = get()
    if (!cards.some((card) => card.id === defaultCardId) || selectedCardId === defaultCardId) return
    set({ selectedCardId: defaultCardId })
    persistCards()
  },
  setDefaultCard: (cardId) => {
    if (!get().cards.some((card) => card.id === cardId) || get().defaultCardId === cardId) return
    set({ defaultCardId: cardId })
    persistCards()
  },
  addCard: () => {
    const state = get()
    const next = createCard(state.cards.length)
    set({
      cards: [...state.cards, next],
      selectedCardId: next.id
    })
    persistCards()
    return next.id
  },
  removeCard: (cardId) => {
    const state = get()
    if (state.cards.length <= 1 || !state.cards.some((card) => card.id === cardId)) return
    const cards = state.cards.filter((card) => card.id !== cardId)
    const fallbackId = cards[0].id
    set({
      cards,
      selectedCardId: state.selectedCardId === cardId ? fallbackId : state.selectedCardId,
      defaultCardId: state.defaultCardId === cardId ? fallbackId : state.defaultCardId
    })
    persistCards()
  },
  reorderCards: (draggedCardId, targetCardId) => {
    const state = get()
    if (draggedCardId === targetCardId) return
    const fromIndex = state.cards.findIndex((card) => card.id === draggedCardId)
    const toIndex = state.cards.findIndex((card) => card.id === targetCardId)
    if (fromIndex < 0 || toIndex < 0) return
    const cards = [...state.cards]
    const [moved] = cards.splice(fromIndex, 1)
    cards.splice(toIndex, 0, moved)
    set({ cards })
    persistCards()
  },
  updateCardTitle: (cardId, title) => {
    if (!get().cards.some((card) => card.id === cardId && card.title !== title)) return
    set((state) => ({
      cards: state.cards.map((card) => (card.id === cardId ? { ...card, title } : card))
    }))
    persistCards()
  },
  updateCardContent: (cardId, content) => {
    if (!get().cards.some((card) => card.id === cardId && card.content !== content)) return
    set((state) => ({
      cards: state.cards.map((card) => (card.id === cardId ? { ...card, content } : card))
    }))
    persistCards()
  }
}))
