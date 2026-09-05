import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { app, desktopCapturer, dialog, screen, shell, systemPreferences } from 'electron'

const execFileAsync = promisify(execFile)

const SCREEN_PERMISSION_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

function getScreenPermissionStatus() {
  if (process.platform !== 'darwin') return 'granted'
  return systemPreferences.getMediaAccessStatus('screen')
}

async function showScreenPermissionDialog() {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '需要屏幕录制权限',
    message: 'DreamCode 无法捕捉屏幕',
    detail:
      '请在“系统设置 → 隐私与安全性 → 屏幕录制”中允许当前应用，然后完全退出并重新启动 DreamCode。\n\n使用 npm run dev 时，请允许列表中的 Electron。',
    buttons: ['打开系统设置', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })

  if (response === 0) {
    await shell.openExternal(SCREEN_PERMISSION_SETTINGS)
  }
}

function getMacScreenshotHelperPath() {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'capture-below')
    : join(__dirname, 'bin', 'capture-below')
}

async function takeMacScreenshot(): Promise<string> {
  const helperPath = getMacScreenshotHelperPath()
  const outputPath = join(
    tmpdir(),
    `dreamcode-screenshot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
  )

  try {
    await execFileAsync(helperPath, [String(process.pid), outputPath])
    const screenshot = await readFile(outputPath)
    return screenshot.toString('base64')
  } finally {
    await unlink(outputPath).catch(() => undefined)
  }
}

async function takeDesktopScreenshot(): Promise<string | undefined> {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.size
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })
  const source = sources[0]

  if (!source || source.thumbnail.isEmpty()) return undefined
  return source.thumbnail.toPNG().toString('base64')
}

export async function takeScreenshot(): Promise<string | undefined> {
  const mainWindow = global.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return undefined

  const permissionStatus = getScreenPermissionStatus()
  if (permissionStatus === 'denied' || permissionStatus === 'restricted') {
    await showScreenPermissionDialog()
    return undefined
  }

  try {
    const screenshot =
      process.platform === 'darwin' ? await takeMacScreenshot() : await takeDesktopScreenshot()

    if (!screenshot) {
      console.error('Error taking screenshot: No screen source is available.')
      return undefined
    }

    return screenshot
  } catch (error) {
    if (process.platform === 'darwin' && getScreenPermissionStatus() !== 'granted') {
      await showScreenPermissionDialog()
    } else {
      console.error('Error taking screenshot:', error)
    }
    return undefined
  }
}
