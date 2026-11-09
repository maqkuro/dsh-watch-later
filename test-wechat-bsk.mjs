#!/usr/bin/env node
/**
 * test-wechat-bsk.mjs — 手动验证公众号「真浏览器」通道。
 *
 * 用法：
 *   node test-wechat-bsk.mjs <公众号文章 URL>
 *   node test-wechat-bsk.mjs <URL> --keep   保留截图
 *
 * 不碰 store，不写条目，只验证：bsk 能不能打开、能不能拿到正文。
 */
import { fetchWechatHtmlViaBsk, bskHealth } from './wechat.js'
import { extractArticleText } from './content.js'

const url = process.argv[2]
if (!url) {
  console.error('用法: node test-wechat-bsk.mjs <公众号文章 URL>')
  process.exit(1)
}

const health = await bskHealth({ force: true })
console.log('bsk 健康检查 :', health.ok ? 'OK' : '不可用 — ' + health.error)
if (!health.ok) process.exit(2)

const started = Date.now()
const result = await fetchWechatHtmlViaBsk(url)
console.log('抓取结果    :', result.ok ? '成功' : '失败 — ' + result.error)
console.log('耗时        :', Date.now() - started, 'ms')
if (result.html) {
  console.log('HTML 字节   :', result.html.length)
  const text = extractArticleText(result.html, 'wechat')
  console.log('提取正文字数:', text.length)
  console.log('--- 正文前 600 字 ---')
  console.log(text.slice(0, 600))
}
process.exit(result.ok ? 0 : 3)
