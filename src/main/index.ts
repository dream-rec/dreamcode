import 'dotenv/config'
import { app, BrowserWindow, globalShortcut } from 'electron'

type AbortLikeError = {
  name?: string
  code?: string
  message?: unknown
}

// Swallow AbortError from user-initiated stream cancellations to keep console clean
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const err = error as AbortLikeError
  const message = typeof err.message === 'string' ? err.message : ''
  return err.name === 'AbortError' || err.code === 'ABORT_ERR' || /aborted/i.test(message)
}

process.on('unhandledRejection', (error) => {
  if (isAbortError(error)) return
  console.error(error)
})

process.on('uncaughtException', (error) => {
  if (isAbortError(error)) return
  console.error(error)
})
import { electronApp, optimizer } from '@electron-toolkit/utils'
import './shortcuts'
import { createWindow } from './main-window'
import { initAutoUpdater } from './auto-updater'

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // Configure auto-updater
  initAutoUpdater()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else if (global.mainWindow && !global.mainWindow.isVisible()) {
      global.mainWindow.show()
    }
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  // Unregister all shortcuts when there is no window left
  globalShortcut.unregisterAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
