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

## License

[MIT](LICENSE)
