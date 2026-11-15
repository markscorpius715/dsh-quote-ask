/**
 * dsh-quote-ask — 本地冒烟测试（不需要浏览器、不需要重启 DSH）。
 *
 * 用 jsdom + React 服务端渲染模拟 DSH 聊天页与客户端服务面，验证：
 *   1. bundle 信封注册、factory 产出的 exports 形状（apply / inject / name）；
 *   2. 选中聊天文字后浮出「向 DeepSeek 提问」按钮；
 *   3. 点击按钮：引用挂进当前会话的卡片仓库，焦点回到输入框，**不新建会话**；
 *   4. 引用卡片组件能在输入框上方渲染出引用内容；
 *   5. 同一会话里输入问题后回车 / 点发送按钮：引用块合并进消息并只调用一次 submit；
 *   6. 停止按钮不被发送拦截误伤；
 *   7. dispose 后按钮与监听都被清理。
 *
 * 运行：npm install 之后 `node test/smoke.mjs`。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply as hostApply, name as hostName } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8')

let failures = 0
function check(label, condition, extra) {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}${extra === undefined ? '' : ` — ${extra}`}`)
  }
}

console.log('· host half')
check('name 为 dsh-quote-ask', hostName === 'dsh-quote-ask')
check('不与新建会话耦合', !clientSource.includes('startSession'), 'client.js 仍含 startSession')

console.log('· bundle 信封')
const dom = new JSDOM(
  `<!doctype html><html><body>
    <div data-conversation-scroll>
      <div data-chat-anchor-key="k1" data-chat-flow-kind="assistant" data-chat-turn="3">
        <div id="msg">这条回答里有一段我想追问的解释。</div>
      </div>
    </div>
    <div data-composer-card>
      <div data-composer-input contenteditable="true" id="editor"></div>
      <button id="send" aria-label="发送消息">↑</button>
      <button id="stop" aria-label="停止生成">■</button>
    </div>
  </body></html>`,
  { url: 'http://127.0.0.1:3080/', runScripts: 'outside-only' },
)
const { window } = dom
const { document } = window

// jsdom 没有实现 Range#getBoundingClientRect，补一个非零矩形。
const rangeRect = { left: 100, top: 200, right: 500, bottom: 220, width: 400, height: 20 }
window.Range.prototype.getBoundingClientRect = () => rangeRect

// 手动 rAF 队列：测试自己推进帧，避免真实计时器的不确定。
const rafQueue = []
window.requestAnimationFrame = (callback) => {
  rafQueue.push(callback)
  return rafQueue.length
}
window.cancelAnimationFrame = () => {}
function flushFrames(limit = 200) {
  let frames = 0
  while (rafQueue.length > 0 && frames < limit) {
    const batch = rafQueue.splice(0)
    for (const callback of batch) callback(frames)
    frames += 1
  }
  return frames
}

let captured = null
window.__ModuleLoader__ = { load: (definition) => { captured = definition } }
window.eval(clientSource)

check('bundle 调用了 __ModuleLoader__.load', captured !== null)
check('module id 正确', captured?.id === 'dsh-quote-ask')

const fakeRequire = (name) => {
  if (name === 'react') return React
  throw new Error(`client bundle requires unexpected module ${String(name)}`)
}
const exported = captured.factory(fakeRequire)
check('导出 apply / inject / name',
  typeof exported.apply === 'function' && Array.isArray(exported.inject) && exported.name === 'dsh-quote-ask')
check('注入 sessions 与 slots',
  exported.inject.includes('sessions') && exported.inject.includes('slots'), JSON.stringify(exported.inject))

// ── 伪造客户端服务面 ────────────────────────────────────────────────────
const state = {
  draft: '',
  submitted: 0,
  focusCalls: 0,
  setDraftCalls: [],
  disposals: [],
  dock: null,
}
const sessionsSnapshot = {
  ids: ['s1'],
  byId: { s1: { id: 's1', retainedBy: { mainView: 1 }, updatedAt: 1 } },
}
const inputActions = {
  setDraft: (text) => {
    state.setDraftCalls.push(text)
    // 编辑器提交后 published draft 才更新；这里同步模拟一次提交。
    state.draft = text
  },
  submit: () => { state.submitted += 1 },
}
const fakeBinding = {
  key: 's1',
  hooks: { input: { getSnapshot: () => ({ draft: state.draft }) } },
  props: { inputActions },
}
const facade = {
  state: { getSnapshot: () => ({ draft: state.draft }) },
  setDraft: (text) => { state.draft = text },
  focus: () => { state.focusCalls += 1 },
}
const fakeCtx = {
  sessions: {
    list: { getSnapshot: () => sessionsSnapshot },
    scope: (sessionId) => (sessionId === 's1' ? { sessionId } : undefined),
  },
  slots: {
    inject: (name, configure) => configure(),
    register: (options, Component) => {
      state.dock = { name: options.name, id: options.id, order: options.order, Component }
      return () => {}
    },
  },
  get: (service) => {
    if (service === 'uiSession') return { current: { getSnapshot: () => fakeBinding } }
    if (service === 'conversation') return { input: { for: () => facade } }
    return undefined
  },
  effect: (fn) => {
    const dispose = fn()
    state.disposals.push(dispose)
    return dispose
  },
}

console.log('· 选区浮层')
exported.apply(fakeCtx)
check('注册了输入框上方的引用卡片区（conversation.input.dock）',
  state.dock !== null && state.dock.name === 'conversation.input.dock', JSON.stringify(state.dock?.name))

const message = document.getElementById('msg')
const textNode = message.firstChild
const fakeSelection = {
  isCollapsed: false,
  rangeCount: 1,
  toString: () => '有一段我想追问的解释',
  removeAllRanges: () => { fakeSelection.isCollapsed = true },
  getRangeAt: () => ({
    commonAncestorContainer: textNode,
    startContainer: textNode,
    endContainer: textNode,
    getBoundingClientRect: () => rangeRect,
  }),
}
document.getSelection = () => fakeSelection
document.dispatchEvent(new window.Event('mouseup'))
flushFrames()
const host = document.querySelector('[data-dsh-quote-ask]')
check('选中聊天文字后浮出按钮', host !== null && host.style.display === 'inline-flex', host?.style.display)

console.log('· 点击提问（同一会话 + 引用卡片）')
const button = host?.querySelector('button')
check('按钮文案为「向 DeepSeek 提问」', button?.textContent?.includes('向 DeepSeek 提问'), button?.textContent)
button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
flushFrames()
check('没有调用任何新建会话的入口', !('uiWorkspace' in state))
check('焦点回到输入框', state.focusCalls === 1)
check('浮层按钮已收起', host.style.display === 'none', host.style.display)
check('卡片内容写进了输入框草稿之外（未污染草稿）', state.draft === '', JSON.stringify(state.draft))

const cardHtml = renderToStaticMarkup(React.createElement(state.dock.Component, {
  session: { sessionId: 's1' },
  input: { draft: state.draft },
}))
check('引用卡片渲染在输入框上方', cardHtml.includes('有一段我想追问的解释'), cardHtml.slice(0, 120))
check('卡片带来源轮次', cardHtml.includes('第 3 轮 · 助手回答'), '')
check('卡片提供「放入输入框」与移除', cardHtml.includes('放入输入框') && cardHtml.includes('移除引用'))
check('卡片与输入框对齐（复用 composer 的 side clearance / max-width 变量）',
  cardHtml.includes('dsh-composer-side-clearance') && cardHtml.includes('dsh-composer-card-max-width'), '')

console.log('· 发送时自动附上引用（回车）')
state.draft = '这句话为什么这么说？'
const editor = document.getElementById('editor')
const enterEvent = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
editor.dispatchEvent(enterEvent)
check('拦截了回车发送', enterEvent.defaultPrevented === true)
check('先写入合并后的草稿', state.setDraftCalls.length === 1 && state.setDraftCalls[0].startsWith('> 引用自第 3 轮 · 助手回答'), JSON.stringify(state.setDraftCalls[0]))
check('合并内容包含引用与问题',
  state.setDraftCalls[0].includes('有一段我想追问的解释') && state.setDraftCalls[0].includes('这句话为什么这么说？'))
flushFrames()
check('只调用了一次 submit', state.submitted === 1, String(state.submitted))
const emptyHtml = renderToStaticMarkup(React.createElement(state.dock.Component, { session: { sessionId: 's1' }, input: {} }))
check('发送后卡片被清空', emptyHtml === '', emptyHtml.slice(0, 120))

console.log('· 发送按钮路径 + 停止按钮不误伤')
// 再挂一张引用卡
document.getSelection = () => fakeSelection
fakeSelection.isCollapsed = false
document.dispatchEvent(new window.Event('mouseup'))
flushFrames()
const host2 = document.querySelector('[data-dsh-quote-ask]')
host2.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
flushFrames()
state.draft = '第二个问题'
const stopClick = new window.MouseEvent('click', { bubbles: true, cancelable: true })
document.getElementById('stop').dispatchEvent(stopClick)
check('停止按钮不被拦截', stopClick.defaultPrevented === false && state.submitted === 1)
const sendClick = new window.MouseEvent('click', { bubbles: true, cancelable: true })
document.getElementById('send').dispatchEvent(sendClick)
check('发送按钮被接管', sendClick.defaultPrevented === true)
flushFrames()
check('发送按钮路径也只 submit 一次', state.submitted === 2, String(state.submitted))

console.log('· dispose')
for (const dispose of state.disposals) dispose()
check('dispose 后浮层按钮被移除', document.querySelector('[data-dsh-quote-ask]') === null)

console.log('')
if (failures === 0) {
  console.log('全部通过 ✅')
} else {
  console.error(`${failures} 项失败 ❌`)
  process.exitCode = 1
}
