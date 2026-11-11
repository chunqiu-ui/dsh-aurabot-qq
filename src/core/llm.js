// 直接问一次宿主模型（不进会话）：给表情起备注、心情判断、记忆提炼等后台小任务用。
// 纯文本任务优先走 GLM glm-5.3-flash（免费 token 省 DeepSeek 钱），看图任务仍走宿主 DeepSeek。

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

export function defaultModel(dsh, cfg) {
  if (cfg?.model?.provider && cfg?.model?.model) return { provider: cfg.model.provider, model: cfg.model.model }
  try {
    const svc = dsh.get('agentDefaultModel')
    const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
  } catch (error) {}
  return null
}

// ---------- GLM 文本兜底（免费 token，省 DeepSeek） ----------
const GLM_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const GLM_MODEL = 'glm-5.3-flash'
const GLM_SECRETS_ENV = 'C:\\dsh-deploy\\secrets.env'
const GLM_SECRETS_PS1 = 'C:\\dsh-deploy\\secrets.ps1'

let __glmSecrets = null
function runPs(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try { child = spawn(cmd, args, { windowsHide: true }) } catch (error) { resolve({ out, err: error.message }); return }
    const t = setTimeout(() => { try { child.kill() } catch (error) {} }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (error) => { err += error.message })
    child.on('close', () => { clearTimeout(t); resolve({ out, err }) })
  })
}

async function loadGlmSecrets() {
  if (__glmSecrets) return __glmSecrets
  const map = {}
  // 旧明文 secrets.env 兜底（一般已不存在）
  try {
    for (const line of readFileSync(GLM_SECRETS_ENV, 'utf8').split(/\r?\n/)) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      const i = s.indexOf('=')
      if (i > 0) map[s.slice(0, i).trim()] = s.slice(i + 1).trim()
    }
  } catch (error) {}
  // DPAPI 加密库：secrets.ps1 -All 输出 KEY=VALUE
  try {
    const ps = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
    const r = await runPs(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', GLM_SECRETS_PS1, '-All'])
    for (const line of (r.out || '').split(/\r?\n/)) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      const i = s.indexOf('=')
      if (i > 0) map[s.slice(0, i).trim()] = s.slice(i + 1).trim()
    }
  } catch (error) {}
  __glmSecrets = map
  return map
}

async function glmText(system, text, maxTokens, temperature) {
  const m = await loadGlmSecrets()
  const key = m.VISION_API_KEY || ''
  if (!key) throw new Error('没有 GLM 密钥')
  const body = JSON.stringify({
    model: GLM_MODEL,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: text },
    ],
    // glm-5.3-flash 带思考，多给点空间免得正文被思考吃光（token 免费，不心疼）
    max_tokens: Math.max(maxTokens || 600, 1024),
    temperature: temperature ?? 0.3,
  })
  const res = await fetch(GLM_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body,
  })
  if (!res.ok) throw new Error('GLM HTTP ' + res.status)
  const j = await res.json()
  const out = j?.choices?.[0]?.message?.content
  if (typeof out !== 'string' || !out.trim()) throw new Error('GLM 返回空')
  return out.trim()
}

/**
 * @param {object} dsh 宿主 ctx
 * @param {{system:string, text:string, images?:Array<{data:string, mediaType:string}>, maxTokens?:number, temperature?:number, cfg?:object}} o
 * @returns {Promise<string>}
 */
export async function askModel(dsh, o) {
  // GLM 文本兜底：纯文本（无图）且开关开时，先走 glm-5.3-flash 免费 token，失败落回 DeepSeek
  if (!(o.images && o.images.length) && o.cfg?.model?.glmText !== false) {
    try {
      return await glmText(o.system || '', o.text, o.maxTokens, o.temperature)
    } catch (error) {
      try { dsh?.logger?.warn?.(`aurabot GLM 文本兜底失败，回 DeepSeek: ${error.message}`) } catch (e) {}
    }
  }
  const llm = dsh.llm || dsh.get('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')
  const t = defaultModel(dsh, o.cfg)
  if (!t) throw new Error('拿不到默认模型')
  let content = [{ type: 'text', text: o.text }]
  for (const img of o.images || []) content.push({ type: 'image', data: img.data, mediaType: img.mediaType, name: 'aurabot-image' })
  // 图片要先交给 DSH 的附件服务登记成附件块，模型适配层只认附件
  if (content.length > 1) {
    const att = dsh.attachments || dsh.get('attachments')
    if (!att || typeof att.admitPromptContent !== 'function') throw new Error('宿主没有附件服务，看不了图')
    content = await att.admitPromptContent(content)
  }
  const messages = [{ role: 'user', id: randomUUID(), content, source: { kind: 'plugin', plugin: 'aurabot' } }]
  let out = ''
  for await (const chunk of llm.stream({
    provider: t.provider,
    model: t.model,
    system: o.system || '',
    messages,
    maxTokens: o.maxTokens || 600,
    temperature: o.temperature ?? 0.3,
    reasoningEffort: 'low',
  })) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') out += chunk.text
    if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      const f = chunk.reason.failure || {}
      throw new Error('模型报错：' + (f.message || f.code || '未知'))
    }
  }
  return out.trim()
}
