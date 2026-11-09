/**
 * 微信聊天记录原包（ZIP）自动入库。
 *
 * 背景：用户把微信聊天记录 ZIP 分享给 DSH 后，ZIP 里其实同时有「聊天记录.txt」和
 * 「聊天记录内的图片、视频和文件/*.jpg」。以前只靠 agent 读一遍再手写条目，图片原图会漏。
 * 本模块直接扫 native-archive 的收件目录，解包、去重、把全部原图存进媒体库：
 *   - 与已有条目封面/原图 SHA 相同的图片 → 追加到该条目的 images（多图）；
 *   - 剩余图片 → 建一个「聊天记录截图（N 张）」图集条目；
 *   - 聊天记录 txt 里的链接/内容 → 按 URL 归一化去重后导入；
 *   - 处理过的 ZIP 按 sha 记录，避免重复入库。
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync, writeFileSync, renameSync, watch } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, basename, extname, isAbsolute } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  DATA_DIR,
  addItem,
  getItems,
  resolveMediaPath,
  saveMediaBytes,
  setItemImages,
} from './store.js'
import { extractImportCandidates } from './import-text.js'
import { classifyUrl } from './score.js'

export const DEFAULT_ARCHIVE_INBOX = join(
  homedir(),
  'Library/Containers/local.kuro.NativeArchiveReceiver.DirectShare.deepseek/Data/Library/Application Support/NativeArchiveBridge/inbox/deepseek',
)

const STATE_FILE = join(DATA_DIR, 'zip-ingest-state.json')
const MAX_ZIP_BYTES = 512 * 1024 * 1024
const MIN_IMAGE_BYTES = 2048
const MAX_TEXT_BYTES = 512 * 1024
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
const JUNK_TITLE_RE = /^\[(图片|文件|链接|语音|视频|表情|动画表情|聊天记录|转账|红包)\]/
const DATE_ONLY_RE = /^\d{4}年\d{1,2}月\d{1,2}日(\s+\d{1,2}:\d{2})?$/

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { version: 1, zips: {} }
  }
}

function writeState(state) {
  const temporary = STATE_FILE + '.tmp-' + process.pid + '-' + Date.now().toString(36)
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(temporary, STATE_FILE)
}

function walkFiles(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

function mediaUrlsOf(item) {
  const urls = []
  if (item.cover) urls.push(item.cover)
  for (const url of Array.isArray(item.images) ? item.images : []) {
    if (!urls.includes(url)) urls.push(url)
  }
  return urls
}

function mediaFileOf(url) {
  if (typeof url !== 'string') return null
  const match = /\/api\/dsh-watch-later\/media\?f=([^&]+)/.exec(url)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

/** SHA 索引：已有条目的所有图片（封面 + 多图）→ 归到哪个条目/第几张。 */
function buildImageIndex() {
  const index = new Map()
  for (const item of getItems()) {
    if (!item || item.kind !== 'image') continue
    for (const url of mediaUrlsOf(item)) {
      const filename = mediaFileOf(url)
      if (!filename) continue
      const resolved = resolveMediaPath(filename)
      if (!resolved) continue
      try {
        index.set(sha256(readFileSync(resolved.path)), { itemId: item.id, url })
      } catch {
        // unreadable media is skipped
      }
    }
  }
  return index
}

function normalizedUrlKey(url) {
  try {
    const parsed = new URL(url)
    const host = parsed.host.toLowerCase()
    if (host === 'mp.weixin.qq.com') {
      return ('wechat:' + (parsed.searchParams.get('__biz') || '') + ':' + (parsed.searchParams.get('mid') || '') + ':' + (parsed.searchParams.get('idx') || '')).toLowerCase()
    }
    if (host === 'www.xiaohongshu.com' || host === 'xiaohongshu.com') {
      const match = /\/(?:explore|discovery\/item|note)\/([0-9a-zA-Z]+)/.exec(parsed.pathname)
      if (match) return 'xhs:' + match[1].toLowerCase()
    }
    if (host.endsWith('xiaoheihe.cn')) {
      const linkId = parsed.searchParams.get('link_id')
      if (linkId) return 'xhh:' + linkId.toLowerCase()
    }
    if (host.endsWith('douyin.com')) return 'douyin:' + parsed.pathname.replace(/\/$/, '').toLowerCase()
    if (host.endsWith('bilibili.com')) {
      const match = /BV[0-9A-Za-z]+/.exec(parsed.pathname)
      if (match) return 'bilibili:' + match[0]
    }
    return (host + parsed.pathname.replace(/\/$/, '')).toLowerCase()
  } catch {
    return String(url || '').toLowerCase()
  }
}

/** 微信聊天记录里的标准分享行：[链接] 标题 https://... */
export function parseChatLinkLines(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*\[链接\]\s*(.*?)\s*(https?:\/\/\S+)\s*$/.exec(line)
    if (!match) continue
    const title = match[1].trim()
    const url = match[2].trim()
    if (title && url) out.push({ title, url })
  }
  return out
}

function existingUrlKeys() {
  const keys = new Set()
  for (const item of getItems()) {
    if (typeof item.url === 'string' && item.url) keys.add(normalizedUrlKey(item.url))
  }
  return keys
}

function displayNameOf(zipPath) {
  try {
    const manifest = JSON.parse(readFileSync(join(zipPath, '..', 'manifest.json'), 'utf8'))
    if (manifest && typeof manifest.originalFilename === 'string' && manifest.originalFilename.trim()) {
      return manifest.originalFilename.trim().replace(/\.zip$/i, '').slice(0, 30)
    }
  } catch {
    // fall through to zip basename
  }
  const base = basename(zipPath, '.zip')
  return base === 'original' ? '微信聊天记录' : base.slice(0, 30)
}

function pickGalleryTitle(count, displayName) {
  return '聊天记录截图 · ' + count + ' 张 · ' + displayName
}

/** 解压前的展开量保护：接收器只存原包，真正解包在这里做，所以在这层挡住超大/炸弹包。 */
function zipUncompressedStats(zipPath) {
  const result = spawnSync('unzip', ['-l', zipPath], { timeout: 20000 })
  if (result.status !== 0 || !result.stdout) return null
  const text = String(result.stdout)
  const match = /^\s*(\d+)\s+(\d+)\s+files?\s*$/m.exec(text)
  if (!match) return null
  return { bytes: Number(match[1]), entries: Number(match[2]) }
}

function extractZip(zipPath) {
  const target = mkdtempSync(join(tmpdir(), 'wl-zip-'))
  const result = spawnSync('ditto', ['-x', '-k', zipPath, target], { timeout: 60000 })
  if (result.status !== 0) {
    try {
      rmSync(target, { recursive: true, force: true })
    } catch {
      // ignore
    }
    throw new Error('解包 ZIP 失败：' + String(result.stderr || '').slice(0, 200))
  }
  return target
}

/**
 * Ingest one chat-record ZIP: store every original image, import chat-log links.
 * @returns {{ ok, skipped?, zipSha?, matched, newImages, galleryItemId, textItems, error? }}
 */
export async function ingestArchiveZip(zipPath, options = {}) {
  const result = { ok: false, skipped: false, zipSha: null, matched: 0, newImages: 0, galleryItemId: null, textItems: 0, error: null }
  try {
    if (typeof zipPath !== 'string' || !isAbsolute(zipPath) || !zipPath.toLowerCase().endsWith('.zip')) {
      throw new Error('需要 ZIP 绝对路径')
    }
    if (!existsSync(zipPath)) throw new Error('ZIP 不存在')
    const stat = statSync(zipPath)
    if (!stat.isFile()) throw new Error('不是文件')
    if (stat.size > MAX_ZIP_BYTES) throw new Error('ZIP 超过 512MB 上限')
    const zipBytes = readFileSync(zipPath)
    const zipSha = sha256(zipBytes)
    result.zipSha = zipSha
    const state = readState()
    if (state.zips[zipSha] && !options.force) {
      result.ok = true
      result.skipped = true
      return result
    }

    const stats = zipUncompressedStats(zipPath)
    if (stats && (stats.bytes > 2 * 1024 * 1024 * 1024 || stats.entries > 5000)) {
      result.error = '原包展开量超过 2 GB 或 5000 项，已跳过自动解包（原包仍保留在 DSH 附件里）'
      return result
    }
    const extracted = extractZip(zipPath)
    try {
      const files = walkFiles(extracted)
      const imageFiles = files.filter((file) => IMAGE_EXT.has(extname(file).toLowerCase()))
      const textFiles = files.filter((file) => ['.txt', '.md'].includes(extname(file).toLowerCase()))
      const imageIndex = buildImageIndex()
      const galleryUrls = []
      for (const file of imageFiles) {
        let bytes
        try {
          bytes = readFileSync(file)
        } catch {
          continue
        }
        if (bytes.length < MIN_IMAGE_BYTES) continue
        const hash = sha256(bytes)
        const existing = imageIndex.get(hash)
        if (existing) {
          result.matched += 1
          continue
        }
        const extension = extname(file).toLowerCase() === '.jpeg' ? '.jpg' : extname(file).toLowerCase()
        const media = saveMediaBytes(bytes, extension)
        imageIndex.set(hash, { itemId: null, url: media.url })
        galleryUrls.push(media.url)
      }
      result.newImages = galleryUrls.length
      if (galleryUrls.length > 0) {
        const displayName = displayNameOf(zipPath)
        const chunks = []
        for (let index = 0; index < galleryUrls.length; index += 12) chunks.push(galleryUrls.slice(index, index + 12))
        result.galleryItemId = null
        chunks.forEach((urls, index) => {
          const suffix = chunks.length > 1 ? '（第 ' + (index + 1) + ' 组 / 共 ' + chunks.length + ' 组）' : ''
          const title = pickGalleryTitle(galleryUrls.length, displayName) + suffix
          const added = addItem(
            {
              kind: 'image',
              title: title.slice(0, 120),
              cover: urls[0],
              images: urls,
              channel: 'zip',
              site: '微信聊天记录',
              summary: '来自微信聊天记录原包，共 ' + galleryUrls.length + ' 张截图' + (chunks.length > 1 ? '，本组 ' + urls.length + ' 张' : ''),
              tags: ['微信聊天记录', '截图'],
            },
            { dedupe: false },
          )
          if (!result.galleryItemId) result.galleryItemId = added.item.id
        })
      }

      const urlKeys = existingUrlKeys()
      for (const file of textFiles) {
        if (statSync(file).size > MAX_TEXT_BYTES) continue
        let text
        try {
          text = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        const chatLinks = parseChatLinkLines(text)
        const candidates = chatLinks.length > 0
          ? chatLinks.map((entry) => {
              const info = classifyUrl(entry.url)
              return { title: entry.title, url: entry.url, kind: info.kind, site: info.site }
            })
          : extractImportCandidates(text).slice(0, 40)
        for (const candidate of candidates) {
          const title = String(candidate.title || '').trim()
          if (!title && !candidate.url) continue
          if (title && (JUNK_TITLE_RE.test(title) || DATE_ONLY_RE.test(title))) continue
          if (candidate.url) {
            const key = normalizedUrlKey(candidate.url)
            if (urlKeys.has(key)) continue
            urlKeys.add(key)
          }
          try {
            const added = addItem(
              {
                kind: candidate.kind || 'link',
                title: title || candidate.url,
                url: candidate.url || null,
                site: candidate.site || null,
                channel: 'zip',
                summary: title ? null : null,
              },
              { dedupe: true },
            )
            if (!added.duplicate) result.textItems += 1
          } catch {
            // skip a bad line
          }
        }
      }

      state.zips[zipSha] = {
        ingestedAt: new Date().toISOString(),
        zipPath,
        matched: result.matched,
        newImages: result.newImages,
        textItems: result.textItems,
      }
      writeState(state)
      result.ok = true
      return result
    } finally {
      try {
        rmSync(extracted, { recursive: true, force: true })
      } catch {
        // ignore cleanup failure
      }
    }
  } catch (error) {
    result.error = String(error?.message || error)
    return result
  }
}

export function listArchiveZips(root = DEFAULT_ARCHIVE_INBOX) {
  if (!root || !existsSync(root)) return []
  const out = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const zip = join(root, entry.name, 'original.zip')
    if (!existsSync(zip)) continue
    try {
      const stat = statSync(zip)
      out.push({ zipPath: zip, bytes: stat.size, mtimeMs: stat.mtimeMs })
    } catch {
      // ignore
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return out
}

/**
 * First run only: mark every ZIP that already exists as processed without importing it,
 * so installing/enabling the plugin does not dump months of old chat archives into the list.
 */
export function baselineArchives(root = DEFAULT_ARCHIVE_INBOX) {
  const state = readState()
  if (state.baselineAt) return { skipped: true }
  let marked = 0
  for (const entry of listArchiveZips(root)) {
    try {
      const sha = sha256(readFileSync(entry.zipPath))
      if (!state.zips[sha]) {
        state.zips[sha] = { ingestedAt: new Date().toISOString(), zipPath: entry.zipPath, baseline: true, matched: 0, newImages: 0, textItems: 0 }
        marked += 1
      }
    } catch {
      // ignore unreadable zip
    }
  }
  state.baselineAt = new Date().toISOString()
  writeState(state)
  return { marked }
}

/** Consume every not-yet-ingested archive that appeared after the baseline. */
export async function scanArchiveInbox(root = DEFAULT_ARCHIVE_INBOX) {
  const summary = { scanned: 0, ingested: 0, newImages: 0, textItems: 0, errors: 0 }
  if (!root || !existsSync(root)) return summary
  baselineArchives(root)
  const state = readState()
  for (const entry of listArchiveZips(root)) {
    summary.scanned += 1
    const result = await ingestArchiveZip(entry.zipPath)
    if (result.skipped) continue
    if (!result.ok) {
      summary.errors += 1
      continue
    }
    summary.ingested += 1
    summary.newImages += result.newImages
    summary.textItems += result.textItems
  }
  return summary
}

/** Watch the native-archive inbox (new ZIP folders appear here). */
export function startArchiveWatcher(root = DEFAULT_ARCHIVE_INBOX) {
  let timer = null
  let closed = false
  const schedule = () => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      scanArchiveInbox(root).catch(() => {})
    }, 1500)
  }
  let watcher = null
  try {
    if (existsSync(root)) watcher = watch(root, { persistent: false }, () => schedule())
  } catch {
    watcher = null
  }
  const poll = setInterval(schedule, 15000)
  poll.unref?.()
  const startup = setTimeout(schedule, 2500)
  startup.unref?.()
  return () => {
    closed = true
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
