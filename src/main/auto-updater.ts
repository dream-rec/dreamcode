import { app, dialog, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { ipcMain } from 'electron'
import { loadConfig } from './config'

const GITHUB_REPO_URL = 'https://github.com/dream-rec/dreamcode'
const GITHUB_API_LATEST = 'https://api.github.com/repos/dream-rec/dreamcode/releases/latest'

function getAppVersion(): string {
  return app.getVersion()
}

/** True when `latest` is a strictly newer semver than `current` (dev builds ahead of the release are not "updates"). */
function isNewerVersion(latest: string, current: string): boolean {
  const parse = (version: string): number[] =>
    version
      .replace(/^v/, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

async function checkForUpdateViaGitHub(): Promise<{
  hasUpdate: boolean
  latestVersion?: string
  releaseUrl?: string
}> {
  try {
    const response = await fetch(GITHUB_API_LATEST)
    if (!response.ok) return { hasUpdate: false }
    const data = await response.json()
    const latestVersion = (data.tag_name as string).replace(/^v/, '')
    const currentVersion = getAppVersion()
    const hasUpdate = isNewerVersion(latestVersion, currentVersion)
    return { hasUpdate, latestVersion, releaseUrl: data.html_url }
  } catch {
    return { hasUpdate: false }
  }
}

export function initAutoUpdater(): void {
  const config = loadConfig()
  if (!config.autoCheckUpdate) return

  if (process.platform === 'win32') {
    initWindowsUpdater()
  } else {
    initMacUpdater()
  }
}

function initWindowsUpdater(): void {
  try {
    autoUpdater.autoDownload = false

    autoUpdater.on('update-available', async () => {
      const result = await dialog.showMessageBox({
        type: 'info',
        buttons: ['立即下载', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: '发现新版本',
        message: '检测到新版本可用。',
        detail: '现在下载并安装更新吗？'
      })
      if (result.response === 0) {
        autoUpdater.downloadUpdate().catch((err) => console.error(err))
      }
    })

    autoUpdater.on('error', (error) => {
      console.error('Auto update error:', error)
    })

    autoUpdater.on('update-downloaded', async () => {
      const res = await dialog.showMessageBox({
        type: 'info',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: '更新已就绪',
        message: '更新已下载完成。',
        detail: '是否立即重启以应用更新？'
      })
      if (res.response === 0) {
        setImmediate(() => autoUpdater.quitAndInstall(false, true))
      }
    })

    autoUpdater.checkForUpdates().catch((err) => console.error(err))
  } catch (e) {
    console.error('Failed to initialize auto-updater:', e)
  }
}

async function initMacUpdater(): Promise<void> {
  const { hasUpdate, latestVersion, releaseUrl } = await checkForUpdateViaGitHub()
  if (hasUpdate && latestVersion && releaseUrl) {
    // Attach to the main window so macOS shows a sheet instead of an app-modal alert that
    // blocks the main process (and every IPC / shortcut) until it is dismissed.
    const parent =
      global.mainWindow && !global.mainWindow.isDestroyed() ? global.mainWindow : undefined
    const result = await dialog.showMessageBox(parent!, {
      type: 'info',
      buttons: ['前往下载', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '发现新版本',
      message: `检测到新版本 v${latestVersion}`,
      detail: '是否前往 GitHub 下载最新版本？'
    })
    if (result.response === 0) {
      shell.openExternal(releaseUrl)
    }
  }
}

ipcMain.handle('getAppVersion', () => {
  return getAppVersion()
})

ipcMain.handle('checkForUpdate', async () => {
  if (process.platform === 'win32') {
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result && result.updateInfo) {
        const currentVersion = getAppVersion()
        const latestVersion = result.updateInfo.version
        return { hasUpdate: isNewerVersion(latestVersion, currentVersion), latestVersion }
      }
    } catch {
      // fallback to GitHub API
    }
  }
  return checkForUpdateViaGitHub()
})

ipcMain.handle('openGitHubRelease', () => {
  shell.openExternal(`${GITHUB_REPO_URL}/releases`)
})

ipcMain.handle('openGitHubRepo', () => {
  shell.openExternal(GITHUB_REPO_URL)
})
