export interface ShortcutDefinition {
  action: string
  key: string
  category: string
  /** Current built-in binding. A saved map may override `key` without changing this. */
  defaultKey: string
}

const promptGroupKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=']

function define(
  action: string,
  key: string,
  category: string
): [string, Omit<ShortcutDefinition, 'defaultKey'>] {
  return [action, { action, key, category }]
}

/** Built-in bindings. `isMac` only changes the default modifier for provider/prompt groups. */
export function createDefaultShortcuts(isMac: boolean): Record<string, ShortcutDefinition> {
  const groupModifier = isMac ? 'CommandOrControl' : 'Alt'
  const entries: [string, Omit<ShortcutDefinition, 'defaultKey'>][] = [
    define('hideOrShowMainWindow', 'Alt+H', 'Window Management'),
    define('ignoreOrEnableMouse', 'Alt+M', 'Window Management'),
    define('takeScreenshot', 'Alt+Enter', 'Screenshot & AI'),
    define('appendScreenshot', 'Alt+Shift+Enter', 'Screenshot & AI'),
    define('stopSolutionStream', 'Alt+.', 'Screenshot & AI'),
    define('toggleVoiceListening', 'Alt+L', 'Voice Assistant'),
    define('voiceSendNow', 'Alt+Shift+L', 'Voice Assistant'),
    define('clearVoiceSession', 'Alt+Shift+,', 'Voice Assistant'),
    define('voiceSelectPrev', 'Alt+Up', 'Voice Assistant'),
    define('voiceSelectNext', 'Alt+Down', 'Voice Assistant'),
    define('voiceSendSelected', 'Alt+/', 'Voice Assistant'),
    define('pageUp', 'CommandOrControl+J', 'Navigation'),
    define('pageDown', 'CommandOrControl+K', 'Navigation'),
    define('backToCoderPage', 'CommandOrControl+R', 'Navigation'),
    define('backToVoicePage', 'Alt+,', 'Navigation'),
    define('switchToCard1', 'CommandOrControl+1', 'Memory Cards'),
    define('switchToCard2', 'CommandOrControl+2', 'Memory Cards'),
    define('switchToCard3', 'CommandOrControl+3', 'Memory Cards'),
    define('switchToCard4', 'CommandOrControl+4', 'Memory Cards'),
    define('switchToCard5', 'CommandOrControl+5', 'Memory Cards'),
    define('switchToCard6', 'CommandOrControl+6', 'Memory Cards'),
    define('switchToCard7', 'CommandOrControl+7', 'Memory Cards'),
    define('switchToCard8', 'CommandOrControl+8', 'Memory Cards'),
    define('switchToCard9', 'CommandOrControl+9', 'Memory Cards'),
    define('moveMainWindowUp', 'CommandOrControl+Up', 'Window Movement'),
    define('moveMainWindowDown', 'CommandOrControl+Down', 'Window Movement'),
    define('moveMainWindowLeft', 'CommandOrControl+Left', 'Window Movement'),
    define('moveMainWindowRight', 'CommandOrControl+Right', 'Window Movement')
  ]
  for (let index = 0; index < 12; index += 1) {
    const slot = index + 1
    entries.push(define(`switchToProviderGroup${slot}`, `${groupModifier}+F${slot}`, 'Provider 组'))
    entries.push(
      define(
        `switchToPromptGroup${slot}`,
        `${groupModifier}+Shift+${promptGroupKeys[index]}`,
        'Prompt 组'
      )
    )
  }
  return Object.fromEntries(
    entries.map(([action, shortcut]) => [action, { ...shortcut, defaultKey: shortcut.key }])
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readSavedMap(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  if (isRecord(value.shortcuts)) return value.shortcuts
  return value
}

/**
 * Keep the user's bindings, fill actions added in later versions, and drop actions
 * this version no longer registers. `defaultKey` always comes from the current build.
 */
export function normalizeShortcutMap(
  value: unknown,
  isMac: boolean
): Record<string, ShortcutDefinition> {
  const defaults = createDefaultShortcuts(isMac)
  const saved = readSavedMap(value)
  return Object.fromEntries(
    Object.entries(defaults).map(([action, fallback]) => {
      const item = saved[action]
      const key =
        isRecord(item) && typeof item.key === 'string' && item.key.trim() ? item.key : fallback.key
      return [action, { ...fallback, key }]
    })
  )
}
