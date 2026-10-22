import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Desktop installs must keep using one directory across versions.
 * The folder name is fixed (not package.json `name`, not the version) so
 * `DreamCode` and a previous `dreamcode` userData still meet on case-insensitive
 * macOS, and Windows/Linux can import the other spelling explicitly.
 */
function stableUserDataDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'DreamCode')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'DreamCode')
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configHome, 'DreamCode')
}

app.setPath('userData', stableUserDataDir())
