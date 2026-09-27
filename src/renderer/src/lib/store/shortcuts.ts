import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { isMac } from '@/lib/utils/env'

export type Shortcut = {
  action: string
  key: string
  defaultKey: string
  category: string
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

type PersistedShortcutsState = {
  shortcuts?: Record<string, Shortcut>
}

function isPersistedShortcutsState(value: unknown): value is PersistedShortcutsState {
  return typeof value === 'object' && value !== null && 'shortcuts' in value
}

const platformGroupModifier = isMac ? 'CommandOrControl' : 'Alt'
const promptGroupKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=']

const defaultShortcuts: Record<string, Omit<Shortcut, 'defaultKey'>> = {
  hideOrShowMainWindow: {
    action: 'hideOrShowMainWindow',
    key: 'Alt+H',
    category: 'Window Management'
  },
  ignoreOrEnableMouse: {
    action: 'ignoreOrEnableMouse',
    key: 'Alt+M',
    category: 'Window Management'
  },
  takeScreenshot: { action: 'takeScreenshot', key: 'Alt+Enter', category: 'Screenshot & AI' },
  appendScreenshot: {
    action: 'appendScreenshot',
    key: 'Alt+Shift+Enter',
    category: 'Screenshot & AI'
  },
  stopSolutionStream: {
    action: 'stopSolutionStream',
    key: 'Alt+.',
    category: 'Screenshot & AI'
  },
  toggleVoiceListening: {
    action: 'toggleVoiceListening',
    key: 'Alt+L',
    category: 'Voice Assistant'
  },
  voiceSendNow: { action: 'voiceSendNow', key: 'Alt+Shift+L', category: 'Voice Assistant' },
  cancelVoiceListening: {
    action: 'cancelVoiceListening',
    key: 'Alt+,',
    category: 'Voice Assistant'
  },
  clearVoiceSession: {
    action: 'clearVoiceSession',
    key: 'Alt+Shift+,',
    category: 'Voice Assistant'
  },
  voiceSelectPrev: { action: 'voiceSelectPrev', key: 'Alt+Up', category: 'Voice Assistant' },
  voiceSelectNext: { action: 'voiceSelectNext', key: 'Alt+Down', category: 'Voice Assistant' },
  voiceSendSelected: {
    action: 'voiceSendSelected',
    key: 'Alt+/',
    category: 'Voice Assistant'
  },
  pageUp: { action: 'pageUp', key: 'CommandOrControl+J', category: 'Navigation' },
  pageDown: { action: 'pageDown', key: 'CommandOrControl+K', category: 'Navigation' },
  backToCoderPage: {
    action: 'backToCoderPage',
    key: 'CommandOrControl+R',
    category: 'Navigation'
  },
  switchToCard1: { action: 'switchToCard1', key: 'CommandOrControl+1', category: 'Memory Cards' },
  switchToCard2: { action: 'switchToCard2', key: 'CommandOrControl+2', category: 'Memory Cards' },
  switchToCard3: { action: 'switchToCard3', key: 'CommandOrControl+3', category: 'Memory Cards' },
  switchToCard4: { action: 'switchToCard4', key: 'CommandOrControl+4', category: 'Memory Cards' },
  switchToCard5: { action: 'switchToCard5', key: 'CommandOrControl+5', category: 'Memory Cards' },
  switchToCard6: { action: 'switchToCard6', key: 'CommandOrControl+6', category: 'Memory Cards' },
  switchToCard7: { action: 'switchToCard7', key: 'CommandOrControl+7', category: 'Memory Cards' },
  switchToCard8: { action: 'switchToCard8', key: 'CommandOrControl+8', category: 'Memory Cards' },
  switchToCard9: { action: 'switchToCard9', key: 'CommandOrControl+9', category: 'Memory Cards' },
  moveMainWindowUp: {
    action: 'moveMainWindowUp',
    key: 'CommandOrControl+Up',
    category: 'Window Movement'
  },
  moveMainWindowDown: {
    action: 'moveMainWindowDown',
    key: 'CommandOrControl+Down',
    category: 'Window Movement'
  },
  moveMainWindowLeft: {
    action: 'moveMainWindowLeft',
    key: 'CommandOrControl+Left',
    category: 'Window Movement'
  },
  moveMainWindowRight: {
    action: 'moveMainWindowRight',
    key: 'CommandOrControl+Right',
    category: 'Window Movement'
  },
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => {
      const slot = index + 1
      const key = `${platformGroupModifier}+F${slot}`
      return [
        `switchToProviderGroup${slot}`,
        {
          action: `switchToProviderGroup${slot}`,
          key,
          category: 'Provider 组'
        }
      ]
    })
  ),
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => {
      const slot = index + 1
      const key = `${platformGroupModifier}+Shift+${promptGroupKeys[index]}`
      return [
        `switchToPromptGroup${slot}`,
        {
          action: `switchToPromptGroup${slot}`,
          key,
          category: 'Prompt 组'
        }
      ]
    })
  )
} as Record<string, Omit<Shortcut, 'defaultKey'>>

export const useShortcutsStore = create<ShortcutsStore>()(
  persist(
    (set) => ({
      shortcuts: Object.fromEntries(
        Object.entries(defaultShortcuts).map(([action, shortcut]) => [
          action,
          { ...shortcut, defaultKey: shortcut.key }
        ])
      ),
      updateShortcut: (action, shortcut) => {
        set((state) => ({
          shortcuts: {
            ...state.shortcuts,
            [action]: shortcut
          }
        }))
      },
      updateShortcuts: (shortcuts) => {
        set({ shortcuts })
      },
      resetShortcuts: () => {
        set({
          shortcuts: Object.fromEntries(
            Object.entries(defaultShortcuts).map(([action, shortcut]) => [
              action,
              { ...shortcut, defaultKey: shortcut.key }
            ])
          )
        })
      }
    }),
    {
      name: 'dreamcode-shortcuts',
      version: 7,
      migrate: (state: unknown) => {
        if (!isPersistedShortcutsState(state) || !state.shortcuts) return state as ShortcutsStore
        // Merge in any new default shortcuts that are missing
        const defaults = Object.fromEntries(
          Object.entries(defaultShortcuts).map(([action, shortcut]) => [
            action,
            { ...shortcut, defaultKey: shortcut.key }
          ])
        )
        return {
          ...state,
          shortcuts: {
            ...defaults,
            ...state.shortcuts
          }
        } as ShortcutsStore
      }
    }
  )
)
