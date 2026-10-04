import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from 'zustand/vanilla'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createLoader, plain, deferred, tick } from './load-ts.mjs'

// Execute the real component functions/effects with a deterministic hook host, not a DOM.
// Real Zustand setters/subscriptions and the real main settings handler close the IPC chain.
function hookHost() {
  const views = new Set()
  let rendering
  const effects = []
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const slot = () => {
    assert.ok(rendering, 'hook called during render')
    const view = rendering,
      index = view.index++
    return { view, index }
  }
  const hooks = {
    useState(initial) {
      const { view, index } = slot()
      if (!(index in view.slots))
        view.slots[index] = typeof initial === 'function' ? initial() : initial
      return [
        view.slots[index],
        (value) => {
          const next = typeof value === 'function' ? value(view.slots[index]) : value
          if (!Object.is(view.slots[index], next)) {
            view.slots[index] = next
            view.dirty = true
          }
        }
      ]
    },
    useRef(initial) {
      const { view, index } = slot()
      return (view.slots[index] ??= { current: initial })
    },
    useEffect(callback, dependencies) {
      const { view, index } = slot()
      const previous = view.slots[index]
      if (same(previous?.dependencies, dependencies)) return
      effects.push(() => {
        previous?.cleanup?.()
        view.slots[index] = { dependencies, cleanup: callback() }
      })
    }
  }
  const flush = () => {
    let passes = 0
    while ([...views].some((v) => v.dirty) || effects.length) {
      assert.ok(++passes < 50, 'renderer effects must settle (possible settings echo)')
      for (const view of views) {
        if (!view.dirty) continue
        view.dirty = false
        view.index = 0
        rendering = view
        view.tree = view.component()
        view.renders++
        rendering = undefined
      }
      effects.splice(0).forEach((effect) => effect())
    }
  }
  return {
    hooks,
    flush,
    mount(component) {
      const view = { component, dirty: true, slots: [], renders: 0 }
      views.add(view)
      flush()
      return view
    },
    bindStore(store) {
      const readers = new Set()
      store.subscribe(() =>
        readers.forEach((view) => {
          view.dirty = true
        })
      )
      return Object.assign((selector = (state) => state) => {
        if (rendering) readers.add(rendering)
        return selector(store.getState())
      }, store)
    },
    close() {
      for (const view of views) view.slots.forEach((s) => s?.cleanup?.())
      views.clear()
    }
  }
}

function elements(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate))
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props?.children, predicate)]
}
function find(view, predicate) {
  const result = elements(view.tree, predicate)[0]
  assert.ok(result, 'expected rendered element')
  return result.props
}

async function fixture(t) {
  const host = hookHost()
  t.after(() => host.close())
  const handlers = new Map(),
    writes = [],
    saved = [],
    notifications = [],
    classes = new Set()
  let listener
  let retire = async () => {}
  const { defaultConfig } = createLoader()('src/shared/settings.ts')
  const initial = plain(defaultConfig)
  initial.providerGroups[0].apiKey = initial.apiKey = 'mock-key'
  initial.providerGroups.push({ ...initial.providerGroups[0], id: 'provider-2', name: 'Second' })
  const main = createLoader(
    {
      electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } },
      './config': {
        loadConfig: () => plain(initial),
        saveConfig: (config) => saved.push(plain(config))
      }
    },
    {
      global: {
        mainWindow: {
          isDestroyed: () => false,
          webContents: {
            send: (name, value) => {
              if (name === 'app-settings-changed') {
                notifications.push(plain(value))
                listener?.(plain(value))
              }
            }
          }
        }
      }
    }
  )('src/main/settings.ts')
  main.onCaptureTargetChange(() => retire())
  const api = {
    getAppSettings: async () => plain(handlers.get('getAppSettings')()),
    updateAppSettings: async (settings) => {
      writes.push(plain(settings))
      assert.ok(writes.length < 20, 'unbounded settings IPC echo')
      return plain(await handlers.get('updateAppSettings')({}, plain(settings)))
    },
    onAppSettingsChanged: (callback) => {
      listener = callback
    },
    removeAppSettingsChangedListener: () => {
      listener = undefined
    },
    onGroupSwitched: () => undefined,
    removeGroupSwitchedListener: () => undefined,
    initShortcuts: () => undefined,
    getAppVersion: async () => 'test-only'
  }
  const memoryStorage = new Map()
  const toasts = []
  const stubs = {
    react: host.hooks,
    zustand: { create: () => (initializer) => host.bindStore(createStore(initializer)) },
    'zustand/middleware': {
      persist: (initializer, options) =>
        persist(initializer, {
          ...options,
          storage: createJSONStorage(() => ({
            getItem: (key) => memoryStorage.get(key) ?? null,
            setItem: (key, value) => memoryStorage.set(key, value),
            removeItem: (key) => memoryStorage.delete(key)
          }))
        })
    },
    'react-router': {
      HashRouter: 'HashRouter',
      Routes: 'Routes',
      Route: 'Route',
      Link: 'Link',
      useNavigate: () => () => {}
    },
    sonner: {
      toast: { success: (text) => toasts.push(text), error: (text) => toasts.push(text) },
      Toaster: 'Toaster'
    },
    '@/coder': {},
    '@/settings': {},
    '@/help': {},
    '@/memory-cards': {},
    '@/voice': {},
    '@/voice/VoiceCaptureController': { VoiceCaptureController: 'VoiceCaptureController' },
    '@/lib/store/shortcuts': { useShortcutsStore: () => ({ shortcuts: {} }) },
    '@/lib/store/memory-cards': {},
    '@/lib/store/app': { useAppStore: () => ({ ignoreMouse: false }) },
    '@/components/ui/button': { Button: 'Button' },
    '@/components/ui/slider': { Slider: 'Slider' },
    '@/components/ui/checkbox': { Checkbox: 'Checkbox' },
    './CustomShortcuts': {
      CustomShortcuts: 'CustomShortcuts',
      ResetDefaultShortcuts: 'ResetDefaultShortcuts'
    },
    './GroupSettings': { GroupSettings: 'GroupSettings' },
    './VoiceSettings': { VoiceSettings: 'VoiceSettings' },
    './components': { HelpSection: 'HelpSection' },
    './Shortcuts': { Shortcuts: 'Shortcuts' }
  }
  const document = {
    body: { style: {} },
    documentElement: {
      classList: { add: (key) => classes.add(key), remove: (key) => classes.delete(key) }
    }
  }
  const load = createLoader(stubs, { window: { api }, document, Error })
  const { useSettingsStore: store } = load('src/renderer/src/lib/store/settings.ts')
  stubs['@/lib/store/settings'] = { useSettingsStore: store }
  const app = host.mount(load('src/renderer/src/App.tsx').default)
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await tick()
      host.flush()
    }
  }
  await settle()
  const header = host.mount(load('src/renderer/src/coder/AppHeader.tsx').AppHeader)
  return {
    host,
    store,
    app,
    header,
    main,
    writes,
    saved,
    notifications,
    toasts,
    classes,
    settle,
    load,
    page: () => host.mount(load('src/renderer/src/settings/index.tsx').default),
    notify: (overrides = {}) => {
      listener?.({ ...plain(main.settings), ...overrides })
      host.flush()
    },
    setRetire: (fn) => {
      retire = fn
    }
  }
}

test('actual App effects + store + mock preload/main broadcast settle without any theme writeback', async (t) => {
  const f = await fixture(t)
  assert.equal(f.writes.length, 0)
  find(f.header, (e) => e.props?.title === '切换深色模式').onClick()
  f.host.flush()
  for (let i = 0; i < 10; i++) {
    f.notify({ theme: 'light', opacity: 0.1, fontSize: 12 })
    await f.settle()
    assert.equal(f.store.getState().theme, 'dark')
    assert.equal(f.classes.has('dark'), true)
    assert.equal(f.store.getState().opacity, 0.8)
    assert.equal(f.store.getState().fontSize, 14)
  }
  assert.equal(f.writes.length, 0)
  assert.equal(f.saved.length, 0)
})

test('equivalent broadcasts preserve store/group/voice references and editable configuration drafts', async (t) => {
  const f = await fixture(t)
  const page = f.page()
  const group = find(page, (e) => e.type === 'GroupSettings')
  const edited = group.providerGroups.map((g, i) =>
    i ? g : { ...g, name: 'Typing provider', apiKey: 'draft-key' }
  )
  group.onProviderGroupsChange(edited)
  const voice = find(page, (e) => e.type === 'VoiceSettings')
  voice.onChange({ ...voice.value, stt: { ...voice.value.stt, apiKey: 'draft-stt-key' } })
  f.host.flush()
  const before = f.store.getState(),
    renders = page.renders
  for (let i = 0; i < 10; i++) f.notify()
  await f.settle()
  assert.equal(f.store.getState(), before)
  assert.equal(page.renders, renders)
  assert.equal(f.store.getState().providerGroups, before.providerGroups)
  assert.equal(f.store.getState().voice, before.voice)
  assert.equal(
    find(page, (e) => e.type === 'GroupSettings').providerGroups[0].name,
    'Typing provider'
  )
  assert.equal(find(page, (e) => e.type === 'VoiceSettings').value.stt.apiKey, 'draft-stt-key')
  // A real main-origin group switch still synchronizes saved state, not the current form draft.
  f.main.activateProviderGroup('provider-2')
  await f.settle()
  assert.equal(f.store.getState().activeProviderGroupId, 'provider-2')
  assert.equal(find(page, (e) => e.type === 'GroupSettings').providerGroups[0].apiKey, 'draft-key')
  assert.equal(find(page, (e) => e.type === 'VoiceSettings').value.stt.apiKey, 'draft-stt-key')
  assert.equal(f.writes.length, 0)
})

test('real settings form save sends only configuration once, awaits audio retirement, and retains appearance', async (t) => {
  const f = await fixture(t),
    gate = deferred()
  f.setRetire(() => gate.promise)
  const page = f.page()
  const voice = find(page, (e) => e.type === 'VoiceSettings')
  voice.onChange({ ...voice.value, audioAppId: 'new-target' })
  f.host.flush()
  const save = find(page, (e) => e.props?.title === '保存设置').onClick
  const pending = save()
  await save() // Double click is ignored even before React flushes the disabled button.
  await f.settle()
  assert.equal(f.writes.length, 1)
  assert.equal(f.toasts.length, 0)
  assert.equal(f.main.settings.voice.audioAppId, '')
  assert.equal(find(page, (e) => e.props?.title === '保存设置').disabled, true)
  find(f.header, (e) => e.props?.title === '切换深色模式').onClick()
  gate.resolve()
  await pending
  await f.settle()
  assert.equal(f.writes.length, 1)
  assert.equal(f.saved.length, 1)
  assert.equal(f.main.settings.voice.audioAppId, 'new-target')
  assert.equal(f.store.getState().theme, 'dark')
  assert.equal(f.writes[0].theme, undefined)
  assert.equal(f.writes[0].opacity, undefined)
  assert.equal(f.writes[0].fontSize, undefined)
  assert.deepEqual(f.toasts, ['设置已保存'])
})

test('failed audio retirement reports failure without losing editable draft or claiming save success', async (t) => {
  const f = await fixture(t)
  f.setRetire(async () => {
    throw new Error('capture stop timeout')
  })
  const page = f.page()
  const voice = find(page, (e) => e.type === 'VoiceSettings')
  voice.onChange({ ...voice.value, audioAppId: 'target-B' })
  f.host.flush()
  await find(page, (e) => e.props?.title === '保存设置').onClick()
  await f.settle()
  assert.deepEqual(f.toasts, ['capture stop timeout'])
  assert.equal(f.saved.length, 0)
  assert.equal(f.main.settings.voice.audioAppId, '')
  assert.equal(find(page, (e) => e.type === 'VoiceSettings').value.audioAppId, 'target-B')
})

test('onboarding credentials explicitly save once through main instead of relying on App echo', async (t) => {
  const f = await fixture(t)
  f.notify({ apiKey: '' })
  const page = f.host.mount(
    f.load('src/renderer/src/coder/PrerequisitesChecker.tsx').PrerequisitesChecker
  )
  find(page, (e) => e.props?.placeholder === '请输入 API Key').onChange({
    target: { value: 'new-key' }
  })
  f.host.flush()
  await find(page, (e) => e.props?.children === '开始使用').onClick()
  await f.settle()
  assert.equal(f.writes.length, 1)
  assert.equal(f.main.settings.apiKey, 'new-key')
  assert.equal(f.main.settings.providerGroups[0].apiKey, 'new-key')
})

test('auto-update checkbox explicitly persists to main; subsequent notifications do not echo', async (t) => {
  const f = await fixture(t)
  const page = f.host.mount(f.load('src/renderer/src/help/index.tsx').default)
  find(page, (e) => e.props?.id === 'auto-check-update').onCheckedChange(false)
  await f.settle()
  assert.equal(f.writes.length, 1)
  assert.equal(f.main.settings.autoCheckUpdate, false)
  assert.equal(f.store.getState().autoCheckUpdate, false)
  f.notify()
  await f.settle()
  assert.equal(f.writes.length, 1)
})
