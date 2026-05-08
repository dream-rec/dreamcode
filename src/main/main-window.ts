import { join } from 'node:path'
import { shell, app, BrowserWindow, ipcMain, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

export function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    frame: false,
    transparent: true,
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1)
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    app.dock?.show()
    mainWindow.setContentProtection(true)
  })

  // macOS: other apps entering/exiting fullscreen triggers display-metrics-changed,
  // causing Chromium to recalculate backing scale factor in packaged builds.
  // Delay reset to fire after Chromium's internal recalculation completes.
  screen.on('display-metrics-changed', () => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.setZoomFactor(1)
    setTimeout(() => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.setZoomFactor(1)
      }
    }, 100)
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
