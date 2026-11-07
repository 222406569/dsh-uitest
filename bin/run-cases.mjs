#!/usr/bin/env node
/**
 * CI / 命令行入口：不启动 DSH 界面也能批量跑用例。
 *
 * 用法：
 *   node bin/run-cases.mjs --dir examples/cases --window "仓库管理系统" --out runs/ci
 *   node bin/run-cases.mjs --dir D:\myproj\uitest-cases --out D:\myproj\runs
 *
 * 退出码：0 = 全部通过；1 = 有失败（可直接用于 CI 判定）
 */

import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const MOD = resolve(ROOT, 'bundle', 'host.js')

const argv = process.argv.slice(2)
const val = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  if (i < 0) return dflt
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : dflt
}
const has = (name) => argv.includes('--' + name)

if (!existsSync(MOD)) {
  console.error(`找不到插件：${MOD}`)
  process.exit(2)
}

const mod = await import('file://' + MOD.replace(/\\/g, '/'))
const tools = new Map()
const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  effect: (fn) => {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  inject: (_names, fn) => fn({ tools: { register: (t) => tools.set(t.name, t) } }),
}
mod.apply(ctx, {})

const runner = tools.get('ui_run_cases')
if (!runner) {
  console.error('插件没有注册 ui_run_cases')
  process.exit(2)
}

const dir = val('dir', join(ROOT, 'examples', 'cases'))
const out = val('out', join(ROOT, 'runs', 'ci-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)))

let res
try {
  res = await runner.execute({
    dir,
    window: val('window'),
    filter: val('filter'),
    evidenceDir: out,
    screenshots: !has('no-screenshots'),
    stopOnFail: has('stop-on-fail'),
  })
} catch (err) {
  console.error('运行失败：' + (err?.message ?? err))
  process.exit(2)
}

console.log(res.text)

const summary = typeof mod.getLastBatchSummary === 'function' ? mod.getLastBatchSummary() : null
console.log('')
console.log(`退出码：${summary && summary.ok ? 0 : 1}`)
process.exit(summary && summary.ok ? 0 : 1)
