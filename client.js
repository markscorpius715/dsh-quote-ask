/**
 * dsh-quote-ask — browser half.
 *
 * ChatGPT 网页端「划选 → 向 ChatGPT 提问」在 DSH 里的等价实现（同一会话内）：
 *   1. 在会话记录里选中一段文字，选区旁浮出「向 DeepSeek 提问」按钮；
 *   2. 点击后**不切走、不新建会话**：选区变成输入框上方的一张引用卡片；
 *   3. 你在同一个输入框里输入问题，按发送时引用会自动附在消息里一起发出。
 *   卡片可以点「放入输入框」立刻变成可编辑文本，或点 × 取消。
 *
 * 与 ChatGPT 截图一致的要点：引用是输入框上方的独立卡片（不是塞进正文的文本），
 * 对话仍在被引用的这个会话里继续。
 *
 * 用到的 DSH 0.2.0-rc.2 客户端面（都核对过实现，不是猜的）：
 * - 选区锚点：`[data-conversation-scroll]`、`[data-chat-anchor-key]`、
 *   `data-chat-flow-kind`、`data-chat-turn`（dsh-client-ui-chat 渲染的聊天行标记）；
 * - 卡片位置：`conversation.input.dock` 插槽（会话级，渲染在输入框正上方）；
 * - 当前会话：`uiSession.current` 绑定的 key，回退到 `retainedBy.mainView > 0`；
 * - 读写输入框：`conversation.input.for(ctx.sessions.scope(id))` 的
 *   `state.getSnapshot().draft` / `setDraft()` / `focus()`（dsh-sidebar-qa 同款）；
 * - 发送时合并引用：`uiSession.current.props.inputActions`（`setDraft` + `submit`），
 *   发送手势是 `/发送|send|queue message|steer message/` 的主按钮与输入框里的回车。
 *
 * 手写 bundle 信封（`window.__ModuleLoader__.load`），无构建步骤；只 require
 * 平台种子表里的 `react`。
 *
 * @module dsh-quote-ask/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-quote-ask',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** 单次选中文本的上限，避免把整篇回答塞进消息。 */
    const MAX_SELECTION_CHARS = 8000
    /** 同一会话最多挂几张引用卡。 */
    const MAX_QUOTES = 5
    /** 等待编辑器把 setDraft 落到 published state 的帧数上限（≈1.5s）。 */
    const MAX_SETTLE_FRAMES = 90
    /** 聊天滚动容器；只认这个容器里的选区。 */
    const CHAT_ROOT = '[data-conversation-scroll]'
    /** 聊天行锚点属性（dsh-client-ui-chat 的 flowItem）。 */
    const ANCHOR = '[data-chat-anchor-key]'
    /** 输入框编辑器与 composer 卡片（dsh-client-ui-conversation 的 DOM 钩子）。 */
    const COMPOSER_INPUT = '[data-composer-input]'
    const COMPOSER_CARD = '[data-composer-card]'
    /** 发送按钮的 aria-label（中文/英文，含排队与插话两种发送）。 */
    const SEND_LABEL = /发送|send|queue message|steer message/i
    /** 停止按钮不能当成发送拦截。 */
    const STOP_LABEL = /停止|stop/i
    /** 聊天行 kind → 人话来源标签。 */
    const KIND_LABELS = {
      user: '你的消息',
      assistant: '助手回答',
      tool: '工具输出',
      'turn-process': '过程',
      steering: '插话',
      'turn-trigger': '触发',
    }

    /* ────────────────────────────── 纯函数 ────────────────────────────── */

    /**
     * 主界面当前展示的会话 id：`retainedBy.mainView > 0` 的那一行；
     * 切换期间可能多行同时命中，取 `updatedAt` 最新者。
     * @param {any} list sessions.list 快照
     * @returns {string | undefined}
     */
    function resolveCurrentSessionId(list) {
      if (list === undefined || list === null) return undefined
      const rows = list.byId ?? {}
      const order = list.ids ?? Object.keys(rows)
      const rank = new Map(order.map((id, index) => [id, index]))
      let best
      for (const [key, row] of Object.entries(rows)) {
        if (row === null || row === undefined) continue
        if ((row.retainedBy?.mainView ?? 0) <= 0) continue
        const id = row.id === undefined || row.id === '' ? key : row.id
        const updatedAt = row.updatedAt ?? Number.NEGATIVE_INFINITY
        const candidate = { id, updatedAt, rank: rank.get(id) ?? Number.POSITIVE_INFINITY }
        if (best === undefined
          || candidate.updatedAt > best.updatedAt
          || (candidate.updatedAt === best.updatedAt && candidate.rank < best.rank)) {
          best = candidate
        }
      }
      return best?.id
    }

    /** 节点所在的元素（文本节点取父元素）。 */
    function elementOf(node) {
      if (node === null || node === undefined) return null
      if (node.nodeType === 1) return node
      return node.parentElement ?? null
    }

    /** 选区是否落在输入框里（草稿区不弹按钮）。 */
    function inEditable(node) {
      const element = elementOf(node)
      if (element === null || typeof element.closest !== 'function') return false
      return element.closest("input, textarea, [contenteditable='true']") !== null
    }

    /** 从聊天行锚点读出「第 N 轮 · 助手回答」这类来源标签。 */
    function describeSource(node) {
      const element = elementOf(node)
      if (element === null || typeof element.closest !== 'function') return ''
      const anchor = element.closest(ANCHOR)
      if (anchor === null) return ''
      const kind = anchor.getAttribute('data-chat-flow-kind') ?? ''
      const turn = anchor.getAttribute('data-chat-turn') ?? ''
      const label = KIND_LABELS[kind] ?? ''
      if (turn !== '' && label !== '') return `第 ${turn} 轮 · ${label}`
      if (turn !== '') return `第 ${turn} 轮`
      return label
    }

    /** 文本提取时视为「块级」的标签：块与块之间补一个换行。 */
    const BLOCK_TAGS = new Set([
      'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'DD', 'DETAILS', 'DIALOG', 'DIV',
      'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
      'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
      'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
    ])
    /** 完全不参与文本提取的标签。 */
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'])
    /**
     * 隐藏的公式副本：KaTeX 同时输出可见的 `.katex-html` 和给读屏用的 `.katex-mathml`。
     * 后者参与选区但不可见，直接序列化会得到「每个符号一行」的伪影，必须跳过。
     */
    const HIDDEN_MATH_SELECTOR = '.katex-mathml, math'

    /**
     * 把一个 DOM 子树转成纯文本：文本节点原样拼；块级标签之间补 '\n'；
     * 跳过隐藏的公式副本。`Selection#toString()` 对这类内容会逐符号换行，
     * 所以引用文本按可见 DOM 自己取。
     */
    function textOfNode(node, out) {
      if (node === null || node === undefined) return
      if (node.nodeType === 3) {
        const value = node.nodeValue ?? ''
        // 块级标签之间的纯空白文本不产生内容（否则段落间会多出空行）。
        if (value.trim() === '') {
          const last = out[out.length - 1]
          if (out.length === 0 || (typeof last === 'string' && last.endsWith('\n'))) return
        }
        out.push(value)
        return
      }
      if (node.nodeType !== 1) return
      const element = node
      const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : ''
      if (SKIP_TAGS.has(tag)) return
      if (tag === 'MATH') return
      if (typeof element.matches === 'function' && element.matches(HIDDEN_MATH_SELECTOR)) return
      if (tag === 'BR') {
        out.push('\n')
        return
      }
      const block = BLOCK_TAGS.has(tag)
      const pushNewline = () => {
        const last = out[out.length - 1]
        if (typeof last !== 'string' || !last.endsWith('\n')) out.push('\n')
      }
      if (block) pushNewline()
      for (const child of element.childNodes) textOfNode(child, out)
      if (block) pushNewline()
    }

    /** 从 Range 克隆内容后提取可见文本；失败返回 ''。 */
    function extractRangeText(range) {
      let fragment
      try {
        fragment = range.cloneContents()
      } catch {
        return ''
      }
      if (fragment === null || fragment === undefined) return ''
      const out = []
      try {
        textOfNode(fragment, out)
      } catch {
        return ''
      }
      return normalizeSelectedText(out.join(''))
    }

    /**
     * 兜底清理「逐字符换行」的选区伪影：行数不少、且绝大多数行只有
     * 一两个字符时，说明不是真的换行，拼回一行。
     */
    function compactArtifactLines(text) {
      const meaningful = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
      if (meaningful.length < 5) return text
      const short = meaningful.filter((line) => line.length <= 3).length
      if (short / meaningful.length < 0.6) return text
      return meaningful.join('')
    }

    /** 统一换行、收紧空白、最多保留一个空行，再清理逐字符伪影。 */
    function normalizeSelectedText(raw) {
      const text = String(raw ?? '')
        .replace(/\r\n?/gu, '\n')
        .replace(/\u00a0/gu, ' ')
        .split('\n')
        .map((line) => line.replace(/[ \t]+/gu, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
      return compactArtifactLines(text)
    }

    /** 选中文字 → 带来源的 Markdown 引用块。 */
    function quoteMarkdown(text, source) {
      const head = source !== '' ? `> 引用自${source}\n` : ''
      const lines = text.split(/\r?\n/u).map((line) => (line.length > 0 ? `> ${line}` : '>'))
      return `${head}${lines.join('\n')}\n\n`
    }

    /** 卡片预览：原文前两行 / 200 字以内。 */
    function previewOf(text) {
      const clipped = text.length > 200 ? `${text.slice(0, 200)}…` : text
      const lines = clipped.split(/\r?\n/u)
      return lines.length > 2 ? `${lines.slice(0, 2).join('\n')}…` : clipped
    }

    /**
     * 读取并校验当前的窗口选区。
     * @returns {{ text: string, source: string, rect: DOMRect } | null}
     */
    function readSelection() {
      const selection = typeof document !== 'undefined' ? document.getSelection() : null
      if (selection === null || selection === undefined) return null
      if (selection.isCollapsed || selection.rangeCount === 0) return null
      let range
      try {
        range = selection.getRangeAt(0)
      } catch {
        return null
      }
      const root = document.querySelector(CHAT_ROOT)
      if (root === null || !root.contains(range.commonAncestorContainer)) return null
      if (inEditable(range.startContainer) || inEditable(range.endContainer)) return null
      let text = ''
      try {
        text = extractRangeText(range)
      } catch {
        text = ''
      }
      if (text === '') {
        // 极少数取不到 DOM 的部署退回原生序列化，再做一次伪影清理。
        try {
          text = normalizeSelectedText(selection.toString())
        } catch {
          text = ''
        }
      }
      if (text.length < 2 || text.length > MAX_SELECTION_CHARS) return null
      let rect
      try {
        rect = range.getBoundingClientRect()
      } catch {
        return null
      }
      if (rect === null || (rect.width === 0 && rect.height === 0)) return null
      return { text, source: describeSource(range.startContainer), rect }
    }

    /* ──────────────────────────── 引用卡片仓库 ──────────────────────────── */

    /** 会话 id → 待发送引用列表 + 订阅者（模块内单例，随插件激活创建）。 */
    function createQuoteStore() {
      const bySession = new Map()
      const listeners = new Map()
      const empty = Object.freeze([])
      let seq = 0

      function get(sessionId) {
        return bySession.get(sessionId) ?? empty
      }
      function notify(sessionId) {
        const set = listeners.get(sessionId)
        if (set === undefined) return
        for (const fn of [...set]) {
          try {
            fn()
          } catch (error) {
            console.warn('[dsh-quote-ask] quote subscriber failed:', error)
          }
        }
      }
      function add(sessionId, text, source) {
        seq += 1
        const list = [...get(sessionId), { id: seq, text, source }].slice(-MAX_QUOTES)
        bySession.set(sessionId, list)
        notify(sessionId)
      }
      function remove(sessionId, id) {
        const list = get(sessionId).filter((quote) => quote.id !== id)
        if (list.length === get(sessionId).length) return
        if (list.length === 0) bySession.delete(sessionId)
        else bySession.set(sessionId, list)
        notify(sessionId)
      }
      function clear(sessionId) {
        if (!bySession.delete(sessionId)) return
        notify(sessionId)
      }
      function subscribe(sessionId, fn) {
        const set = listeners.get(sessionId) ?? new Set()
        set.add(fn)
        listeners.set(sessionId, set)
        return () => {
          set.delete(fn)
          if (set.size === 0) listeners.delete(sessionId)
        }
      }
      return { get, add, remove, clear, subscribe }
    }

    /* ─────────────────────────── 插件闭包状态 ─────────────────────────── */

    /** 激活上下文（apply 时赋值）。 */
    let ctxRef = null
    /** 引用卡片仓库。 */
    let store = null
    /** 插件已卸载后不再触碰 DOM / 继续重试。 */
    let disposed = false

    /** 选区浮层按钮与状态。 */
    let buttonEl = null
    let pending = null
    let rafId = 0
    let toastEl = null
    let toastTimer = 0

    /* ──────────────────────────── 客户端服务读取 ──────────────────────────── */

    /** 主会话的 uiSession 绑定（{key, hooks, props}）；拿不到返回 undefined。 */
    function currentBinding() {
      try {
        const uiSession = ctxRef.get('uiSession')
        const current = uiSession?.current
        return typeof current?.getSnapshot === 'function' ? current.getSnapshot() : undefined
      } catch {
        return undefined
      }
    }

    /** 当前会话 id：优先用 uiSession 绑定的 key，回退到会话列表里的主会话。 */
    function currentSessionId() {
      const binding = currentBinding()
      if (binding !== undefined && typeof binding.key === 'string' && binding.key !== '') return binding.key
      try {
        return resolveCurrentSessionId(ctxRef.sessions?.list?.getSnapshot())
      } catch {
        return undefined
      }
    }

    /** 当前输入框的 published draft（读不到按空串算）。 */
    function draftOf(binding) {
      try {
        return binding?.hooks?.input?.getSnapshot?.()?.draft ?? ''
      } catch {
        return ''
      }
    }

    /** 某个会话的输入框 facade（官方 conversation.input.for 通道）。 */
    function composerFacade(sessionId) {
      try {
        const actx = ctxRef.sessions?.scope?.(sessionId)
        if (actx === undefined || actx === null) return undefined
        const conversation = ctxRef.get('conversation')
        if (conversation === undefined || conversation === null) return undefined
        return conversation.input.for(actx)
      } catch {
        return undefined
      }
    }

    /** 把焦点放回指定会话的输入框。 */
    function focusComposer(sessionId) {
      try {
        const facade = composerFacade(sessionId)
        if (facade !== undefined && typeof facade.focus === 'function') facade.focus()
      } catch {
        // 焦点失败不影响引用卡片。
      }
    }

    /* ────────────────────────────── 浮层按钮 ────────────────────────────── */

    function ensureButton() {
      if (buttonEl !== null || typeof document === 'undefined') return buttonEl
      const host = document.createElement('div')
      host.setAttribute('data-dsh-quote-ask', '')
      host.style.cssText = [
        'position:fixed',
        'z-index:1200',
        'display:none',
        'padding:3px',
        'border-radius:9px',
        'border:1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3))',
        'background:var(--dsw-alias-bg-layer-2, #232428)',
        'box-shadow:0 8px 24px rgba(0,0,0,.32)',
        'user-select:none',
      ].join(';')
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = '❝ 向 DeepSeek 提问'
      button.style.cssText = [
        'border:0',
        'background:transparent',
        'color:var(--dsw-alias-label-primary, #e8eaed)',
        'font:inherit',
        'font-size:12px',
        'padding:5px 9px',
        'border-radius:6px',
        'cursor:pointer',
        'white-space:nowrap',
      ].join(';')
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('mouseenter', () => {
        button.style.background = 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,.16))'
      })
      button.addEventListener('mouseleave', () => {
        button.style.background = 'transparent'
      })
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        askAboutSelection()
      })
      host.appendChild(button)
      document.body.appendChild(host)
      buttonEl = host
      return host
    }

    /** 在选区上方（放不下时下方）贴边展示按钮。 */
    function placeButton(rect) {
      const host = ensureButton()
      if (host === null) return
      host.style.display = 'inline-flex'
      const width = host.offsetWidth > 0 ? host.offsetWidth : 150
      const height = host.offsetHeight > 0 ? host.offsetHeight : 32
      const gap = 8
      let left = rect.left + rect.width / 2 - width / 2
      let top = rect.top - height - gap
      if (top < 8) top = rect.bottom + gap
      const maxLeft = Math.max(8, (window.innerWidth || 0) - width - 8)
      left = Math.min(Math.max(8, left), maxLeft)
      host.style.left = `${Math.round(left)}px`
      host.style.top = `${Math.round(top)}px`
    }

    function hideButton() {
      pending = null
      if (buttonEl !== null) buttonEl.style.display = 'none'
    }

    function recompute() {
      if (disposed) return
      const next = readSelection()
      if (next === null) {
        hideButton()
        return
      }
      pending = next
      placeButton(next.rect)
    }

    function scheduleRecompute() {
      if (disposed || rafId !== 0) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        try {
          recompute()
        } catch (error) {
          console.warn('[dsh-quote-ask] selection recompute failed:', error)
        }
      })
    }

    /** 底部居中的轻提示，2.6s 后自动消失。 */
    function toast(message) {
      if (typeof document === 'undefined' || disposed) return
      if (toastEl === null) {
        toastEl = document.createElement('div')
        toastEl.setAttribute('data-dsh-quote-ask-toast', '')
        toastEl.style.cssText = [
          'position:fixed',
          'left:50%',
          'bottom:96px',
          'transform:translateX(-50%)',
          'z-index:1300',
          'max-width:min(560px, calc(100vw - 32px))',
          'padding:7px 14px',
          'border-radius:8px',
          'border:1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3))',
          'background:var(--dsw-alias-bg-layer-2, #232428)',
          'color:var(--dsw-alias-label-primary, #e8eaed)',
          'font-size:12px',
          'line-height:18px',
          'box-shadow:0 8px 24px rgba(0,0,0,.32)',
          'pointer-events:none',
          'transition:opacity .15s',
        ].join(';')
        document.body.appendChild(toastEl)
      }
      toastEl.textContent = message
      toastEl.style.opacity = '1'
      if (toastTimer !== 0) window.clearTimeout(toastTimer)
      toastTimer = window.setTimeout(() => {
        toastTimer = 0
        if (toastEl !== null) toastEl.style.opacity = '0'
      }, 2600)
    }

    /* ────────────────────────────── 提问手势 ────────────────────────────── */

    /** 点击浮层按钮：把选区挂成当前会话的一张引用卡，焦点回输入框。 */
    function askAboutSelection() {
      const selection = pending
      if (selection === null || disposed) return
      hideButton()
      try {
        document.getSelection()?.removeAllRanges()
      } catch {
        // 清掉原生选区失败不影响后续流程。
      }
      const sessionId = currentSessionId()
      if (typeof sessionId !== 'string' || sessionId === '') {
        toast('没有找到当前会话，无法引用')
        return
      }
      store.add(sessionId, selection.text, selection.source)
      focusComposer(sessionId)
    }

    /**
     * 发送前把引用卡合并进消息：把引用块 setDraft 到当前草稿前面，等编辑器把新草稿
     * 发布出来后再调用官方 submit —— 这样按一次发送只会走一条消息。
     * @returns 是否接管了这次发送
     */
    function foldQuotesAndSubmit() {
      const binding = currentBinding()
      const sessionId = binding?.key
      const actions = binding?.props?.inputActions
      if (typeof sessionId !== 'string' || sessionId === '' || actions === undefined || actions === null) return false
      const pendingQuotes = store.get(sessionId)
      if (pendingQuotes.length === 0) return false
      const draft = draftOf(binding)
      if (draft.trim() === '') return false
      if (typeof actions.setDraft !== 'function' || typeof actions.submit !== 'function') return false
      const prefix = pendingQuotes.map((quote) => quoteMarkdown(quote.text, quote.source)).join('')
      try {
        actions.setDraft(prefix + draft)
      } catch (error) {
        console.warn('[dsh-quote-ask] setDraft failed:', error)
        return false
      }
      const settle = (frames) => {
        if (disposed) return
        const nowDraft = draftOf(binding)
        if (nowDraft.trimStart().startsWith('>')) {
          store.clear(sessionId)
          try {
            actions.submit()
          } catch (error) {
            console.warn('[dsh-quote-ask] submit failed:', error)
            toast('发送失败，请再按一次发送')
          }
          return
        }
        if (frames <= 0) {
          toast('引用没有合并进消息，请再按一次发送')
          return
        }
        requestAnimationFrame(() => settle(frames - 1))
      }
      requestAnimationFrame(() => settle(MAX_SETTLE_FRAMES))
      return true
    }

    /** 回车发送（不含 Shift+Enter 换行与输入法组合态）。 */
    function onKeyDownCapture(event) {
      if (disposed) return
      if (event.key !== 'Enter' || event.shiftKey === true || event.isComposing === true) return
      const target = event.target
      if (!(target !== null && typeof target === 'object' && target.nodeType === 1 && typeof target.closest === 'function')) return
      if (target.closest(COMPOSER_INPUT) === null) return
      if (foldQuotesAndSubmit()) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    /** 点击输入框卡片里的发送主按钮。 */
    function onClickCapture(event) {
      if (disposed) return
      const target = event.target
      if (!(target !== null && typeof target === 'object' && target.nodeType === 1 && typeof target.closest === 'function')) return
      const button = target.closest(`${COMPOSER_CARD} button`)
      if (button === null) return
      const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`
      if (!SEND_LABEL.test(label) || STOP_LABEL.test(label)) return
      if (foldQuotesAndSubmit()) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    /* ────────────────────────────── 引用卡片 UI ────────────────────────────── */

    /** 「放入输入框」：把卡片内容变成可编辑的引用文本并移除卡片。 */
    function insertIntoDraft(sessionId, quote) {
      const facade = composerFacade(sessionId)
      if (facade === undefined) {
        toast('输入框暂不可用，无法放入引用')
        return
      }
      try {
        const draft = facade.state.getSnapshot().draft ?? ''
        facade.setDraft(`${quoteMarkdown(quote.text, quote.source)}${draft}`)
        if (typeof facade.focus === 'function') facade.focus()
        store.remove(sessionId, quote.id)
      } catch (error) {
        console.warn('[dsh-quote-ask] insert into draft failed:', error)
        toast('放入输入框失败')
      }
    }

    /** 一张引用卡片（圆角深色卡 + ❝ + 预览 + 放入/移除）。 */
    function QuoteCard(props) {
      const { quote, sessionId } = props
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            maxWidth: 'var(--dsh-composer-card-max-width, 100%)',
            boxSizing: 'border-box',
            padding: '9px 11px',
            border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3))',
            borderRadius: 'var(--dsw-radius-panel, 12px)',
            background: 'var(--dsw-alias-bg-layer-2, #232428)',
            color: 'var(--dsw-alias-label-primary, #e8eaed)',
          },
        },
        h(
          'span',
          {
            'aria-hidden': true,
            style: {
              flex: '0 0 auto',
              width: 30,
              height: 30,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 8,
              background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,.16))',
              fontSize: 15,
            },
          },
          '❝',
        ),
        h(
          'div',
          { style: { minWidth: 0, flex: 1, display: 'grid', gap: 2 } },
          h(
            'div',
            {
              title: quote.text,
              style: {
                fontSize: 12.5,
                lineHeight: '18px',
                whiteSpace: 'pre-wrap',
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
              },
            },
            previewOf(quote.text),
          ),
          h(
            'div',
            { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #9aa0a6)' } },
            `${quote.source !== '' ? quote.source : '对话内容'} · ${quote.text.length} 字 · 发送时自动附上`,
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => insertIntoDraft(sessionId, quote),
            title: '把引用放进输入框，继续编辑',
            style: {
              flex: '0 0 auto',
              border: 0,
              background: 'transparent',
              color: 'var(--dsw-alias-label-link, #7aa2ff)',
              font: 'inherit',
              fontSize: 12,
              padding: '4px 6px',
              borderRadius: 6,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            },
          },
          '放入输入框',
        ),
        h(
          'button',
          {
            type: 'button',
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => store.remove(sessionId, quote.id),
            title: '移除引用',
            'aria-label': '移除引用',
            style: {
              flex: '0 0 auto',
              width: 22,
              height: 22,
              border: 0,
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--dsw-alias-label-tertiary, #9aa0a6)',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
            },
          },
          '×',
        ),
      )
    }

    /** 输入框上方的引用卡片区（注册进 conversation.input.dock）。 */
    function QuoteDock(props) {
      const sessionId = props?.session?.sessionId ?? props?.session?.id ?? ''
      const [quotes, setQuotes] = React.useState(() => store.get(sessionId))
      React.useEffect(() => {
        if (sessionId === '') return undefined
        setQuotes(store.get(sessionId))
        return store.subscribe(sessionId, () => setQuotes(store.get(sessionId)))
      }, [sessionId])
      if (sessionId === '' || quotes.length === 0) return null
      // 与 composer 卡片对齐：同样的左右 side-clearance 内边距 + 同样的
      // --dsh-composer-card-max-width 上限（这两个变量由 ConversationRoot 的
      // body/composerStack 作用域提供），卡片因此和输入框同宽同起点。
      return h(
        'div',
        {
          'data-dsh-quote-ask-dock': '',
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            maxWidth: '100%',
            boxSizing: 'border-box',
            paddingLeft: 'var(--dsh-composer-side-clearance, 16px)',
            paddingRight: 'var(--dsh-composer-side-clearance, 16px)',
          },
        },
        quotes.map((quote) => h(QuoteCard, { key: quote.id, quote, sessionId })),
      )
    }

    /* ─────────────────────────────── 激活 ─────────────────────────────── */

    /** 注入的服务：会话数据与槽位注册；uiSession / conversation 用 ctx.get 探测。 */
    const inject = ['sessions', 'slots']

    function apply(ctx) {
      ctxRef = ctx
      store = createQuoteStore()
      console.info('[dsh-quote-ask] applied')

      const onMouseDown = (event) => {
        if (buttonEl !== null && event.target instanceof Node && buttonEl.contains(event.target)) return
        hideButton()
      }
      const onScroll = () => scheduleRecompute()

      // 选区浮层 + 发送手势拦截，随 fiber 生命周期清理。
      ctx.effect(() => {
        document.addEventListener('selectionchange', scheduleRecompute)
        document.addEventListener('mouseup', scheduleRecompute, true)
        document.addEventListener('keyup', scheduleRecompute, true)
        document.addEventListener('mousedown', onMouseDown, true)
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', scheduleRecompute)
        document.addEventListener('keydown', onKeyDownCapture, true)
        document.addEventListener('click', onClickCapture, true)
        return () => {
          disposed = true
          document.removeEventListener('selectionchange', scheduleRecompute)
          document.removeEventListener('mouseup', scheduleRecompute, true)
          document.removeEventListener('keyup', scheduleRecompute, true)
          document.removeEventListener('mousedown', onMouseDown, true)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', scheduleRecompute)
          document.removeEventListener('keydown', onKeyDownCapture, true)
          document.removeEventListener('click', onClickCapture, true)
          if (rafId !== 0) {
            cancelAnimationFrame(rafId)
            rafId = 0
          }
          if (toastTimer !== 0) {
            window.clearTimeout(toastTimer)
            toastTimer = 0
          }
          if (buttonEl !== null) {
            buttonEl.remove()
            buttonEl = null
          }
          if (toastEl !== null) {
            toastEl.remove()
            toastEl = null
          }
        }
      }, 'dsh-quote-ask: selection toolbar and send interception')

      // 输入框上方的引用卡片区。
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'quote-ask',
        order: 150,
      }, QuoteDock))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-quote-ask'
    return module.exports
  },
})
