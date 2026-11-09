/**
 * Inbox drop zone: anything placed in ~/.dsh/storages/watch-later/inbox is
 * picked up automatically. This is the "share to DSH" landing pad for content
 * that is not typed into the panel or handed to the agent.
 */
import { watch } from 'node:fs'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { basename, extname } from 'node:path'
import {
  addItem,
  saveMediaFile,
  listInboxFiles,
  archiveInboxFile,
  ensureDirs,
  getSettings,
  INBOX_DIR,
} from './store.js'
import { extractImportCandidates } from './import-text.js'
import { extractUrls } from './classify.js'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.url', '.webloc', '.json', '.csv'])
const MAX_TEXT_BYTES = 2 * 1024 * 1024

function readTextFile(path) {
  try {
    const stat = existsSync(path) ? readFileSync(path) : null
    if (!stat) return null
    if (stat.length > MAX_TEXT_BYTES) return null
    return stat.toString('utf8')
  } catch {
    return null
  }
}

function fromWebloc(text) {
  const match = /<string>\s*(https?:\/\/[^<\s]+)\s*<\/string>/i.exec(text)
  return match?.[1] || null
}

function processTextFile(path) {
  const text = readTextFile(path)
  if (!text) return 0
  const extension = extname(path).toLowerCase()
  let added = 0
  if (extension === '.json') {
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    if (parsed) {
      const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [parsed]
      for (const row of rows) {
        try {
          addItem({ ...row, channel: row?.channel || 'inbox' })
          added += 1
        } catch {
          // skip malformed row
        }
      }
      return added
    }
  }
  if (extension === '.url' || extension === '.webloc') {
    const url = fromWebloc(text) || extractUrls(text)[0]
    if (url) {
      addItem({ url, title: basename(path, extname(path)), channel: 'inbox' })
      return 1
    }
    return 0
  }
  const candidates = extractImportCandidates(text)
  for (const candidate of candidates) {
    try {
      addItem({ ...candidate, channel: 'inbox' })
      added += 1
    } catch {
      // skip
    }
  }
  return added
}

/**
 * Consume every file currently in the inbox once.
 * Returns { processed, added, errors }.
 */
export function processInbox() {
  ensureDirs()
  const settings = getSettings()
  if (!settings.inboxEnabled) return { processed: 0, added: 0, errors: 0 }
  let processed = 0
  let added = 0
  let errors = 0
  for (const path of listInboxFiles()) {
    const name = basename(path)
    if (name.startsWith('.') || name.endsWith('.tmp')) continue
    try {
      const extension = extname(path).toLowerCase()
      if (IMAGE_EXT.has(extension)) {
        const media = saveMediaFile(path)
        const title = basename(path, extension)
        addItem({ kind: 'image', title, cover: media.url, channel: 'inbox', site: '图片' })
        added += 1
      } else if (TEXT_EXT.has(extension)) {
        const count = processTextFile(path)
        added += count
      } else {
        errors += 1
        continue
      }
      archiveInboxFile(path)
      processed += 1
    } catch {
      errors += 1
    }
  }
  return { processed, added, errors }
}

/**
 * Watch the inbox directory. Returns a disposer. Files are debounced so a file
 * being written does not get read half-way.
 */
export function startInboxWatcher() {
  ensureDirs()
  if (!existsSync(INBOX_DIR)) mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })
  let timer = null
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try {
        processInbox()
      } catch {
        // watcher must never throw into the plugin lifecycle
      }
    }, 1200)
  }
  let watcher = null
  try {
    watcher = watch(INBOX_DIR, { persistent: false }, () => schedule())
  } catch {
    watcher = null
  }
  const startup = setTimeout(schedule, 2500)
  return () => {
    if (timer) clearTimeout(timer)
    clearTimeout(startup)
    try {
      watcher?.close()
    } catch {
      // ignore
    }
  }
}
