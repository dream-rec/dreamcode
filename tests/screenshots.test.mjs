import test from 'node:test'
import assert from 'node:assert/strict'
import { createLoader, plain, deferred, tick } from './load-ts.mjs'

function fixture(t, streamFactory) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const handlers = new Map()
  const requests = []
  const events = []
  let imageNumber = 0
  let captureFails = false
  let captureGate = null
  let dialogs = 0
  const load = createLoader(
    {
      electron: {
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
        dialog: {
          showMessageBox: () => {
            dialogs++
            throw new Error('Unexpected dialog')
          }
        }
      },
      './take-screenshot': {
        takeScreenshot: async () => {
          if (captureGate) await captureGate.promise
          return captureFails ? undefined : `image-${++imageNumber}`
        }
      },
      './settings': { settings: { apiKey: 'mock-only' } },
      './state': { state: { inCoderPage: true } },
      './ai': {
        getGeneralStream: (messages, signal) => {
          requests.push({ messages: plain(messages), signal })
          return streamFactory
            ? streamFactory(requests.length)
            : (async function* () {
                yield `answer-${requests.length}`
              })()
        }
      }
    },
    {
      global: {
        mainWindow: {
          isDestroyed: () => false,
          webContents: { send: (name, data) => events.push({ name, data: plain(data) }) }
        }
      }
    }
  )
  const api = load('src/main/screenshots.ts')
  const state = () => plain(handlers.get('screenshot:getState')())
  t.after(() => assert.equal(dialogs, 0))
  return {
    api,
    requests,
    state,
    events,
    handlers,
    failCapture: () => {
      captureFails = true
    },
    delayCapture: (gate) => {
      captureGate = gate
    },
    advance: async (ms = 2000) => {
      t.mock.timers.tick(ms)
      await tick()
    }
  }
}
const images = (message) =>
  message.content.filter((part) => part.type === 'image').map((part) => part.image)

test('new question sends at 2000ms, not at 0ms or 1999ms; no manual IPC or dialogs', async (t) => {
  const f = fixture(t)
  await f.api.captureNewQuestion()
  assert.equal(f.requests.length, 0)
  await f.advance(1999)
  assert.equal(f.requests.length, 0)
  await f.advance(1)
  assert.equal(f.requests.length, 1)
  assert.equal(f.state().solution, 'answer-1')
  assert.equal(f.handlers.has('screenshot:send'), false)
  assert.equal(f.handlers.has('screenshot:discard'), false)
})

test('consecutive append resets the trailing timer and groups all original images into one user turn', async (t) => {
  const f = fixture(t)
  await f.api.captureNewQuestion()
  await f.advance(1500)
  await f.api.collectScreenshot()
  await f.advance(1999)
  assert.equal(f.requests.length, 0)
  await f.api.collectScreenshot()
  await f.advance(1999)
  assert.equal(f.requests.length, 0)
  await f.advance(1)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].messages.length, 1)
  assert.deepEqual(images(f.requests[0].messages[0]), ['image-1', 'image-2', 'image-3'])
})

test('append from empty state works; full original/reply and both feedback rounds exceed five previews', async (t) => {
  const f = fixture(t)
  for (let i = 0; i < 3; i++) await f.api.collectScreenshot()
  await f.advance()
  for (let i = 0; i < 3; i++) await f.api.collectScreenshot()
  assert.equal(f.requests.length, 1)
  assert.equal(f.state().solution, 'answer-1')
  await f.advance()
  await f.api.collectScreenshot()
  await f.advance()
  const messages = f.requests[2].messages
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant', 'user']
  )
  assert.deepEqual(images(messages[0]), ['image-1', 'image-2', 'image-3'])
  assert.equal(messages[1].content, 'answer-1')
  assert.deepEqual(images(messages[2]), ['image-4', 'image-5', 'image-6'])
  assert.equal(messages[3].content, 'answer-2')
  assert.deepEqual(images(messages[4]), ['image-7'])
  assert.equal(f.state().recentScreenshots.length, 5)
})

test('expired next feedback batch waits for streaming to finish without overlapping or losing captures', async (t) => {
  const gate = deferred()
  const f = fixture(t, (n) =>
    (async function* () {
      if (n === 2) await gate.promise
      yield `answer-${n}`
    })()
  )
  await f.api.captureNewQuestion()
  await f.advance()
  await f.api.collectScreenshot()
  await f.advance()
  await f.api.collectScreenshot()
  await f.api.collectScreenshot()
  await f.advance()
  assert.equal(f.requests.length, 2)
  assert.equal(f.state().pendingCount, 2)
  gate.resolve()
  await tick()
  assert.equal(f.requests.length, 3)
  assert.deepEqual(images(f.requests[2].messages.at(-1)), ['image-3', 'image-4'])
  assert.equal(f.requests[2].messages[3].content, 'answer-2')
})

test('append during first answer freezes original role even when answer completes before debounce', async (t) => {
  const gate = deferred()
  const f = fixture(t, (n) =>
    (async function* () {
      if (n === 1) await gate.promise
      yield `answer-${n}`
    })()
  )
  await f.api.captureNewQuestion()
  await f.advance()
  await f.api.collectScreenshot()
  gate.resolve()
  await tick()
  await f.advance(1999)
  assert.equal(f.requests.length, 1)
  await f.advance(1)
  assert.equal(f.requests[1].messages.length, 1)
  assert.deepEqual(images(f.requests[1].messages[0]), ['image-1', 'image-2'])
})

test('role is chosen before asynchronous capture resolves and trigger prevents imminent sends', async (t) => {
  const answerGate = deferred(),
    captureGate = deferred()
  const f = fixture(t, (n) =>
    (async function* () {
      if (n === 1) await answerGate.promise
      yield `answer-${n}`
    })()
  )
  await f.api.captureNewQuestion()
  await f.advance()
  f.delayCapture(captureGate)
  const capture = f.api.collectScreenshot()
  await tick()
  answerGate.resolve()
  await tick()
  await f.advance(5000)
  assert.equal(f.requests.length, 1)
  captureGate.resolve()
  await capture
  await f.advance(1999)
  assert.equal(f.requests.length, 1)
  await f.advance(1)
  assert.equal(f.requests[1].messages.length, 1)
  assert.deepEqual(images(f.requests[1].messages[0]), ['image-1', 'image-2'])
})

test('failed feedback does not retry itself; next append merges retained input into one attempt', async (t) => {
  const f = fixture(t, (n) =>
    (async function* () {
      if (n === 2) {
        yield 'incomplete'
        throw new Error('mock failure')
      }
      yield `answer-${n}`
    })()
  )
  await f.api.captureNewQuestion()
  await f.advance()
  await f.api.collectScreenshot()
  await f.advance()
  assert.equal(f.state().retry, true)
  await f.advance(60000)
  assert.equal(f.requests.length, 2)
  await f.api.collectScreenshot()
  await f.advance()
  assert.equal(f.requests.length, 3)
  assert.deepEqual(images(f.requests[2].messages.at(-1)), ['image-2', 'image-3'])
  assert.deepEqual(
    f.requests[2].messages.map((m) => m.role),
    ['user', 'assistant', 'user']
  )
  assert.equal(f.requests[2].messages[1].content, 'answer-1')
  assert.equal(f.state().pendingCount, 0)
  await f.advance(60000)
  assert.equal(f.requests.length, 3)
})

test('failure with an expired next batch preserves all images without runaway retry', async (t) => {
  const gate = deferred()
  const f = fixture(t, (n) =>
    (async function* () {
      if (n === 1) {
        await gate.promise
        throw new Error('initial failed')
      }
      yield 'complete'
    })()
  )
  await f.api.captureNewQuestion()
  await f.advance()
  await f.api.collectScreenshot()
  await f.advance()
  gate.resolve()
  await tick()
  await f.advance(60000)
  assert.equal(f.requests.length, 1)
  assert.equal(f.state().pendingCount, 2)
  await f.api.collectScreenshot()
  await f.advance()
  assert.equal(f.requests.length, 2)
  assert.deepEqual(images(f.requests[1].messages[0]), ['image-1', 'image-2', 'image-3'])
})

test('stopped request retains input, ignores late chunks and lets a later append re-arm one attempt', async (t) => {
  const gate = deferred()
  const f = fixture(t, (n) =>
    (async function* () {
      yield `part-${n}`
      if (n === 1) await gate.promise
    })()
  )
  await f.api.captureNewQuestion()
  await f.advance()
  f.api.stopScreenshotStream()
  await f.api.collectScreenshot()
  await f.advance()
  assert.equal(f.requests.length, 1)
  gate.resolve()
  await tick()
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].messages.length, 1)
  assert.deepEqual(images(f.requests[1].messages[0]), ['image-1', 'image-2'])
  assert.equal(f.state().solution, 'part-2')
})

test('successful new capture replaces pending work without dialogs; failed new capture retains context', async (t) => {
  const gate = deferred()
  const f = fixture(t, (n) =>
    (async function* () {
      if (n === 1) await gate.promise
      yield `answer-${n}`
    })()
  )
  await f.api.captureNewQuestion()
  await f.advance()
  await f.api.collectScreenshot()
  await f.api.captureNewQuestion()
  await f.advance()
  assert.equal(f.requests.length, 1)
  gate.resolve()
  await tick()
  assert.equal(f.requests.length, 2)
  assert.deepEqual(images(f.requests[1].messages[0]), ['image-3'])
  assert.equal(f.state().solution, 'answer-2')
  f.failCapture()
  await f.api.captureNewQuestion()
  await f.advance()
  assert.equal(f.requests.length, 2)
  assert.equal(f.state().solution, 'answer-2')
  await f.api.sendScreenshotFollowUp('explain')
  assert.deepEqual(images(f.requests[2].messages[0]), ['image-3'])
})

test('failed capture must not automatically retry an already failed model request', async (t) => {
  const f = fixture(t, () =>
    (async function* () {
      yield ''
      throw new Error('offline')
    })()
  )
  await f.api.captureNewQuestion()
  await f.advance()
  f.failCapture()
  await f.api.collectScreenshot()
  await f.api.captureNewQuestion()
  await f.advance(60000)
  assert.equal(f.requests.length, 1)
  assert.equal(f.state().retry, true)
})

test('text follow-up failure is truthful; later screenshot retains the actual failed text input', async (t) => {
  const f = fixture(t, (n) =>
    (async function* () {
      if (n === 2) throw new Error('text failure')
      yield 'real answer'
    })()
  )
  await f.api.captureNewQuestion()
  await f.advance()
  const result = await f.api.sendScreenshotFollowUp('why?')
  assert.equal(result.success, false)
  assert.match(result.error, /text failure/)
  await f.api.collectScreenshot()
  await f.advance()
  assert.equal(f.requests.length, 3)
  assert.equal(f.requests[2].messages[1].content, 'real answer')
  assert.equal(f.requests[2].messages.at(-1).content[0].text, 'why?')
  assert.deepEqual(images(f.requests[2].messages.at(-1)), ['image-2'])
})

test('v10 migration removes obsolete manual actions and preserves all other custom bindings', () => {
  let options
  const load = createLoader({
    zustand: { create: () => (initializer) => initializer(() => {}) },
    'zustand/middleware': {
      persist: (initializer, config) => {
        options = config
        return initializer
      }
    },
    '@/lib/utils/env': { isMac: true }
  })
  load('src/renderer/src/lib/store/shortcuts.ts')
  assert.equal(options.version, 10)
  for (const version of [7, 8, 9]) {
    const previous = {
      shortcuts: {
        appendScreenshot: { action: 'appendScreenshot', key: 'Control+8' },
        takeScreenshot: { action: 'takeScreenshot', key: 'Control+9' },
        toggleVoiceListening: { action: 'toggleVoiceListening', key: 'Control+L' },
        followUpScreenshot: { action: 'followUpScreenshot', key: 'Alt+F' },
        sendScreenshots: { action: 'sendScreenshots', key: 'Alt+S' },
        openMemoryCards: { action: 'openMemoryCards', key: 'CommandOrControl+R' }
      }
    }
    const next = options.migrate(previous, version)
    assert.equal(next.shortcuts.appendScreenshot.key, 'Control+8')
    assert.equal(next.shortcuts.takeScreenshot.key, 'Control+9')
    assert.equal(next.shortcuts.toggleVoiceListening.key, 'Control+L')
    assert.equal(next.shortcuts.followUpScreenshot, undefined)
    assert.equal(next.shortcuts.sendScreenshots, undefined)
    assert.equal(next.shortcuts.openMemoryCards, undefined)
  }
})

test('obsolete shortcut callbacks are unavailable and reassigning a failed key preserves its owner', () => {
  const handlers = new Map(),
    registered = new Map()
  const load = createLoader({
    electron: {
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      globalShortcut: {
        register: (key, callback) => {
          if (registered.has(key)) return false
          registered.set(key, callback)
          return true
        },
        unregister: (key) => registered.delete(key)
      }
    },
    './screenshots': {},
    './settings': {},
    './voice': {},
    './state': { state: {} }
  })
  load('src/main/shortcuts.ts')
  handlers.get('initShortcuts')(
    {},
    {
      takeScreenshot: { key: 'Alt+Shift+F' },
      appendScreenshot: { key: 'Alt+Shift+F' },
      followUpScreenshot: { key: 'Alt+F' },
      sendScreenshots: { key: 'Alt+S' },
      openMemoryCards: { key: 'CommandOrControl+R' }
    }
  )
  const state = handlers.get('getShortcuts')()
  assert.equal(state.takeScreenshot.status, 'registered')
  assert.equal(state.appendScreenshot.status, 'failed')
  assert.equal(state.followUpScreenshot, undefined)
  assert.equal(state.sendScreenshots, undefined)
  assert.equal(state.openMemoryCards, undefined)
  assert.equal(registered.has('CommandOrControl+R'), false)
  const originalCallback = registered.get('Alt+Shift+F')
  handlers.get('updateShortcuts')({}, [{ action: 'appendScreenshot', key: 'Alt+Shift+G' }])
  assert.equal(registered.get('Alt+Shift+F'), originalCallback)
})

test('page up/down shortcuts broadcast on any page so the voice page can scroll', () => {
  const handlers = new Map(),
    registered = new Map(),
    sent = []
  const load = createLoader(
    {
      electron: {
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
        globalShortcut: {
          register: (key, callback) => {
            if (registered.has(key)) return false
            registered.set(key, callback)
            return true
          },
          unregister: (key) => registered.delete(key)
        }
      },
      './screenshots': {},
      './settings': {},
      './voice': {},
      './state': { state: { inCoderPage: false, ignoreMouse: false } }
    },
    {
      global: {
        mainWindow: {
          isDestroyed: () => false,
          webContents: { send: (channel) => sent.push(channel) }
        }
      }
    }
  )
  load('src/main/shortcuts.ts')
  handlers.get('initShortcuts')(
    {},
    {
      pageUp: { key: 'CommandOrControl+J' },
      pageDown: { key: 'CommandOrControl+K' }
    }
  )
  registered.get('CommandOrControl+J')()
  registered.get('CommandOrControl+K')()
  assert.deepEqual(sent, ['scroll-page-up', 'scroll-page-down'])
})
