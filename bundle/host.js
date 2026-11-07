/**
 * @local/dsh-uitest —— WinForms/Win32 应用的 UIA 自动化测试桥（原型）
 *
 * 定位：结构化优先。能用 UI Automation 读/动的地方，绝不用截图 + OCR + 坐标。
 *   ui_windows  列窗口（Win32 EnumWindows，毫秒级）
 *   ui_tree     读控件树（name / AutomationId / 控件类型 / 矩形 / 支持的模式）
 *   ui_find     按 id / name / type 定位控件，返回是否找到 + 匹配数量
 *   ui_invoke   通过 InvokePattern 触发按钮，不抢焦点、不依赖坐标
 *   ui_set      通过 ValuePattern 写输入框
 *   ui_read     读控件属性（Name / Value / Enabled / Type / Text）
 *   ui_assert   批量断言，逐条给出 PASS/FAIL 与原因
 *
 * 说明：UIA 跨进程访问需要足够权限；受限令牌下控件树会被截断（只剩顶层窗口）。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'uitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(HERE, 'sidecar', 'uitestd.py')

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

const DEFAULTS = { python: '', callTimeoutMs: 95000, caseDir: join(HERE, 'cases') }

/** 最近一次 ui_run_case 的结构化结果，供 ui_run_cases 批量汇总复用 */
let lastCaseReport = null
/** 最近一次 ui_run_cases 的汇总结果，供命令行/CI 判断退出码 */
let lastBatchSummary = null

export function getLastCaseReport() {
  return lastCaseReport
}

export function getLastBatchSummary() {
  return lastBatchSummary
}

class Sidecar {
  constructor(log, config) {
    this.log = log
    this.config = config ?? {}
    this.proc = undefined
    this.port = 0
    this.stderr = ''
    this.starting = undefined
    this.python = config?.python || process.env.DSH_UITEST_PYTHON || 'python'
  }

  get base() {
    return `http://127.0.0.1:${this.port}`
  }

  async ensure() {
    if (this.port && this.proc && this.proc.exitCode === null) return this
    if (this.starting) return this.starting
    this.starting = this._start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  async _start() {
    this.log?.info?.(`启动 UIA sidecar：${this.python} ${SIDECAR}`)
    const proc = spawn(this.python, [SIDECAR, '--port', '0'], {
      cwd: HERE,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.proc = proc
    proc.stderr?.on('data', (c) => {
      this.stderr = (this.stderr + String(c)).slice(-4000)
    })
    const first = await new Promise((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error(`sidecar 启动超时（8s）：${this.stderr.slice(-400)}`)), 8000)
      proc.stdout?.on('data', (c) => {
        buf += String(c)
        const i = buf.indexOf('\n')
        if (i >= 0) {
          clearTimeout(timer)
          resolve(buf.slice(0, i).trim())
        }
      })
      proc.once('error', (e) => {
        clearTimeout(timer)
        reject(new Error(`无法启动 python（${this.python}）：${e.message}`))
      })
      proc.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`sidecar 启动即退出（code=${code}）：${this.stderr.slice(-400)}`))
      })
    })
    let info
    try {
      info = JSON.parse(first)
    } catch {
      throw new Error(`sidecar 启动输出无法解析：${String(first).slice(0, 300)}`)
    }
    if (!info.ok) throw new Error(`sidecar 启动失败：${info.error ?? ''}`)
    this.port = info.port
    this.log?.info?.(`UIA sidecar 就绪：端口 ${this.port}`)
    return this
  }

  async call(path, body, timeoutMs = this.config?.callTimeoutMs ?? DEFAULTS.callTimeoutMs) {
    const data = await this.callRaw(path, body, timeoutMs)
    if (data.ok === false) throw new Error(`UI 自动化失败：${data.error ?? JSON.stringify(data).slice(0, 200)}`)
    return data
  }

  /** 断言失败是「结果」不是「错误」：调用方自己判断 ok，不要抛。 */
  async callRaw(path, body, timeoutMs = this.config?.callTimeoutMs ?? DEFAULTS.callTimeoutMs) {
    await this.ensure()
    const init = body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    let res
    try {
      res = await fetch(this.base + path, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      throw new Error(`sidecar 调用失败（${path}）：${err?.message ?? err}`)
    }
    const text = await res.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`sidecar 返回非 JSON：${text.slice(0, 200)}`)
    }
    if (!res.ok && data.ok !== false) throw new Error(`sidecar HTTP ${res.status}：${text.slice(0, 200)}`)
    if (!res.ok && data.ok === false && !('results' in data)) {
      throw new Error(`UI 自动化失败：${data.error ?? text.slice(0, 200)}`)
    }
    return data
  }

  stop() {
    const p = this.proc
    this.port = 0
    this.proc = undefined
    if (!p) return
    try {
      p.kill()
    } catch {
      /* 已退出 */
    }
  }
}

const fmtRect = (r) => (Array.isArray(r) && r.length >= 4 ? `@${r[0]},${r[1]} ${r[2]}x${r[3]}` : '@?')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function slug(s) {
  return String(s || 'case').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)
}

function defaultRunsDir() {
  return process.env.DSH_UITEST_RUNS || join(homedir(), '.dsh', 'uitest', 'runs')
}

/** {{var}} 模板替换：让 read 读到的值能喂给后面的 assert */
function render(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
  }
  if (Array.isArray(value)) return value.map((v) => render(v, vars))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = render(v, vars)
    return out
  }
  return value
}

function fmtEl(e, i) {
  const nm = e.name ? `「${e.name}」` : '「」'
  const id = e.id ? ` id=${e.id}` : ''
  const pats = e.pats ? ` [${e.pats}]` : ''
  const off = e.off ? ' (offscreen)' : ''
  const en = e.enabled === false ? ' (disabled)' : ''
  return `  ${i}. ${e.type}${id} ${nm}${pats}${en}${off} ${fmtRect(e.rect)}`
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const side = new Sidecar(ctx.logger?.('uitest') ?? ctx.logger, cfg)

  ctx.effect(() => () => side.stop())

  // 默认目标窗口：ui_attach 设一次，之后所有工具不传 hwnd/title 就默认用它
  let attached = null
  const tgt = (a) => {
    if (a && (a.hwnd || a.title || a.pid)) return { hwnd: a.hwnd, title: a.title, pid: a.pid }
    if (attached) return { hwnd: attached.hwnd, title: attached.title, pid: attached.pid }
    return {}
  }

  const hostParams = {
    hwnd: { type: 'number', description: '目标窗口句柄（优先；用 ui_windows 拿）' },
    title: { type: 'string', description: '窗口标题或标题片段（没给 hwnd 时用）' },
  }

  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.tools
    // 自己留一份注册表：插件的 tools 对象不保证有 get()，而 ui_run_cases 需要复用 ui_run_case
    const registry = new Map()
    const register = (t) => {
      registry.set(t.name, t)
      return tools.register(t)
    }

    register({
      name: 'ui_windows',
      description: '列出可自动化操作的窗口（hwnd / 标题 / 进程 / 矩形 / 是否前台）。测试前先调它拿 hwnd。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '只列标题包含该片段的窗口' },
          visibleOnly: { type: 'boolean', description: '只列可见窗口，默认 true' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        const data = await side.call('/windows', { title: a.title, visibleOnly: a.visibleOnly !== false })
        const rows = data.windows ?? []
        const lines = [`窗口 ${rows.length} 个：`]
        rows.forEach((w, i) => {
          lines.push(`  ${i + 1}. hwnd=${w.hwnd} pid=${w.pid} 「${w.title}」 ${fmtRect(w.rect)}${w.foreground ? ' 前台' : ''}`)
        })
        return { text: lines.join('\n') }
      },
    })

    register({
      name: 'ui_attach',
      description:
        '绑定默认目标窗口：之后所有 ui_* 工具不传 hwnd/title 就默认操作这个窗口。换项目/换应用只需换一次 attach。action=clear 解绑。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '窗口标题或标题片段' },
          hwnd: { type: 'number', description: '也可直接给句柄' },
          pid: { type: 'number', description: '也可按进程 id 绑它第一个有标题的主窗口（多窗口应用用它）' },
          action: { type: 'string', description: 'clear=解绑；默认 attach' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        if (String(a.action || '').toLowerCase() === 'clear') {
          attached = null
          return { text: '已解绑默认窗口。' }
        }
        const data = await side.callRaw('/windows', { title: a.title, pid: a.pid, visibleOnly: false })
        const wins = data.windows ?? []
        let pick = null
        if (a.hwnd) pick = { hwnd: a.hwnd, title: wins.find((w) => w.hwnd === a.hwnd)?.title ?? '' }
        else if (wins.length) pick = { hwnd: wins[0].hwnd, title: wins[0].title, pid: wins[0].pid }
        if (!pick) {
          const near = wins.slice(0, 8).map((w) => `  hwnd=${w.hwnd} pid=${w.pid} 「${w.title}」`).join('\n')
          throw new Error(`没找到窗口${a.title ? `（标题含「${a.title}」）` : a.pid ? `（pid=${a.pid}）` : ''}。当前可见窗口：\n${near || '  （无）'}`)
        }
        attached = pick
        return { text: `已绑定默认窗口：hwnd=${pick.hwnd}${pick.pid ? ` pid=${pick.pid}` : ''}「${pick.title}」\n之后 ui_tree / ui_assert / ui_ocr 等不传 hwnd/title 就默认用它。` }
      },
    })

    register({
      name: 'ui_tree',
      description:
        '读控件树（UIA）。返回每个控件的类型 / AutomationId / Name / 支持的自动化模式 / 矩形。比截图+OCR 便宜且精确，UI 测试的首选感知手段。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...hostParams,
          max: { type: 'number', description: '最多返回多少个控件，默认 200' },
          type: { type: 'string', description: '只列某类控件，如 Button / DataGrid / Edit / Header' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        const data = await side.call('/call', {
          cmd: 'tree', ...tgt(a), max: a.max ?? 200, type: a.type,
        })
        const els = data.elements ?? []
        const lines = [
          `控件 ${data.shown ?? els.length} 个（总 ${data.total ?? '?'}，耗时 ${data.ms}ms）${a.type ? `，只看 ${a.type}` : ''}：`,
          ...els.slice(0, 200).map((e, i) => fmtEl(e, i + 1)),
        ]
        return { text: lines.join('\n') }
      },
    })

    register({
      name: 'ui_find',
      description: '按 AutomationId / Name / 控件类型定位控件（Name 默认子串匹配）。返回是否找到、匹配数量、以及该控件的完整信息。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...hostParams,
          id: { type: 'string', description: 'AutomationId，如 btnAdd' },
          name: { type: 'string', description: '控件文字（默认子串匹配）' },
          nameExact: { type: 'boolean', description: 'Name 必须完全相等' },
          type: { type: 'string', description: '控件类型，如 Button / DataGrid / Header' },
          index: { type: 'number', description: '匹配到多个时取第几个，默认 0' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        const data = await side.call('/call', {
          cmd: 'find', ...tgt(a),
          id: a.id, name: a.name, nameExact: a.nameExact, type: a.type, index: a.index ?? 0,
        })
        if (!data.found) return { text: `没找到（匹配 ${data.matches ?? 0} 个，耗时 ${data.ms}ms）` }
        return {
          text: `找到 ${data.matches} 个匹配，第 ${(a.index ?? 0) + 1} 个：\n${fmtEl(data.element, 1)}\n耗时 ${data.ms}ms`,
        }
      },
    })

    register({
      name: 'ui_invoke',
      description:
        '触发控件（InvokePattern / SelectionItem.Select），**不抢焦点、不依赖坐标**——这是比 SendInput 点击最关键的差别。按钮、菜单项、树节点都能用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...hostParams,
          id: { type: 'string', description: 'AutomationId，如 btnAdd' },
          name: { type: 'string', description: '控件文字（默认子串匹配）' },
          nameExact: { type: 'boolean', description: 'Name 必须完全相等' },
          type: { type: 'string', description: '控件类型，如 Button / MenuItem' },
          index: { type: 'number', description: '匹配到多个时取第几个，默认 0' },
          expect: {
            type: 'object',
            description: '可选：触发后要等到的现象，如 {"id":"dgvEmployees","expect":{"exists":true}} 或 {"name":"新增员工"}',
            additionalProperties: true,
          },
          waitMs: { type: 'number', description: '触发后等待多久再验证，默认 1200ms' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        const data = await side.call('/call', {
          cmd: 'invoke', ...tgt(a),
          id: a.id, name: a.name, nameExact: a.nameExact, type: a.type, index: a.index ?? 0,
        })
        const el = data.element ?? {}
        const lines = [`已触发 ${el.type ?? '?'}${el.id ? ` id=${el.id}` : ''}「${el.name ?? ''}」（${data.via}，耗时 ${data.ms}ms）`]
        if (a.expect) {
          const wait = Number(a.waitMs ?? 1200)
          await new Promise((r) => setTimeout(r, wait))
          const chk = await side.callRaw('/call', {
            cmd: 'assert', ...tgt(a), checks: [a.expect],
          })
          const one = (chk.results ?? [])[0] ?? {}
          lines.push(one.ok ? `验证通过（等待 ${wait}ms）：${one.sel}` : `⚠ 验证失败（等待 ${wait}ms）：${one.sel} ${one.detail ?? ''}`)
        }
        return { text: lines.join('\n') }
      },
    })

    register({
      name: 'ui_set',
      description: '写入输入框（ValuePattern.SetValue）。不抢焦点、不模拟键盘；写不了时会明说该控件不支持。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...hostParams,
          id: { type: 'string', description: 'AutomationId' },
          name: { type: 'string', description: '控件文字' },
          nameExact: { type: 'boolean', description: 'Name 完全相等' },
          type: { type: 'string', description: '控件类型，默认 Edit' },
          value: { type: 'string', description: '要写入的值' },
          index: { type: 'number', description: '匹配多个时取第几个，默认 0' },
        },
        required: ['value'],
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        const data = await side.call('/call', {
          cmd: 'set', ...tgt(a),
          id: a.id, name: a.name, nameExact: a.nameExact, type: a.type, value: String(a.value ?? ''),
          index: a.index ?? 0,
        })
        return { text: `已写入「${data.value}」（${data.via}，耗时 ${data.ms}ms）` }
      },
    })

    register({
      name: 'ui_read',
      description: '读控件属性：prop=Name / Value / Enabled / Type / Offscreen / Text（Text 走 TextPattern）。断言前的读数都该用这个。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...hostParams,
          id: { type: 'string', description: 'AutomationId' },
          name: { type: 'string', description: '控件文字' },
          nameExact: { type: 'boolean', description: 'Name 完全相等' },
          type: { type: 'string', description: '控件类型' },
          prop: { type: 'string', description: 'Name / Value / Enabled / Type / Offscreen / Text，默认 Name' },
          index: { type: 'number', description: '匹配多个时取第几个，默认 0' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        const data = await side.call('/call', {
          cmd: 'read', ...tgt(a),
          id: a.id, name: a.name, nameExact: a.nameExact, type: a.type,
          prop: a.prop ?? 'Name', index: a.index ?? 0,
        })
        const v = data.value
        return {
          text: `prop=${data.prop} value=${typeof v === 'string' ? `「${v}」` : String(v)}\n匹配 ${data.matches} 个\n耗时 ${data.ms}ms`,
        }
      },
    })

    register({
      name: 'ui_wait',
      description:
        '等控件出现/消失（轮询 UIA，默认 250ms 一次）。专治「点了之后界面还没出来」的 flaky，别再用固定 sleep。state=exists（默认）| gone。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...hostParams,
          id: { type: 'string', description: 'AutomationId' },
          name: { type: 'string', description: '控件文字（子串匹配）' },
          nameExact: { type: 'boolean', description: 'Name 完全相等' },
          type: { type: 'string', description: '控件类型，如 Button / DataGrid' },
          state: { type: 'string', description: 'exists 或 gone，默认 exists' },
          timeoutMs: { type: 'number', description: '超时毫秒，默认 5000' },
          pollMs: { type: 'number', description: '轮询间隔，默认 250' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        const data = await side.callRaw('/call', {
          cmd: 'wait', ...tgt(a),
          id: a.id, name: a.name, nameExact: a.nameExact, type: a.type,
          state: a.state ?? 'exists', timeoutMs: a.timeoutMs ?? 5000, pollMs: a.pollMs ?? 250,
        })
        const sel = a.id ? `id=${a.id}` : a.name ? `name=${a.name}` : a.type ? `type=${a.type}` : '(空选择器)'
        if (data.ok) return { text: `等到 ${sel} ${data.state}（${data.waitedMs}ms，匹配 ${data.matches}）` }
        return { text: `⚠ 等待超时：${sel} 在 ${data.waitedMs}ms 内没有变成 ${data.state}` }
      },
    })

    register({
      name: 'ui_ocr',
      description:
        'OCR 兜底：截图 + 本地 WinRT OCR，返回文字行及其屏幕坐标（零视觉 token）。控件没有 UIA（自绘/第三方控件）时用它读界面。默认按窗口大小自适应放大，语言优先 zh-Hans-CN。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...hostParams,
          region: { type: 'array', description: '窗口内相对区域 [x,y,w,h]，可选', items: { type: 'number' } },
          scale: { type: 'number', description: '放大倍率，默认按窗口大小自适应（长边约 2200px）' },
          lang: { type: 'string', description: 'OCR 语言，如 zh-Hans-CN / en-US，默认自动选中文' },
          focus: { type: 'boolean', description: '截图前先把窗口切到前台，默认 true（被遮挡时截图会是别的窗口）' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        const data = await side.callRaw('/ocr', {
          ...tgt(a), region: a.region, scale: a.scale, lang: a.lang, focus: a.focus !== false,
        })
        if (data.ok === false) throw new Error(`OCR 失败：${data.error ?? ''}`)
        const lines = data.lines ?? []
        const head = `OCR ${data.count} 行（${data.lang}，OCR ${data.ocrMs}ms，总 ${data.wallMs}ms）｜窗口 ${fmtRect(data.rect)}`
        return {
          text: [head, ...lines.map((l, i) => `  ${i + 1}. 「${l.text}」@${l.absX},${l.absY} ${l.w}x${l.h}`)].join('\n'),
        }
      },
    })

    register({
      name: 'ui_click',
      description:
        '按坐标点击（SendInput）。坐标为屏幕绝对像素；给了 hwnd/title 会先把该窗口切到前台再点。只给 x,y 且带 hwnd 时按窗口相对坐标解释。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...hostParams,
          x: { type: 'number', description: '横坐标' },
          y: { type: 'number', description: '纵坐标' },
          relative: { type: 'boolean', description: 'x,y 是否相对窗口左上角（需要 hwnd/title）' },
          button: { type: 'string', description: 'left / right / middle，默认 left' },
          double: { type: 'boolean', description: '双击' },
        },
        required: ['x', 'y'],
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        let x = Number(a.x)
        let y = Number(a.y)
        if (a.relative && (a.hwnd || a.title)) {
          const wins = await side.callRaw('/windows', { title: a.title, visibleOnly: false })
          const w = (wins.windows ?? []).find((z) => (a.hwnd ? z.hwnd === a.hwnd : true))
          if (!w) throw new Error('找不到目标窗口')
          x += w.rect[0]
          y += w.rect[1]
        }
        const data = await side.callRaw('/click', { x, y, button: a.button ?? 'left', double: a.double })
        return { text: `已点击 (${data.clicked?.[0]},${data.clicked?.[1]}) ${data.button}${a.double ? ' 双击' : ''}` }
      },
    })

    register({
      name: 'ui_click_text',
      description:
        'OCR 定位 + 按文字点击（控件没有 UIA 时的兜底动作）。先切窗口到前台 → 截图 → OCR → 匹配文字 → 点中心。先精确匹配，失败才用编辑距离兜底并标注 matchType=fuzzy，模糊命中建议跟一条 ui_assert 验证。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...hostParams,
          text: { type: 'string', description: '要点的文字（子串即可）' },
          index: { type: 'number', description: '匹配多行时点第几个，默认 0' },
          region: { type: 'array', description: '只在窗口这块区域内找 [x,y,w,h]，可选', items: { type: 'number' } },
          scale: { type: 'number', description: 'OCR 放大倍率，默认自适应' },
          button: { type: 'string', description: 'left / right，默认 left' },
          expect: {
            type: 'object',
            description: '可选：点完之后要等到的现象（走 UIA 断言），如 {"id":"dgvEmployees","expect":{"exists":true}}',
            additionalProperties: true,
          },
          waitMs: { type: 'number', description: '点完等多久再验证，默认 900ms' },
        },
        required: ['text'],
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        const data = await side.callRaw('/click_text', {
          ...tgt(a), text: a.text, index: a.index ?? 0,
          region: a.region, scale: a.scale, button: a.button ?? 'left',
        })
        if (data.ok === false) {
          const seen = (data.seen ?? []).slice(0, 12).join('、')
          throw new Error(`${data.error ?? '没点到'}${seen ? `\nOCR 当前读到：${seen}` : ''}`)
        }
        const m = data.matched ?? {}
        const warn = data.matchType === 'fuzzy' ? `\n⚠ 模糊匹配（编辑距离 ${data.distance}）：OCR 读成「${m.text}」，建议跟一条 ui_assert 复核` : ''
        const lines = [
          `按文字点「${a.text}」→ 命中「${m.text}」@${m.absX},${m.absY}，点击 (${data.clicked?.[0]},${data.clicked?.[1]})（匹配 ${data.matches} 处，OCR ${data.ocrMs}ms）${warn}`,
        ]
        if (a.expect) {
          const wait = Number(a.waitMs ?? 900)
          await new Promise((r) => setTimeout(r, wait))
          const chk = await side.callRaw('/call', {
            cmd: 'assert', ...tgt(a), checks: [a.expect],
          })
          const one = (chk.results ?? [])[0] ?? {}
          lines.push(one.ok ? `验证通过（等待 ${wait}ms）：${one.sel}` : `⚠ 验证失败（等待 ${wait}ms）：${one.sel} ${one.detail ?? ''}`)
        }
        return { text: lines.join('\n') }
      },
    })

    register({
      name: 'ui_assert',
      description:
        '批量断言（UI 测试的核心）。每条检查给选择器 + expect（exists / count / name / enabled / offscreen），返回逐条 PASS/FAIL 与原因。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...hostParams,
          checks: {
            type: 'array',
            description: '检查项数组，如 [{"id":"btnAdd","expect":{"exists":true,"name":"新增"}}]',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['checks'],
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        const checks = Array.isArray(a.checks) ? a.checks : []
        if (!checks.length) throw new Error('checks 不能为空')
        const data = await side.callRaw('/call', { cmd: 'assert', ...tgt(a), checks })
        const rows = data.results ?? []
        const lines = [
          `${data.ok ? '全部通过' : `有 ${data.failed} 条失败`}（${data.total} 条，耗时 ${data.ms}ms）`,
          ...rows.map((r) => `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.sel || '(空选择器)'}  匹配 ${r.matches}${r.detail ? '  ' + r.detail : ''}`),
        ]
        return { text: lines.join('\n') }
      },
    })

    register({
      name: 'ui_run_case',
      description:
        '跑一条 UI 测试用例：按顺序执行步骤（assert / invoke / set / read / wait / screenshot / sleep），逐条记录 PASS/FAIL 与耗时，并把 report.json + report.md + 每步截图写到证据目录。步骤里可用 {{var}} 引用前面 read 出来的值。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          case: {
            type: 'object',
            description: '用例对象：{name, window:{title|hwnd}, steps:[...]}',
            additionalProperties: true,
          },
          steps: {
            type: 'array',
            description: '也可以直接给步骤数组（配合 window 参数）',
            items: { type: 'object', additionalProperties: true },
          },
          window: { type: 'object', description: '默认目标窗口 {title|hwnd}', additionalProperties: true },
          evidenceDir: { type: 'string', description: '证据目录，默认 ~/.dsh/uitest/runs/<时间戳>-<用例名>' },
          screenshots: { type: 'boolean', description: '每步截图存证，默认 true' },
          stopOnFail: { type: 'boolean', description: '遇失败即停（后续标记跳过），默认 true' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        const spec = a.case && typeof a.case === 'object' ? a.case : { name: a.name || 'case', window: a.window, steps: a.steps }
        const steps = Array.isArray(spec.steps) ? spec.steps : []
        if (!steps.length) throw new Error('用例没有 steps')
        const baseWindow = spec.window || a.window || {}
        const dir = a.evidenceDir || join(defaultRunsDir(), `${stamp()}-${slug(spec.name)}`)
        mkdirSync(dir, { recursive: true })
        const wantShots = a.screenshots !== false
        const stopOnFail = a.stopOnFail !== false
        const vars = {}
        const results = []

        const winOf = (s) => {
          const w = s.window && typeof s.window === 'object' ? s.window : {}
          return { hwnd: w.hwnd ?? s.hwnd ?? baseWindow.hwnd, title: w.title ?? s.title ?? baseWindow.title }
        }

        const shot = async (win, name) => {
          if (!wantShots) return null
          try {
            const r = await side.callRaw('/call', {
              cmd: 'screenshot', hwnd: win.hwnd, title: win.title, out: join(dir, `${name}.png`),
            })
            return r.ok ? r.path : null
          } catch {
            return null
          }
        }

        for (let i = 0; i < steps.length; i++) {
          const step = render(steps[i] || {}, vars)
          const kind = String(step.type || 'assert').toLowerCase()
          const win = winOf(step)
          const t0 = Date.now()
          let ok = false
          let detail = ''
          try {
            if (kind === 'sleep') {
              const ms = Number(step.ms ?? 500)
              await sleep(ms)
              ok = true
              detail = `等待 ${ms}ms`
            } else if (kind === 'assert') {
              const data = await side.callRaw('/call', { cmd: 'assert', hwnd: win.hwnd, title: win.title, checks: step.checks || [] })
              ok = data.ok === true
              detail = (data.results || []).map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.sel}${r.detail ? ' ' + r.detail : ''}`).join(' | ')
            } else if (kind === 'invoke') {
              const data = await side.callRaw('/call', {
                cmd: 'invoke', hwnd: win.hwnd, title: win.title,
                id: step.id, name: step.name, nameExact: step.nameExact, type: step.controlType, index: step.index ?? 0,
              })
              ok = data.ok !== false
              detail = `触发 ${data.via ?? ''}「${data.element?.name ?? ''}」`
              if (ok && step.expect) {
                await sleep(Number(step.waitMs ?? 900))
                const chk = await side.callRaw('/call', { cmd: 'assert', hwnd: win.hwnd, title: win.title, checks: [step.expect] })
                const one = (chk.results || [])[0] || {}
                ok = chk.ok === true
                detail += one.ok ? `；验证通过 ${one.sel}` : `；⚠ 验证失败 ${one.sel} ${one.detail ?? ''}`
              }
            } else if (kind === 'set') {
              const data = await side.callRaw('/call', {
                cmd: 'set', hwnd: win.hwnd, title: win.title,
                id: step.id, name: step.name, nameExact: step.nameExact, type: step.controlType, value: String(step.value ?? ''),
              })
              ok = data.ok !== false
              detail = `写入「${data.value}」`
            } else if (kind === 'read') {
              const data = await side.callRaw('/call', {
                cmd: 'read', hwnd: win.hwnd, title: win.title,
                id: step.id, name: step.name, nameExact: step.nameExact, type: step.controlType, prop: step.prop ?? 'Name',
              })
              ok = data.ok !== false
              const key = step.save || `step${i + 1}`
              vars[key] = data.value
              detail = `${step.prop ?? 'Name'}=${JSON.stringify(data.value)} → {{${key}}}`
            } else if (kind === 'wait') {
              const data = await side.callRaw('/call', {
                cmd: 'wait', hwnd: win.hwnd, title: win.title,
                id: step.id, name: step.name, nameExact: step.nameExact, type: step.controlType,
                state: step.state ?? 'exists', timeoutMs: step.timeoutMs ?? 5000, pollMs: step.pollMs ?? 250,
              })
              ok = data.ok === true
              detail = data.ok ? `等到 ${data.state}（${data.waitedMs}ms）` : `⚠ 超时：没有变成 ${data.state}`
            } else if (kind === 'ocr') {
              const data = await side.callRaw('/ocr', {
                hwnd: win.hwnd, title: win.title, region: step.region, scale: step.scale, lang: step.lang,
                focus: step.focus !== false,
              })
              ok = data.ok !== false
              const texts = (data.lines || []).map((l) => l.text)
              if (step.save) vars[step.save] = texts
              detail = `OCR ${data.count} 行（${data.ocrMs}ms）${step.save ? ` → {{${step.save}}}` : ''}: ${texts.slice(0, 8).join(' | ')}`
            } else if (kind === 'click_text') {
              const data = await side.callRaw('/click_text', {
                hwnd: win.hwnd, title: win.title, text: step.text, index: step.index ?? 0,
                region: step.region, scale: step.scale, button: step.button ?? 'left',
              })
              ok = data.ok !== false
              detail = ok
                ? `按文字点「${step.text}」→「${data.matched?.text}」(${data.clicked?.[0]},${data.clicked?.[1]})${data.matchType === 'fuzzy' ? ' ⚠模糊' : ''}`
                : `⚠ ${data.error}`
              if (ok && step.expect) {
                await sleep(Number(step.waitMs ?? 900))
                const chk = await side.callRaw('/call', { cmd: 'assert', hwnd: win.hwnd, title: win.title, checks: [step.expect] })
                const one = (chk.results || [])[0] || {}
                ok = chk.ok === true
                detail += one.ok ? '；验证通过' : `；⚠ 验证失败 ${one.detail ?? ''}`
              }
            } else if (kind === 'click') {
              const data = await side.callRaw('/click', { x: step.x, y: step.y, button: step.button ?? 'left', double: !!step.double })
              ok = data.ok !== false
              detail = `点击 (${data.clicked?.[0]},${data.clicked?.[1]})`
            } else if (kind === 'screenshot') {
              const path = await shot(win, `${String(i + 1).padStart(2, '0')}-${slug(step.label || 'shot')}`)
              ok = !!path
              detail = path ? `截图 ${path}` : '截图失败'
            } else {
              ok = false
              detail = `未知步骤类型 ${kind}`
            }
          } catch (err) {
            ok = false
            detail = `异常：${err?.message ?? err}`
          }
          const ms = Date.now() - t0
          let evidencePath = null
          if (wantShots && kind !== 'screenshot') {
            evidencePath = await shot(win, `${String(i + 1).padStart(2, '0')}-${kind}`)
          }
          results.push({ i: i + 1, kind, ok, detail, ms, evidencePath })
          if (!ok && stopOnFail) {
            for (let j = i + 1; j < steps.length; j++) {
              results.push({ i: j + 1, kind: String(steps[j]?.type || 'assert'), ok: false, skipped: true, detail: '前一步失败，跳过', ms: 0, evidencePath: null })
            }
            break
          }
        }

        const passed = results.filter((r) => r.ok).length
        const failed = results.filter((r) => !r.ok && !r.skipped).length
        const report = {
          name: spec.name ?? 'case',
          startedAt: new Date().toISOString(),
          dir,
          window: baseWindow,
          total: results.length,
          passed,
          failed,
          ok: failed === 0 && results.every((r) => r.ok),
          vars,
          results,
        }
        writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
        const md = [
          `# ${report.name}`,
          '',
          `- 结果：${report.ok ? '全部通过' : `${failed} 条失败`}（${passed}/${results.length}）`,
          `- 时间：${report.startedAt}`,
          `- 窗口：${baseWindow.title ?? baseWindow.hwnd ?? '?'}`,
          '',
          '| # | 类型 | 结果 | 耗时 | 说明 |',
          '|---|---|---|---|---|',
          ...results.map((r) => `| ${r.i} | ${r.kind} | ${r.skipped ? '跳过' : r.ok ? 'PASS' : 'FAIL'} | ${r.ms}ms | ${String(r.detail).replace(/\|/g, '\\|')} |`),
        ].join('\n')
        writeFileSync(join(dir, 'report.md'), md, 'utf8')
        lastCaseReport = report

        const lines = [
          `${report.ok ? '✅ 用例通过' : `❌ 用例失败（${failed} 条）`}：${report.name}（${passed}/${results.length}，${results.reduce((s, r) => s + r.ms, 0)}ms）`,
          ...results.map((r) => `  ${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${String(r.i).padStart(2)}. ${r.kind.padEnd(10)} ${String(r.ms).padStart(5)}ms  ${r.detail}`),
          `证据目录：${dir}`,
        ]
        return { text: lines.join('\n') }
      },
    })

    register({
      name: 'ui_run_cases',
      description:
        '批量跑用例：从用例目录读 *.json 逐条执行，每条产出自己的证据目录，另外写一份汇总（summary.md / summary.json）。用来做回归/进 CI。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string', description: '用例目录，默认 ~/.dsh/uitest/cases（不存在则用插件自带 examples/cases）' },
          files: { type: 'array', description: '指定用例文件绝对路径列表，给了就不扫目录', items: { type: 'string' } },
          filter: { type: 'string', description: '只跑文件路径包含该字符串的用例' },
          window: { type: 'string', description: '给没有 window 字段的用例注入默认窗口标题' },
          stopOnFail: { type: 'boolean', description: '某条用例失败后停止后续（默认继续跑完）' },
          screenshots: { type: 'boolean', description: '每步截图存证，默认 true' },
          evidenceDir: { type: 'string', description: '汇总目录，默认 ~/.dsh/uitest/runs/<时间戳>-batch' },
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const a = args && typeof args === 'object' ? args : {}
        const userCases = join(homedir(), '.dsh', 'uitest', 'cases')
        const dir = a.dir || cfg.caseDir || (existsSync(userCases) ? userCases : join(HERE, 'examples', 'cases'))
        let files = []
        if (Array.isArray(a.files) && a.files.length) files = a.files.map(String)
        else {
          if (!existsSync(dir)) throw new Error(`用例目录不存在：${dir}`)
          files = readdirSync(dir)
            .filter((f) => f.toLowerCase().endsWith('.json'))
            .sort()
            .map((f) => join(dir, f))
        }
        if (a.filter) files = files.filter((f) => f.includes(a.filter))
        if (!files.length) throw new Error(`没有找到用例（目录 ${dir}）`)

        const batchDir = a.evidenceDir || join(defaultRunsDir(), `${stamp()}-batch`)
        mkdirSync(batchDir, { recursive: true })
        const runner = registry.get('ui_run_case')
        const rows = []
        for (const file of files) {
          let spec
          try {
            spec = JSON.parse(readFileSync(file, 'utf8'))
          } catch (err) {
            rows.push({ file, name: basename(file), ok: false, total: 0, passed: 0, failed: 1, dir: '', error: `用例文件解析失败：${err.message}` })
            continue
          }
          const name = spec.name || basename(file, '.json')
          if (!spec.window && a.window) spec.window = { title: a.window }
          const caseDir = join(batchDir, slug(name))
          try {
            await runner.execute({ case: spec, evidenceDir: caseDir, screenshots: a.screenshots !== false, stopOnFail: spec.stopOnFail !== false })
            const rep = lastCaseReport || {}
            rows.push({ file, name, ok: rep.ok === true, total: rep.total ?? 0, passed: rep.passed ?? 0, failed: rep.failed ?? 0, dir: caseDir })
          } catch (err) {
            rows.push({ file, name, ok: false, total: 0, passed: 0, failed: 1, dir: caseDir, error: String(err?.message ?? err) })
          }
          if (!rows[rows.length - 1].ok && a.stopOnFail) break
        }

        const passedCases = rows.filter((r) => r.ok).length
        const failedCases = rows.length - passedCases
        const summary = {
          at: new Date().toISOString(),
          dir: batchDir,
          total: rows.length,
          passed: passedCases,
          failed: failedCases,
          ok: failedCases === 0,
          cases: rows,
        }
        writeFileSync(join(batchDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
        lastBatchSummary = summary
        const md = [
          '# 批量用例汇总',
          '',
          `- 时间：${summary.at}`,
          `- 结果：${failedCases === 0 ? '全部通过' : `${failedCases} 条用例失败`}（${passedCases}/${rows.length}）`,
          `- 用例目录：${dir}`,
          '',
          '| 用例 | 结果 | 步骤 | 证据目录 |',
          '|---|---|---|---|',
          ...rows.map((r) => `| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.passed}/${r.total}${r.error ? ` ${r.error}` : ''} | ${r.dir || '-'} |`),
        ].join('\n')
        writeFileSync(join(batchDir, 'summary.md'), md, 'utf8')

        const lines = [
          `${failedCases === 0 ? '✅ 批量用例全部通过' : `❌ 批量用例有 ${failedCases} 条失败`}（${passedCases}/${rows.length}）`,
          ...rows.map((r) => `  ${r.ok ? 'PASS' : 'FAIL'}  ${String(r.name).padEnd(26)} ${r.passed}/${r.total}${r.error ? '  ' + r.error : ''}`),
          `汇总：${join(batchDir, 'summary.md')}`,
        ]
        return { text: lines.join('\n') }
      },
    })
  })
}
