// Replace Electron's default icon with the app's own icon in dev mode.
//
// macOS: the dev Dock icon comes from the Electron.app bundle, so the bundle's
// electron.icns is regenerated from resources/favor.png. Runs on postinstall and
// on every `npm run dev`, so a refreshed node_modules heals itself.
// Windows: the exe icon is patched with rcedit.

const { execFileSync } = require('child_process')
const { existsSync, mkdirSync, rmSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')

const root = join(__dirname, '..')
const electronDist = join(root, 'node_modules', 'electron', 'dist')

if (!existsSync(electronDist)) {
  console.log('[set-dev-icon] electron not installed yet, skipping')
  process.exit(0)
}

function macosDockIcon() {
  const src = join(root, 'resources', 'favor.png')
  const electronApp = join(electronDist, 'Electron.app')
  const target = join(electronApp, 'Contents', 'Resources', 'electron.icns')

  if (!existsSync(src) || !existsSync(target)) {
    console.log('[set-dev-icon] resources/favor.png or electron.icns not found, skipping')
    return
  }

  // iconutil needs a full .iconset; sizes above the 256px source get upscaled,
  // which is harmless because the Dock only ever renders up to 128pt.
  const iconset = join(tmpdir(), `dreamcode-dev-icon-${process.pid}.iconset`)
  const variants = [
    [16, 1],
    [16, 2],
    [32, 1],
    [32, 2],
    [64, 1],
    [64, 2],
    [128, 1],
    [128, 2],
    [256, 1],
    [256, 2],
    [512, 1],
    [512, 2]
  ]

  try {
    rmSync(iconset, { recursive: true, force: true })
    mkdirSync(iconset)
    for (const [size, scale] of variants) {
      const pixels = String(size * scale)
      const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`
      execFileSync('sips', ['-z', pixels, pixels, src, '--out', join(iconset, name)], {
        stdio: 'ignore'
      })
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', target], { stdio: 'ignore' })
    // Bump the bundle so macOS drops its cached icon for this app.
    execFileSync('touch', [electronApp])
    try {
      execFileSync('/usr/bin/SetFile', ['-a', '', electronApp], { stdio: 'ignore' })
    } catch {}
    console.log('[set-dev-icon] macOS dock icon regenerated from resources/favor.png')
  } catch (error) {
    console.log('[set-dev-icon] failed to build the macOS icon:', error.message)
  } finally {
    rmSync(iconset, { recursive: true, force: true })
  }
}

if (process.platform === 'darwin') {
  macosDockIcon()
} else if (process.platform === 'win32') {
  const exe = join(electronDist, 'electron.exe')
  const ico = join(root, 'build', 'icon.ico')
  if (!existsSync(exe) || !existsSync(ico)) {
    console.log('[set-dev-icon] electron.exe or icon.ico not found, skipping')
    process.exit(0)
  }
  try {
    const { rcedit } = require('rcedit')
    rcedit(exe, { icon: ico })
      .then(() => {
        console.log('[set-dev-icon] Windows exe icon replaced')
      })
      .catch((err) => {
        console.log('[set-dev-icon] failed to set Windows icon:', err.message)
      })
  } catch {
    console.log('[set-dev-icon] rcedit not installed, Windows users run: npm i -D rcedit')
  }
} else {
  console.log('[set-dev-icon] Linux uses BrowserWindow icon property, no action needed')
}
