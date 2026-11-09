/**
 * 把稍后再看里的截图推进同机「设计素材库」插件（@local/dsh-design-library）。
 *
 * 设计素材库暴露本机回环 HTTP：
 *   POST /api/dsh-design/item  { item, imageData(data:base64) } → { ok, item, revision }
 * 这里负责取图（本地 media 优先，其次 http 封面）、拼 data URI、幂等推送，
 * 并把结果回给 API 层（不直接写数据库）。
 */
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { resolveMediaPath } from './store.js'
import { request, UA } from './sync/http.js'

const PUSH_TIMEOUT_MS = 20000
const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function localMediaFile(cover) {
  if (typeof cover !== 'string') return null
  const match = /^\/api\/dsh-watch-later\/media\?f=([^&]+)/.exec(cover)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

function readLocalMedia(cover) {
  const filename = localMediaFile(cover)
  if (!filename) return null
  const resolved = resolveMediaPath(filename)
  if (!resolved) return null
  return {
    bytes: readFileSync(resolved.path),
    mediaType: MEDIA_TYPES[resolved.ext] || 'image/png',
    filename,
  }
}

async function downloadCover(url, signal) {
  const response = await request(url, {
    headers: { 'user-agent': UA },
    timeoutMs: 15000,
    signal,
  })
  if (response.status < 200 || response.status >= 300) throw new Error('封面下载失败 HTTP ' + response.status)
  const contentType = String(
    (response.headers && (response.headers.get ? response.headers.get('content-type') : response.headers['content-type'])) || '',
  )
  const mediaType = /^image\/(png|jpeg|webp|gif)/.exec(contentType)?.[1]
  if (!mediaType) throw new Error('封面不是图片')
  const bytes = Buffer.from(await response.arrayBuffer())
  return { bytes, mediaType: 'image/' + mediaType, filename: 'cover' }
}

async function imageSourceFor(item, signal, imageUrl) {
  const sourceUrl = imageUrl || item.cover
  const local = readLocalMedia(sourceUrl)
  if (local) return local
  if (typeof sourceUrl === 'string' && /^https?:\/\//i.test(sourceUrl)) {
    return await downloadCover(sourceUrl, signal)
  }
  // 图片可能以 URL 形式存在（老数据）
  if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url) && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(item.url)) {
    return await downloadCover(item.url, signal)
  }
  throw new Error('这张图片没有本地副本（早期聊天转发只存了标题），请重新分享或上传图片')
}

/**
 * Push one image item into the design library.
 * @returns {{ ok:boolean, libraryItemId?:string, error?:string }}
 */
export async function pushImageToLibrary(item, options = {}) {
  if (!item || item.kind !== 'image') return { ok: false, error: '只有图片可以加入素材库' }
  const origin = typeof options.origin === 'string' && options.origin ? options.origin : null
  if (!origin) return { ok: false, error: '设计素材库地址不可用' }
  let source
  try {
    source = await imageSourceFor(item, options.signal, options.imageUrl)
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
  if (!source.bytes || source.bytes.length === 0) return { ok: false, error: '图片内容为空' }
  if (source.bytes.length > 20 * 1024 * 1024) return { ok: false, error: '图片超过素材库 20MB 上限' }
  const extension = extname(source.filename || '').toLowerCase()
  const mediaType = source.mediaType || MEDIA_TYPES[extension] || 'image/png'
  const dataUri = 'data:' + mediaType + ';base64,' + source.bytes.toString('base64')
  const baseTitle = String(item.title || '稍后再看截图').replace(/\s*[（(]\d+\s*张[^）)]*[）)]\s*$/, '').trim() || '稍后再看截图'
  const multi = Array.isArray(item.images) && item.images.length > 1
  const tags = [...new Set([...(Array.isArray(item.tags) ? item.tags : []), '稍后再看', '截图'])].slice(0, 10)
  const payload = {
    item: {
      title: (multi && options.imageIndex ? baseTitle + ' #' + (options.imageIndex + 1) : baseTitle).slice(0, 120),
      tags,
      notes: String(item.summary || item.notes || '').slice(0, 500),
      sourceUrl: typeof item.url === 'string' ? item.url : '',
      sourceName: '稍后再看',
    },
    imageData: dataUri,
  }
  try {
    const response = await request(origin + '/api/dsh-design/item', {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: PUSH_TIMEOUT_MS,
      signal: options.signal,
    })
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    if (response.status === 404) return { ok: false, error: '设计素材库插件未安装/未运行' }
    if (response.status < 200 || response.status >= 300 || !data || data.ok === false) {
      return { ok: false, error: (data && data.error) || '素材库返回 HTTP ' + response.status }
    }
    const libraryItemId = data.item && typeof data.item.id === 'string' ? data.item.id : null
    return { ok: true, libraryItemId }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}
