import { create } from 'zustand'
import { isMac } from '@/lib/utils/env'
import { normalizeShortcutMap, type ShortcutDefinition } from '../../../../shared/shortcuts'
import { saveShortcutMap } from '../profile-save'

export type Shortcut = ShortcutDefinition & {
  status?: ShortcutStatus
}

export enum ShortcutStatus {
  Registered = 'registered',
  Failed = 'failed',
  /** Shortcut is available to register but not registered. */
  Available = 'available'
}

interface ShortcutsState {
  shortcuts: Record<string, Shortcut>
}

interface ShortcutsStore extends ShortcutsState {
  updateShortcut: (action: string, shortcut: Shortcut) => void
  updateShortcuts: (shortcuts: Record<string, Shortcut>) => void
  resetShortcuts: () => void
}

function withRuntimeStatus(
  shortcuts: Record<string, ShortcutDefinition>,
  previous?: Record<string, Shortcut>
): Record<string, Shortcut> {
  return Object.fromEntries(
    Object.entries(shortcuts).map(([action, shortcut]) => [
      action,
      { ...shortcut, status: previous?.[action]?.status }
    ])
  )
}

function persistShortcuts(shortcuts: Record<string, Shortcut>): void {
  saveShortcutMap(
    Object.fromEntries(
      Object.entries(shortcuts).map(([action, shortcut]) => [
        action,
        {
          action,
          key: shortcut.key,
          category: shortcut.category,
          defaultKey: shortcut.defaultKey
        }
      ])
    )
  )
}

const defaultShortcuts = () => withRuntimeStatus(normalizeShortcutMap(undefined, isMac))

export const useShortcutsStore = create<ShortcutsStore>()((set) => ({
  shortcuts: defaultShortcuts(),
  updateShortcut: (action, shortcut) => {
    set((state) => {
      const shortcuts = { ...state.shortcuts, [action]: shortcut }
      persistShortcuts(shortcuts)
      return { shortcuts }
    })
  },
  updateShortcuts: (shortcuts) => {
    persistShortcuts(shortcuts)
    set({ shortcuts })
  },
  resetShortcuts: () => {
    const shortcuts = defaultShortcuts()
    persistShortcuts(shortcuts)
    set({ shortcuts })
  }
}))

export function hydrateShortcuts(value: unknown): void {
  useShortcutsStore.setState((state) => ({
    shortcuts: withRuntimeStatus(normalizeShortcutMap(value, isMac), state.shortcuts)
  }))
}
