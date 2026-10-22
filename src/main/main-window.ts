import { join } from 'node:path'
import { shell, app, BrowserWindow, ipcMain, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

function keepTransparentWindowInSync(mainWindow: BrowserWindow): void {
  // Windows layered windows keep the first web-contents size after a drag-resize,
  // so the native window grows and the extra area stays transparent.
  if (process.platform !== 'win32') return
  let suppress = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const nudge = () => {
    timer = null
    if (suppress > 0 || mainWindow.isDestroyed() || mainWindow.isMinimized()) return
    const bounds = mainWindow.getBounds()
    if (bounds.width < 2 || bounds.height < 2) return
    suppress += 1
    mainWindow.setBounds({ ...bounds, width: bounds.width + 1 })
    mainWindow.setBounds(bounds)
    suppress -= 1
    mainWindow.webContents.invalidate()
  }
  mainWindow.on('resize', () => {
    if (suppress > 0 || mainWindow.isDestroyed()) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(nudge, 80)
  })
  mainWindow.on('closed', () => {
    if (timer) clearTimeout(timer)
  })
}

export function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      zoomFactor: 1
    }
  })

  // Store reference to mainWindow globally
  global.mainWindow = mainWindow

  mainWindow.setMenuBarVisibility(false)
  keepTransparentWindowInSync(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1)
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    app.dock?.show()
    mainWindow.setContentProtection(true)
  })

  // macOS: other apps entering/exiting fullscreen triggers a display
  // configuration change that corrupts the backing store scale of transparent
  // windows in packaged builds. Force Chromium to recalculate by toggling
  // window bounds, and lock zoom from both main and renderer sides.
  screen.on('display-metrics-changed', () => {
    if (mainWindow.isDestroyed()) return
    const bounds = mainWindow.getBounds()
    mainWindow.setBounds({ ...bounds, width: bounds.width + 1 })
    mainWindow.setBounds(bounds)
    mainWindow.webContents.setZoomFactor(1)
    mainWindow.webContents.setZoomLevel(0)
    setTimeout(() => {
      if (mainWindow.isDestroyed()) return
      mainWindow.webContents.setZoomFactor(1)
      mainWindow.webContents.setZoomLevel(0)
      mainWindow.webContents.invalidate()
    }, 150)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('minimizeWindow', () => {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.hide()
})

ipcMain.handle('maximizeWindow', () => {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow.maximize()
  }
})
