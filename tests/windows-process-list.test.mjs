import test from 'node:test'
import assert from 'node:assert/strict'
import { createLoader } from './load-ts.mjs'

const load = createLoader(
  {
    electron: {
      app: { on: () => undefined, isPackaged: false, getAppPath: () => '' },
      dialog: {},
      shell: {},
      systemPreferences: {}
    }
  },
  { TextDecoder }
)
const audio = load('src/main/app-audio.ts')

test('Windows process list script separates the encoding assignment from Get-Process', () => {
  const script = audio.buildWindowsProcessListScript()
  assert.match(script, /UTF8Encoding \$false;\s+Get-Process/)
  assert.doesNotMatch(script, /::UTF8 Get-Process/)
  assert.doesNotMatch(script, /\|;/)
  assert.match(script, /\$OutputEncoding = \[Console\]::OutputEncoding/)
  assert.match(script, /ConvertTo-Json -Compress/)
})

test('decodePowerShellText reads UTF-8, UTF-8 BOM, and UTF-16LE', () => {
  const payload = '{"Id":1,"MainWindowTitle":"记事本"}'
  assert.equal(audio.decodePowerShellText(Buffer.from(payload, 'utf8')), payload)
  assert.equal(
    audio.decodePowerShellText(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(payload, 'utf8')])
    ),
    payload
  )
  assert.equal(
    audio.decodePowerShellText(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(payload, 'utf16le')])
    ),
    payload
  )
  assert.equal(audio.decodePowerShellText(Buffer.from(`\uFEFF${payload}`, 'utf16le')), payload)
})

test('decodePowerShellText falls back to GBK when UTF-8 is invalid', () => {
  const gbk = Buffer.from([0xcb, 0xf9, 0xd4, 0xda, 0xce, 0xbb, 0xd6, 0xc3])
  assert.equal(audio.decodePowerShellText(gbk), '所在位置')
})

test('audioAppsFromWindowsProcesses dedupes, skips itself, and keeps window titles', () => {
  const apps = audio.audioAppsFromWindowsProcesses(
    [
      { Id: 10, ProcessName: 'DreamCode', Description: 'DreamCode', MainWindowTitle: 'DreamCode' },
      { Id: 20, ProcessName: 'chrome', Description: 'Google Chrome', MainWindowTitle: 'Meet' },
      { Id: 21, ProcessName: 'chrome', Description: 'Google Chrome', MainWindowTitle: 'Other' },
      { Id: 30, ProcessName: 'notepad', Description: '', MainWindowTitle: '记事本' },
      { Id: 99, ProcessName: 'Code', Description: 'Visual Studio Code', MainWindowTitle: 'main.ts' }
    ],
    99
  )
  assert.deepEqual(
    Array.from(apps, (item) => item.id),
    ['chrome', 'notepad']
  )
  assert.equal(apps[0].name, 'Google Chrome — Meet')
  assert.equal(apps[0].pid, 20)
  assert.equal(apps[1].name, 'notepad — 记事本')
})
