import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, BookOpen, Pencil, LayoutGrid, Plus, Trash2, Star, GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import MarkdownRenderer from '@/components/MarkdownRenderer'
import { useMemoryCardsStore } from '@/lib/store/memory-cards'

const SCROLL_OFFSET = 120

export default function MemoryCardsPage() {
  const navigate = useNavigate()
  const {
    cards,
    selectedCardId,
    defaultCardId,
    selectCard,
    openDefaultCard,
    setDefaultCard,
    addCard,
    removeCard,
    reorderCards,
    updateCardTitle,
    updateCardContent
  } = useMemoryCardsStore()
  const [isEditMode, setIsEditMode] = useState(false)
  const [showCardPanel, setShowCardPanel] = useState(false)
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null)
  const [dragOverCardId, setDragOverCardId] = useState<string | null>(null)
  const [dragPointer, setDragPointer] = useState({ x: 0, y: 0 })
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [pendingDeleteCardId, setPendingDeleteCardId] = useState<string | null>(null)
  const [pendingFocusTitleCardId, setPendingFocusTitleCardId] = useState<string | null>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  const selectedCard = cards.find((card) => card.id === selectedCardId) ?? cards[0]
  const selectedCardIndex = cards.findIndex((card) => card.id === selectedCard?.id)
  const draggingCard = cards.find((card) => card.id === draggingCardId) ?? null

  useEffect(() => {
    if (!isEditMode || !selectedCard || pendingFocusTitleCardId !== selectedCard.id) return
    titleInputRef.current?.focus()
    titleInputRef.current?.select()
    setPendingFocusTitleCardId(null)
  }, [isEditMode, selectedCard, pendingFocusTitleCardId])

  useEffect(() => {
    if (!draggingCardId) return
    const updatePointer = (event: MouseEvent) => {
      setDragPointer({ x: event.clientX, y: event.clientY })
    }
    const stopDragging = () => {
      setDraggingCardId(null)
      setDragOverCardId(null)
    }
    window.addEventListener('mousemove', updatePointer)
    window.addEventListener('mouseup', stopDragging)
    window.addEventListener('blur', stopDragging)
    return () => {
      window.removeEventListener('mousemove', updatePointer)
      window.removeEventListener('mouseup', stopDragging)
      window.removeEventListener('blur', stopDragging)
    }
  }, [draggingCardId])

  useEffect(() => {
    window.api.updateAppState({ inCoderPage: true })
    openDefaultCard()
    return () => {
      window.api.updateAppState({ inCoderPage: false })
    }
  }, [openDefaultCard])

  useEffect(() => {
    const handleOpenDefaultCard = () => {
      openDefaultCard()
      setShowCardPanel(true)
    }
    window.addEventListener('memory-cards-open-default', handleOpenDefaultCard)
    return () => {
      window.removeEventListener('memory-cards-open-default', handleOpenDefaultCard)
    }
  }, [openDefaultCard])

  useEffect(() => {
    window.api.onScrollPageUp(() => {
      const container = document.getElementById('app-content')
      if (!container) return
      container.scrollTo({
        top: container.scrollTop - window.innerHeight + SCROLL_OFFSET,
        behavior: 'smooth'
      })
    })
    return () => {
      window.api.removeScrollPageUpListener()
    }
  }, [])

  useEffect(() => {
    window.api.onScrollPageDown(() => {
      const container = document.getElementById('app-content')
      if (!container) return
      container.scrollTo({
        top: container.scrollTop + window.innerHeight - SCROLL_OFFSET,
        behavior: 'smooth'
      })
    })
    return () => {
      window.api.removeScrollPageDownListener()
    }
  }, [])

  return (
    <>
      <div id="app-header" className="flex items-center px-3">
        <div className="actions">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 hover:bg-black/10 dark:hover:bg-white/10 rounded-md"
            onClick={() => navigate('/')}
            title="返回问答页"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </div>
        <h1 className="flex-1 text-center font-medium select-none">记忆卡片</h1>
        <div className="actions flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className={`size-7 rounded-md hover:bg-black/10 dark:hover:bg-white/10 ${showCardPanel ? 'bg-black/10 dark:bg-white/10' : ''}`}
            onClick={() => setShowCardPanel((prev) => !prev)}
            title="卡片分组"
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-md hover:bg-black/10 dark:hover:bg-white/10"
            onClick={() => setIsEditMode((prev) => !prev)}
            title={isEditMode ? '切换到阅读模式' : '切换到编辑模式'}
          >
            {isEditMode ? <BookOpen className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <div id="app-content" className="px-6 py-4 pb-10">
        <div className="flex gap-4 items-start">
          {showCardPanel && (
            <aside className="w-[240px] shrink-0 rounded-xl border border-gray-200/70 dark:border-gray-700/60 bg-white/70 dark:bg-gray-900/40 backdrop-blur-sm p-3">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-gray-500 dark:text-gray-400">卡片分组</span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-md hover:bg-black/10 dark:hover:bg-white/10"
                    title="新建卡片"
                    onClick={() => {
                      const createdCardId = addCard()
                      setIsEditMode(true)
                      setPendingFocusTitleCardId(createdCardId)
                    }}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-md hover:bg-black/10 dark:hover:bg-white/10"
                    title="删除当前卡片"
                    onClick={() => {
                      if (!selectedCard) return
                      setPendingDeleteCardId(selectedCard.id)
                      setDeleteConfirmOpen(true)
                    }}
                    disabled={cards.length <= 1}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {cards.map((card, index) => {
                  const isActive = card.id === selectedCard?.id
                  const isDefault = card.id === defaultCardId
                  return (
                    <div
                      key={card.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectCard(card.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          selectCard(card.id)
                        }
                      }}
                      onMouseEnter={() => {
                        if (!draggingCardId) return
                        setDragOverCardId(card.id)
                      }}
                      onMouseLeave={() => {
                        if (!draggingCardId) return
                        setDragOverCardId((prev) => (prev === card.id ? null : prev))
                      }}
                      onMouseUp={() => {
                        if (!draggingCardId) return
                        if (draggingCardId !== card.id) {
                          reorderCards(draggingCardId, card.id)
                        }
                        setDraggingCardId(null)
                        setDragOverCardId(null)
                      }}
                      className={`relative text-left rounded-lg border p-2 transition-all duration-150 select-none ${isActive ? 'border-gray-900 dark:border-gray-100 shadow-sm' : 'border-gray-300/70 dark:border-gray-700/70 hover:border-gray-500/70 dark:hover:border-gray-500/70'} ${dragOverCardId === card.id ? 'ring-2 ring-blue-500/70 border-blue-500 border-dashed bg-blue-500/10 scale-[1.02]' : ''} ${draggingCardId === card.id ? 'opacity-45' : ''}`}
                    >
                      <span
                        role="button"
                        tabIndex={0}
                        data-drag-handle="true"
                        className="absolute top-1 left-1 rounded p-0.5 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 cursor-grab active:cursor-grabbing"
                        title="拖拽排序"
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => {
                          e.stopPropagation()
                          setDraggingCardId(card.id)
                          setDragOverCardId(card.id)
                          setDragPointer({ x: e.clientX, y: e.clientY })
                        }}
                        onMouseUp={(e) => {
                          e.stopPropagation()
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                          }
                        }}
                      >
                        <GripVertical className="h-3.5 w-3.5" />
                      </span>
                      <span
                        className={`absolute top-1 right-1 rounded p-0.5 ${isDefault ? 'text-amber-500' : 'text-gray-400 dark:text-gray-500 hover:text-amber-500'}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setDefaultCard(card.id)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            setDefaultCard(card.id)
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        title="设为默认卡片"
                      >
                        <Star className="h-3.5 w-3.5" fill={isDefault ? 'currentColor' : 'none'} />
                      </span>
                      <div
                        className="h-14 rounded-md mb-2 flex items-center justify-center text-white font-semibold"
                        style={{ backgroundColor: card.color }}
                      >
                        {index + 1}
                      </div>
                      <div className="text-[11px] leading-tight line-clamp-2 text-gray-700 dark:text-gray-300">
                        {card.title || `记忆卡片 ${index + 1}`}
                      </div>
                    </div>
                  )
                })}
              </div>
            </aside>
          )}

          <main className="min-w-0 flex-1 rounded-xl border border-gray-200/70 dark:border-gray-700/60 bg-white/70 dark:bg-gray-900/40 backdrop-blur-sm p-4">
            {selectedCard ? (
              <>
                <div className="mb-3 flex items-center gap-3">
                  <div
                    className="h-8 min-w-8 px-2 rounded-md flex items-center justify-center text-xs font-semibold text-white"
                    style={{ backgroundColor: selectedCard.color }}
                    title="卡片编号"
                  >
                    {selectedCardIndex + 1}
                  </div>
                  {isEditMode ? (
                    <input
                      ref={titleInputRef}
                      value={selectedCard.title}
                      onChange={(e) => updateCardTitle(selectedCard.id, e.target.value)}
                      placeholder="输入卡片标题"
                      className="h-8 w-full px-3 rounded-md border border-gray-300 dark:border-gray-600 bg-white/80 dark:bg-gray-800/80 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <h2 className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {selectedCard.title || '未命名卡片'}
                    </h2>
                  )}
                </div>

                {isEditMode ? (
                  <Textarea
                    value={selectedCard.content}
                    onChange={(e) => updateCardContent(selectedCard.id, e.target.value)}
                    placeholder="输入 Markdown 笔记内容..."
                    className="w-full min-h-[calc(100vh-190px)] bg-white/80 dark:bg-gray-800/80 font-mono text-sm"
                  />
                ) : selectedCard.content.trim() ? (
                  <MarkdownRenderer>{selectedCard.content}</MarkdownRenderer>
                ) : (
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    该卡片暂无内容，点击右上角铅笔图标进入编辑模式。
                  </div>
                )}
              </>
            ) : (
              <div className="text-sm text-gray-500 dark:text-gray-400">暂无可用卡片，请先新建卡片。</div>
            )}
          </main>
        </div>
      </div>

      {draggingCard && (
        <div
          className="fixed pointer-events-none z-50 rounded-lg border border-blue-400/60 bg-white/85 dark:bg-gray-900/85 backdrop-blur-sm px-2 py-1.5 shadow-lg"
          style={{
            left: dragPointer.x + 14,
            top: dragPointer.y + 14
          }}
        >
          <div className="flex items-center gap-2">
            <div
              className="h-5 min-w-5 px-1 rounded text-[10px] font-semibold text-white flex items-center justify-center"
              style={{ backgroundColor: draggingCard.color }}
            >
              {cards.findIndex((card) => card.id === draggingCard.id) + 1}
            </div>
            <span className="text-xs text-gray-800 dark:text-gray-200 max-w-28 truncate">
              {draggingCard.title || '未命名卡片'}
            </span>
          </div>
        </div>
      )}

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除卡片</DialogTitle>
            <DialogDescription>
              删除后无法恢复，确认删除当前卡片吗？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingDeleteCardId) {
                  removeCard(pendingDeleteCardId)
                }
                setPendingDeleteCardId(null)
                setDeleteConfirmOpen(false)
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
