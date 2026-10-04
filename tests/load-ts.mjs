import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// Transpile into memory so tests can isolate Electron/provider imports without a running app.
export function createLoader(stubs = {}, globals = {}) {
  const cache = new Map()
  const context = vm.createContext({
    console,
    process,
    Buffer,
    URL,
    AbortController,
    AbortSignal,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    crypto: globalThis.crypto,
    ...globals
  })
  context.global = globals.global ?? context
  function load(filename) {
    let path = resolve(root, filename)
    if (!extname(path)) path += existsSync(path + '.ts') ? '.ts' : '.tsx'
    if (cache.has(path)) return cache.get(path).exports
    const module = { exports: {} }
    cache.set(path, module)
    const localRequire = (name) => {
      if (Object.hasOwn(stubs, name)) return stubs[name]
      if (name.startsWith('.')) return load(resolve(dirname(path), name))
      return require(name)
    }
    const code = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true
      }
    }).outputText
    const run = vm.runInContext(
      `(function(require,module,exports,__filename,__dirname){${code}\n})`,
      context,
      { filename: path }
    )
    run(localRequire, module, module.exports, path, dirname(path))
    return module.exports
  }
  return load
}

export const plain = (value) => JSON.parse(JSON.stringify(value))
export const tick = () => new Promise((resolve) => setImmediate(resolve))
export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
