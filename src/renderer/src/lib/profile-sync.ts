import { useSettingsStore } from '@/lib/store/settings'
import { hydrateMemoryCards } from '@/lib/store/memory-cards'
import { hydrateShortcuts, useShortcutsStore } from '@/lib/store/shortcuts'
import { loadPersistedUserProfile } from './profile-save'

export async function hydrateUserProfile(): Promise<void> {
  const profile = await loadPersistedUserProfile()
  if (!profile) return
  if (typeof useSettingsStore.setState === 'function') {
    useSettingsStore.setState({
      theme: profile.appearance.theme,
      opacity: profile.appearance.opacity,
      fontSize: profile.appearance.fontSize
    })
  }
  if (typeof useShortcutsStore.setState === 'function') hydrateShortcuts(profile.shortcuts)
  if (typeof hydrateMemoryCards === 'function') hydrateMemoryCards(profile.memoryCards)
}

export function currentShortcutMap(): Record<string, { action: string; key: string }> {
  if (typeof useShortcutsStore.getState !== 'function') return {}
  return useShortcutsStore.getState().shortcuts
}
