import type {
  AppearanceSettings,
  MemoryCardsPersisted,
  UserProfile
} from '../../../shared/user-profile'
import type { ShortcutDefinition } from '../../../shared/shortcuts'

function api(): Window['api'] | null {
  if (typeof window === 'undefined' || !window.api) return null
  return window.api
}

let appearanceTimer: ReturnType<typeof setTimeout> | null = null
let shortcutTimer: ReturnType<typeof setTimeout> | null = null
let cardTimer: ReturnType<typeof setTimeout> | null = null

export function saveAppearance(appearance: AppearanceSettings): void {
  const bridge = api()
  if (!bridge?.saveAppearance) return
  if (appearanceTimer) clearTimeout(appearanceTimer)
  appearanceTimer = setTimeout(() => {
    appearanceTimer = null
    void bridge.saveAppearance(appearance)
  }, 200)
}

export function saveShortcutMap(shortcuts: Record<string, ShortcutDefinition>): void {
  const bridge = api()
  if (!bridge?.saveShortcuts) return
  if (shortcutTimer) clearTimeout(shortcutTimer)
  shortcutTimer = setTimeout(() => {
    shortcutTimer = null
    void bridge.saveShortcuts(shortcuts)
  }, 200)
}

export function saveMemoryCards(memoryCards: MemoryCardsPersisted): void {
  const bridge = api()
  if (!bridge?.saveMemoryCards) return
  if (cardTimer) clearTimeout(cardTimer)
  cardTimer = setTimeout(() => {
    cardTimer = null
    void bridge.saveMemoryCards(memoryCards)
  }, 300)
}

export async function loadPersistedUserProfile(): Promise<UserProfile | null> {
  const bridge = api()
  if (!bridge?.getUserProfile) return null
  const existing = await bridge.getUserProfile()
  if (existing) return existing

  const local = readLocalZustandProfile()
  if (local.settings && bridge.importLegacyConfigIfEmpty) {
    await bridge.importLegacyConfigIfEmpty(local.settings)
  }
  if (local.profile) return bridge.saveUserProfile(local.profile)
  if (bridge.recoverLegacyProfile) {
    const recovered = await bridge.recoverLegacyProfile()
    if (recovered) return recovered
  }
  return null
}

function readKey(key: string): unknown | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: unknown }
    return parsed?.state ?? null
  } catch {
    return null
  }
}

function readLocalZustandProfile(): { profile: UserProfile | null; settings: unknown | null } {
  const settings = readKey('dreamcode-settings')
  const shortcuts = readKey('dreamcode-shortcuts')
  const memoryCards = readKey('dreamcode-memory-cards')
  if (!settings && !shortcuts && !memoryCards) return { profile: null, settings: null }
  const settingsRecord =
    typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>) : {}
  const profile = {
    version: 1 as const,
    appearance: {
      theme: settingsRecord.theme === 'dark' ? ('dark' as const) : ('light' as const),
      opacity: typeof settingsRecord.opacity === 'number' ? settingsRecord.opacity : 0.8,
      fontSize: typeof settingsRecord.fontSize === 'number' ? settingsRecord.fontSize : 14
    },
    shortcuts:
      typeof shortcuts === 'object' && shortcuts !== null
        ? ((shortcuts as { shortcuts?: UserProfile['shortcuts'] }).shortcuts ??
          (shortcuts as UserProfile['shortcuts']))
        : {},
    memoryCards:
      typeof memoryCards === 'object' && memoryCards !== null
        ? (memoryCards as UserProfile['memoryCards'])
        : { cards: [], selectedCardId: '', defaultCardId: '' }
  }
  const hasProfile = Boolean(shortcuts || memoryCards || settings)
  return { profile: hasProfile ? profile : null, settings }
}
