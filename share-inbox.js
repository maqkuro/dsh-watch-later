/**
 * macOS 分享扩展 → 稍后再看的落地通道。
 *
 * 用户从微信/系统分享面板把图片、文字、链接（可多选）发给「DeepSeek Harness」分享入口。
 * 分享扩展把内容写成 share-content 作业（CONTRACT.md §11），本模块负责：
 *   校验 manifest/parts → 图片进 media 并建条目、文字按链接/文本解析入库
 *   → 在同一目录写 delivery.json（draft-ready / error），供分享扩展判定成功并显示真实错误。
 *
 * 落盘位置在分享扩展的沙盒容器里（DSH 未沙盒化，可直接读写）：
 *   ~/Library/Containers/local.kuro.NativeArchiveReceiver.DirectShare.deepseek/
 *     Data/Library/Application Support/NativeArchiveBridge/inbox/watchlater
 */
import { watch, existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { join, extname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { addItem, saveMediaBytes } from './store.js'
import { extractImportCandidates } from './import-text.js'

export const DEFAULT_SHARE_INBOX = join(
  homedir(),
  'Library/Containers/local.kuro.NativeArchiveReceiver.DirectShare.deepseek/Data/Library/Application Support/NativeArchiveBridge/inbox/watchlater',
)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PART_RE = /^(text|image|file)-[0-9]{1,3}\.(txt|png|jpg|jpeg|webp|gif)$/i
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_TEXT_BYTES = 64 * 1024
const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const MAX_PARTS = 12
const MAX_IMAGES = 6
const processed = new Set()

function readJsonFile(path, limit) {
  const bytes = readFileSync(path)
  if (bytes.length > limit) throw new Error('清单文件过大')
  return JSON.parse(bytes.toString('utf8'))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function writeDelivery(dir, payload) {
  const file = join(dir, 'delivery.json')
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36)
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

function safeName(value, fallback) {
  const name = typeof value === 'string' ? value.trim() : ''
  return (name || fallback).slice(0, 120)
}

function ingestText(text, fallbackTitle) {
  let added = 0
  const candidates = extractImportCandidates(text)
  const title = safeName(fallbackTitle, '')
  for (const candidate of candidates) {
    try {
      const input = { ...candidate, channel: 'inbox' }
      if (input.url && !input.title && title) input.title = title
      const result = addItem(input, { dedupe: true })
      if (!result.duplicate) added += 1
    } catch {
      // one bad line must not abort the job
    }
  }
  if (added === 0 && candidates.length === 0) {
    const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    if (firstLine) {
      try {
        const result = addItem(
          { title: (title || firstLine).slice(0, 120), text, channel: 'inbox', kind: 'other' },
          { dedupe: true },
        )
        if (!result.duplicate) added += 1
      } catch {
        // ignore
      }
    }
  }
  return added
}

/** Verify one share job and ingest it. Returns { ok, itemCount, error }. */
export function ingestShareJob(dir) {
  const manifest = readJsonFile(join(dir, 'manifest.json'), MAX_MANIFEST_BYTES)
  if (!manifest || manifest.schemaVersion !== 2 || manifest.kind !== 'share-content') {
    throw new Error('不是 share-content 作业')
  }
  if (manifest.target !== 'watchlater') throw new Error('作业目标不是 watchlater')
  if (!Array.isArray(manifest.parts) || manifest.parts.length === 0) throw new Error('作业没有内容')
  if (manifest.parts.length > MAX_PARTS) throw new Error(`内容条数超过 ${MAX_PARTS} 个上限`)
  const images = manifest.parts.filter((part) => part && part.role === 'image')
  if (images.length > MAX_IMAGES) throw new Error(`图片超过 ${MAX_IMAGES} 张上限`)

  const parts = []
  for (const part of manifest.parts) {
    if (!part || typeof part.filename !== 'string' || !PART_RE.test(part.filename)) {
      throw new Error('内容文件名不合法')
    }
    const path = join(dir, part.filename)
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error('内容不是普通文件')
    const limit = part.role === 'text' ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES
    if (stat.size > limit) throw new Error(`内容 ${part.filename} 超过大小上限`)
    const bytes = readFileSync(path)
    if (sha256(bytes) !== part.sha256) throw new Error(`内容 ${part.filename} 校验失败`)
    parts.push({ part, bytes })
  }
  parts.sort((a, b) => a.part.filename.localeCompare(b.part.filename))
  const jobHash = sha256(Buffer.concat(parts.map((entry) => entry.bytes)))
  if (jobHash !== manifest.sha256) throw new Error('作业整体校验失败')

  let itemCount = 0
  const fallbackTitle = manifest.originalFilename || '微信分享'
  for (const entry of parts) {
    if (entry.part.role === 'image') {
      const extension = extname(entry.part.filename).toLowerCase()
      const media = saveMediaBytes(entry.bytes, extension)
      const result = addItem(
        {
          kind: 'image',
          title: fallbackTitle && !/\.(png|jpe?g|webp|gif)$/i.test(fallbackTitle) ? fallbackTitle : '分享图片',
          cover: media.url,
          channel: 'inbox',
          site: null,
        },
        { dedupe: true },
      )
      if (!result.duplicate) itemCount += 1
    } else {
      itemCount += ingestText(entry.bytes.toString('utf8'), fallbackTitle)
    }
  }
  return { ok: true, itemCount }
}

function readDelivery(dir) {
  try {
    return readJsonFile(join(dir, 'delivery.json'), 8 * 1024)
  } catch {
    return null
  }
}

/**
 * Consume every pending share job under `root` once.
 * Returns { processed, added, errors }.
 */
export function processShareJobs(root = DEFAULT_SHARE_INBOX) {
  const result = { processed: 0, added: 0, errors: 0 }
  if (!root || !existsSync(root)) return result
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue
    const dir = join(root, entry.name)
    const delivery = readDelivery(dir)
    if (delivery && delivery.state === 'draft-ready') continue
    if (processed.has(entry.name)) continue
    try {
      const outcome = ingestShareJob(dir)
      writeDelivery(dir, {
        target: 'watchlater',
        state: 'draft-ready',
        sha256: readJsonFile(join(dir, 'manifest.json'), MAX_MANIFEST_BYTES).sha256,
        sessionId: 'watch-later',
        itemCount: outcome.itemCount,
        updatedAt: Date.now() / 1000,
      })
      processed.add(entry.name)
      result.processed += 1
      result.added += outcome.itemCount
    } catch (error) {
      result.errors += 1
      processed.add(entry.name)
      let failedSha = ''
      try {
        const manifest = readJsonFile(join(dir, 'manifest.json'), MAX_MANIFEST_BYTES)
        if (manifest && typeof manifest.sha256 === 'string') failedSha = manifest.sha256
      } catch {
        // manifest unreadable: still report the failure to the share UI
      }
      try {
        writeDelivery(dir, {
          target: 'watchlater',
          state: 'error',
          sha256: failedSha,
          sessionId: 'watch-later',
          error: String(error?.message || error).slice(0, 500),
          updatedAt: Date.now() / 1000,
        })
      } catch {
        // delivery write failure must not break the scan loop
      }
    }
  }
  return result
}

/** Watch the share inbox; falls back to a 4s poll because the directory may appear late. */
export function startShareWatcher(root = DEFAULT_SHARE_INBOX) {
  let timer = null
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try {
        processShareJobs(root)
      } catch {
        // never throw into the plugin lifecycle
      }
    }, 900)
  }
  let watcher = null
  try {
    if (existsSync(root)) watcher = watch(root, { persistent: false }, () => schedule())
  } catch {
    watcher = null
  }
  const poll = setInterval(schedule, 4000)
  poll.unref?.()
  const startup = setTimeout(schedule, 1500)
  return () => {
    if (timer) clearTimeout(timer)
    clearTimeout(startup)
    clearInterval(poll)
    try {
      watcher?.close()
    } catch {
      // ignore
    }
  }
}
