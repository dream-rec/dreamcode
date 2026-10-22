import { app, ipcMain } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { copyLegacyFile, recoverLegacyStores } from './legacy-import'
import { writeJsonAtomic } from './json-file'
import { normalizeShortcutMap } from '../shared/shortcuts'
import {
  createDefaultProfile,
  normalizeMemoryCards,
  normalizeUserProfile,
  type AppearanceSettings,
  type MemoryCardsPersisted,
  type UserProfile
} from '../shared/user-profile'

function profilePath(): string {
  return join(app.getPath('userData'), 'user-profile.json')
}

function isMac(): boolean {
  return process.platform === 'darwin'
}

function readProfile(file: string): UserProfile | null {
  try {
    return normalizeUserProfile(JSON.parse(readFileSync(file, 'utf8')), isMac())
  } catch {
    return null
  }
}

function loadProfile(): UserProfile | null {
  const destination = profilePath()
  if (existsSync(destination)) return readProfile(destination)
  const copied = copyLegacyFile('user-profile.json', app.getPath('userData'))
  if (copied) return readProfile(copied)
  return null
}

let profile: UserProfile | null = loadProfile()
let writing: Promise<unknown> = Promise.resolve()

function persist(next: UserProfile): UserProfile {
  profile = next
  writeJsonAtomic(profilePath(), next)
  return next
}

function enqueue(update: () => UserProfile): Promise<UserProfile> {
  const result = writing.then(update, update)
  writing = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function current(): UserProfile {
  return profile ?? createDefaultProfile(isMac())
}

export function getUserProfile(): UserProfile | null {
  return profile
}

ipcMain.handle('getUserProfile', () => profile)

ipcMain.handle('saveUserProfile', (_event, incoming: unknown) =>
  enqueue(() => persist(normalizeUserProfile(incoming, isMac())))
)

ipcMain.handle('saveAppearance', (_event, appearance: AppearanceSettings) =>
  enqueue(() => persist(normalizeUserProfile({ ...current(), appearance }, isMac())))
)

ipcMain.handle('saveShortcuts', (_event, shortcuts: unknown) =>
  enqueue(() =>
    persist(
      normalizeUserProfile(
        { ...current(), shortcuts: normalizeShortcutMap(shortcuts, isMac()) },
        isMac()
      )
    )
  )
)

ipcMain.handle('saveMemoryCards', (_event, memoryCards: MemoryCardsPersisted) =>
  enqueue(() => {
    const normalized = normalizeMemoryCards(memoryCards)
    return persist(
      normalizeUserProfile(
        {
          ...current(),
          memoryCards: normalized.recognized ? normalized.cards : current().memoryCards
        },
        isMac()
      )
    )
  })
)

ipcMain.handle('recoverLegacyProfile', async () => {
  if (profile) return profile
  const recovered = recoverLegacyStores()
  if (!recovered.shortcuts && !recovered.memoryCards) return null
  return enqueue(() => {
    if (profile) return profile
    return persist(
      normalizeUserProfile(
        {
          ...(isRecord(recovered.settings) ? recovered.settings : {}),
          shortcuts: recovered.shortcuts ?? undefined,
          memoryCards: recovered.memoryCards ?? undefined
        },
        isMac()
      )
    )
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
