// Загрузка .env.local ДО импорта остальных серверных модулей.
// ESM выполняет импорты по порядку, поэтому этот файл нужно импортировать первым.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

try {
  const contents = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (!process.env[key]) process.env[key] = rawValue.replace(/^['"]|['"]$/g, '')
  }
} catch {
  // .env.local необязателен, если переменные заданы в системе.
}
