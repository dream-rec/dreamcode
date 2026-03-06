// Replace Electron's default icon with the app's custom icon for dev mode.
// Runs as part of postinstall so `npm run dev` shows the correct icon.

const { copyFileSync, existsSync } = require('fs')
const { join } = require('path')
const { execSync } = require('child_process')

const root = join(__dirname, '..')
const electronDist = join(root, 'node_modules', 'electron', 'dist')

if (!existsSync(electronDist)) {
  console.log('[set-dev-icon] electron not installed yet, skipping')
  process.exit(0)
}

if (process.platform === 'darwin') {
  const src = join(root, 'build', 'icon.icns')
  const electronApp = join(electronDist, 'Electron.app')
  const dest = join(electronApp, 'Contents', 'Resources', 'electron.icns')
  if (existsSync(src) && existsSync(dest)) {
    copyFileSync(src, dest)
    // Force macOS to refresh the icon cache for this app
    try {
      execSync(`touch "${electronApp}"`)
      execSync(`/usr/bin/SetFile -a "" "${electronApp}" 2>/dev/null || true`)
    } catch {}
    console.log('[set-dev-icon] macOS dock icon replaced')
  }
} else if (process.platform === 'win32') {
  const exe = join(electronDist, 'electron.exe')
  const ico = join(root, 'build', 'icon.ico')
  if (!existsSync(exe) || !existsSync(ico)) {
    console.log('[set-dev-icon] electron.exe or icon.ico not found, skipping')
    process.exit(0)
  }
  try {
    const { rcedit } = require('rcedit')
    rcedit(exe, { icon: ico }).then(() => {
      console.log('[set-dev-icon] Windows exe icon replaced')
    }).catch((err) => {
      console.log('[set-dev-icon] failed to set Windows icon:', err.message)
    })
  } catch {
    console.log('[set-dev-icon] rcedit not installed, Windows users run: npm i -D rcedit')
  }
} else {
  console.log('[set-dev-icon] Linux uses BrowserWindow icon property, no action needed')
}
