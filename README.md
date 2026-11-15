# dsh-quote-ask

[![test](https://github.com/markscorpius715/dsh-quote-ask/actions/workflows/test.yml/badge.svg)](https://github.com/markscorpius715/dsh-quote-ask/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.2%20%3C0.3.0-4d6bfe)](package.json)

**ChatGPT 网页端「划选 → 向 ChatGPT 提问」的 DeepSeek Harness 等价插件。**
选中一段回答，点「向 DeepSeek 提问」，引用变成输入框上方的一张卡片，**在同一个会话里**继续追问——引用会在发送时自动附在消息最前面。

> *Select text in a DSH conversation, click 「向 DeepSeek 提问」, and a quote card appears above the composer. Keep chatting in the same conversation — the quote is attached to your next message automatically.*

## 效果

1. 在会话记录里**选中一段文字** → 选区旁浮出 **「❝ 向 DeepSeek 提问」**；
2. 点击后**留在当前会话**（不新建对话、不切走）：选区变成输入框上方的一张**引用卡片**（原文预览 + 来源轮次）；
3. 你直接在输入框里输入问题，按回车 / 点发送时，引用块会**自动附在消息最前面**一起发出（只发一条消息，卡片随之消失）；
4. 卡片右侧：**「放入输入框」**把引用变成可编辑的 `> 引用自…` 文本；**×** 取消引用。

| 动作 | 结果 |
|---|---|
| 划选 + 点按钮 | 挂一张引用卡，焦点回到输入框，草稿里不会塞入任何文字 |
| 输入问题 → 回车 / 点发送 | 引用块 + 你的问题合并成一条消息发出 |
| 点「放入输入框」 | 引用以 Markdown 引用形式写进草稿，可继续编辑 |
| 点 × | 移除这张引用 |
| 切到别的会话 | 卡片按会话隔离，不会串台 |
| 停止按钮 | 不会被发送拦截误伤 |

## 安装

**从 GitHub 安装（推荐）**

```bash
dsh plugin --profile web add github:markscorpius715/dsh-quote-ask
```

**从 Release 的 tgz 安装**

```bash
dsh plugin --profile web add https://github.com/markscorpius715/dsh-quote-ask/releases/download/v0.1.0/dsh-quote-ask-0.1.0.tgz
```

**本地开发目录安装**

```bash
dsh plugin --profile web add D:\tools\dsh-quote-ask
```

装完刷新页面（DSH 会热加载 client 插件；不生效时 `Ctrl+Shift+R` 强刷）。宿主侧有改动时重启 `dsh web`。

卸载：

```bash
dsh plugin --profile web remove dsh-quote-ask
```

## 为什么单独写一个，而不用现成插件

DSH 插件市场里「划词提问」类插件很多，但在 **DSH 0.2.0-rc.2** 上没有同时满足「同一会话 + 输入框上方的引用卡 + 发送时自动附上」的现成实现：

- `dsh-selection-ask` 等是「悬浮按钮 → 引用写进当前输入框」，没有卡片态；
- `dsh-sidebar-qa`、`dsh-side-chat-plus` 是右侧栏侧聊形态，不在当前会话；
- 带引用卡片的 `@kialajin/dsh-quote-selection` 依赖 `uiWorkspace.startSession(workspaceId, { prompt })` 这套 **0.2.1-rc.5+** 才有的草稿参数 API，在 0.2.0-rc.2 上会静默失效；它的发送合并走 `props.inputActions`，而本版本 dock 插槽并不传这个 prop；
- 更热的 `dsh-select-quote` / `dsh-ask-selection` 要求 DSH ≥ 0.2.1 / 0.2.2。

所以这里用 0.2.0-rc.2 上**核对过实现**的客户端面自己实现（见下节）。

## 实现依据

| 环节 | 用到的 API / DOM | 依据 |
|---|---|---|
| 选区锚点 | `[data-conversation-scroll]`、`[data-chat-anchor-key]`、`data-chat-flow-kind`、`data-chat-turn` | `dsh-client-ui-chat` 渲染的聊天行标记 |
| 卡片位置 | `conversation.input.dock` 插槽（session 作用域，渲染在输入框正上方） | `dsh-client-ui-conversation` 的 `ConversationRoot` |
| 卡片与输入框对齐 | `--dsh-composer-side-clearance` + `--dsh-composer-card-max-width` | 与 composer 卡片同一套布局变量 |
| 当前会话 | `uiSession.current` 绑定的 `key`；回退 `retainedBy.mainView > 0` | `dsh-client-ui-session` / `ui-workspace` 的主会话判定 |
| 读写草稿 / 聚焦 | `conversation.input.for(ctx.sessions.scope(id))` 的 `state.getSnapshot().draft` / `setDraft()` / `focus()` | `dsh-sidebar-qa` 的「添加到对话」同款 |
| 发送时合并 + 提交 | `uiSession.current.props.inputActions` 的 `setDraft()` + `submit()`；发送手势拦 `[data-composer-card]` 主按钮与 `[data-composer-input]` 回车 | `dsh-client-ui-conversation` 的 `SessionInputShell.actions` |

插件结构：`index.js` 是空的 host 半（让 Loader 扫到这个包），`client.js` 是手写 client bundle（`window.__ModuleLoader__.load` 信封，零构建）。

## 已知边界

- 只认聊天流（`[data-conversation-scroll]`）里的选区；右侧栏文件预览里的选中暂不支持；
- 发送合并依赖 `inputActions` 面：若某个未来宿主版本去掉该面，会退化为不合并（卡片仍在，可点「放入输入框」手动放入）；
- 引用带上限 8000 字符；同一会话最多挂 5 张卡片；
- 消息里引用以 Markdown 引用块（`>`）发出，不是 ChatGPT 那种原生「引用 chip」——DSH 0.2.0-rc.2 没有对外的输入框引用 chip API；
- 回车拦截只针对有内容草稿（空输入不接管）。

## 开发与自测

```bash
npm install
npm test   # jsdom + React SSR 冒烟：选区浮层 → 卡片渲染/对齐 → 回车与按钮发送合并 → dispose 清理
```

测试不需要浏览器、不需要重启 DSH。改 `client.js` 后重装插件并刷新页面即可（HMR 生效时刷新就够）。

## License

[MIT](LICENSE)
