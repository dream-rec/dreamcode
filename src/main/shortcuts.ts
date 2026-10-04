import { globalShortcut, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  captureNewQuestion,
  collectScreenshot,
  sendScreenshotFollowUp,
  stopScreenshotStream
} from './screenshots'
import { state } from './state'
import { activatePromptGroupAt, activateProviderGroupAt } from './settings'
import * as voice from './voice'

type Shortcut = {
  action: string
  key: string
  status: ShortcutStatus
  registeredKeys: string[]
}

enum ShortcutStatus {
  Registered = 'registered',
  Failed = 'failed',
  /** Shortcut is available to register but not registered. */
  Available = 'available'
}

const MOVE_STEP = 200
const shortcuts: Record<string, Shortcut> = {}

const FRONT_REASSERT_DURATION = 5000
const FRONT_REASSERT_INTERVAL = 150
const FRONT_RELATIVE_LEVEL = 10
let frontReassertTimer: NodeJS.Timeout | null = null

function applyTopMost(win: BrowserWindow) {
  if (!win || win.isDestroyed()) return
  win.setAlwaysOnTop(true, 'screen-saver', FRONT_RELATIVE_LEVEL)
  win.moveTop()
}

function keepWindowInFront(window: BrowserWindow) {
  if (!window || window.isDestroyed()) return
  if (frontReassertTimer) {
    clearInterval(frontReassertTimer)
    frontReassertTimer = null
  }

  const start = Date.now()
  const reassert = () => {
    if (!window.isVisible() || window.isDestroyed()) return false
    applyTopMost(window)
    return true
  }

  if (!reassert()) return

  frontReassertTimer = setInterval(() => {
    const shouldStop = Date.now() - start > FRONT_REASSERT_DURATION
    if (shouldStop || !reassert()) {
      if (frontReassertTimer) {
        clearInterval(frontReassertTimer)
        frontReassertTimer = null
      }
    }
  }, FRONT_REASSERT_INTERVAL)
}

const callbacks: Record<string, () => void> = {
  hideOrShowMainWindow: async () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      // 重新显示时不断重申置顶属性，抵消其他前台软件持续抢占
      if (process.platform === 'darwin' || process.platform === 'win32') {
        mainWindow.showInactive()
      } else {
        mainWindow.show()
      }
      keepWindowInFront(mainWindow)
    }
  },

  takeScreenshot: async () => {
    await captureNewQuestion()
  },

  appendScreenshot: async () => {
    await collectScreenshot()
  },

  // Stop current AI solution stream (screenshot answer or voice answer)
  stopSolutionStream: () => {
    stopScreenshotStream()
    voice.stopAnswer()
  },

  // Voice assistant
  toggleVoiceListening: async () => {
    await voice.toggleListening()
  },
  voiceSendNow: async () => {
    await voice.sendNow()
  },
  cancelVoiceListening: async () => {
    await voice.cancelListening()
  },
  clearVoiceSession: () => {
    voice.clearSession()
  },
  voiceSelectPrev: () => {
    voice.moveSelection(-1)
  },
  voiceSelectNext: () => {
    voice.moveSelection(1)
  },
  voiceSendSelected: async () => {
    await voice.sendSelected()
  },

  ignoreOrEnableMouse: () => {
    // 语音页/记忆卡片页同样需要穿透（覆盖在会议窗口上时），因此不限制当前页面
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    state.ignoreMouse = !state.ignoreMouse
    mainWindow.setIgnoreMouseEvents(state.ignoreMouse)
    mainWindow.webContents.send('sync-app-state', state)
  },
  pageUp: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('scroll-page-up')
  },

  pageDown: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('scroll-page-down')
  },

  backToCoderPage: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('navigate-coder-page')
  },

  switchToCard1: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('navigate-memory-card', 0)
  },
  switchToCard2: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('navigate-memory-card', 1)
  },
  switchToCard3: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('navigate-memory-card', 2)
  },
  switchToCard4: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('navigate-memory-card', 3)
  },
  switchToCard5: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('navigate-memory-card', 4)
  },
  switchToCard6: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('navigate-memory-card', 5)
  },
  switchToCard7: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('navigate-memory-card', 6)
  },
  switchToCard8: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('navigate-memory-card', 7)
  },
  switchToCard9: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('navigate-memory-card', 8)
  },

  moveMainWindowUp: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x, y - MOVE_STEP)
  },

  moveMainWindowDown: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x, y + MOVE_STEP)
  },

  moveMainWindowLeft: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x - MOVE_STEP, y)
  },

  moveMainWindowRight: () => {
    const mainWindow = global.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return
    const [x, y] = mainWindow.getPosition()
    mainWindow.setPosition(x + MOVE_STEP, y)
  }
}

for (let index = 0; index < 12; index += 1) {
  callbacks[`switchToProviderGroup${index + 1}`] = () => {
    activateProviderGroupAt(index)
  }
  callbacks[`switchToPromptGroup${index + 1}`] = () => {
    activatePromptGroupAt(index)
  }
}

function unregisterShortcut(action: string) {
  const shortcut = shortcuts[action]
  if (!shortcut) return
  if (shortcut.registeredKeys.length) {
    shortcut.registeredKeys.forEach((registeredKey) => {
      globalShortcut.unregister(registeredKey)
    })
  }
  shortcut.status = ShortcutStatus.Available
  shortcut.registeredKeys = []
}

function getShortcutRegistrationKeys(key: string, includeWindowsAlias = true) {
  const keys = [key]
  if (process.platform !== 'win32' || !includeWindowsAlias) {
    return keys
  }
  const parts = key.split('+')
  const hasAlt = parts.includes('Alt')
  const hasCtrl = parts.includes('CommandOrControl') || parts.includes('Control')
  if (hasAlt && !hasCtrl) {
    const aliasParts = [...parts]
    const altIndex = aliasParts.indexOf('Alt')
    if (altIndex >= 0) {
      aliasParts.splice(altIndex, 0, 'CommandOrControl')
      const aliasKey = aliasParts.join('+')
      if (!keys.includes(aliasKey)) {
        keys.push(aliasKey)
      }
    }
  }
  return keys
}

function registerShortcut(action: string, key: string) {
  const callback = callbacks[action]
  if (!callback) return
  const runCallback = () => {
    Promise.resolve(callback()).catch((error) => {
      console.error(`Error running shortcut "${action}":`, error)
    })
  }

  if (shortcuts[action]) {
    unregisterShortcut(action)
  }

  const isGroupShortcut = /^switchTo(?:Provider|Prompt)Group\d+$/.test(action)
  const keysToRegister = getShortcutRegistrationKeys(key, !isGroupShortcut)
  const registeredKeys: string[] = []
  keysToRegister.forEach((shortcutKey) => {
    try {
      if (globalShortcut.register(shortcutKey, runCallback)) registeredKeys.push(shortcutKey)
    } catch (error) {
      console.error(`Cannot register shortcut ${shortcutKey}:`, error)
    }
  })

  shortcuts[action] = {
    action,
    key,
    status: registeredKeys.length ? ShortcutStatus.Registered : ShortcutStatus.Failed,
    registeredKeys
  }
}

ipcMain.handle('getShortcuts', () => shortcuts)

ipcMain.handle(
  'initShortcuts',
  (_event, nextShortcuts: Record<string, { action: string; key: string }>) => {
    // 渲染进程上报的是完整配置：除了注册新增/变更项，还要释放已从配置里移除的动作，
    // 否则废弃动作会一直占着旧按键，直到主进程重启。
    Object.entries(nextShortcuts).forEach(([action, { key }]) => registerShortcut(action, key))
    Object.keys(shortcuts).forEach((action) => {
      if (nextShortcuts[action]) return
      unregisterShortcut(action)
      delete shortcuts[action]
    })
  }
)

ipcMain.handle('updateShortcuts', (_event, _shortcuts: { action: string; key: string }[]) => {
  _shortcuts.forEach((shortcut) => {
    if (shortcuts[shortcut.action]?.key !== shortcut.key) {
      registerShortcut(shortcut.action, shortcut.key)
    }
  })
})

ipcMain.handle('stopSolutionStream', () => {
  stopScreenshotStream()
  return true
})

ipcMain.handle('sendFollowUpQuestion', (_event, question: string) =>
  sendScreenshotFollowUp(question)
)
