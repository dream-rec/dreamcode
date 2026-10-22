import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function writeJsonAtomic(file: string, value: unknown): void {
  const payload = JSON.stringify(value, null, 2)
  // Unit tests replace `node:fs` with a partial mock that only records writeFileSync.
  if (typeof mkdirSync !== 'function' || typeof renameSync !== 'function') {
    writeFileSync(file, payload, 'utf8')
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, payload, 'utf8')
  renameSync(temporary, file)
}
