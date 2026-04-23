# 智能书签 Smart Bookmark

> 在 Chrome 添加书签时用 LLM 自动重命名并归入合适的文件夹。

[English](./README.md) | [简体中文](./README.zh.md)

---

## 解决什么问题

每次在 Chrome 添加书签都会弹这个框：

- 名称是原始网页标题（常带着 `| 站点名` 或推广文案）
- 文件夹默认是"其他书签"或上次用的那个
- 你手动精简名字、挑文件夹、点完成

**智能书签**替你做完这些。点星标 → 关弹窗 → 书签已经改好名字并放入合适的文件夹。

## 工作原理

1. 你添加书签（点星标、`Ctrl/Cmd+D`、右键菜单均可）。
2. 扩展抓取网页的 `title`、`description`、`og:*` meta、`<h1>` 和前 500 字正文片段。
3. 连同你现有的书签文件夹结构一起发给一个 OpenAI 兼容的 LLM API。
4. LLM 返回简洁的名字和最合适的文件夹路径。
5. 扩展重命名书签，必要时创建文件夹路径，并把书签移进去。

整个过程在后台完成，约 1-2 秒。

## 功能特性

- **兼容任何 OpenAI 兼容 LLM**：Kimi (Moonshot)、DeepSeek、OpenAI，或自建接口
- **尊重手动修改**：你在 Chrome 原生弹窗里改过名字或文件夹，扩展就不覆盖
- **自动新建文件夹**：LLM 提议的新分类会被自动创建
- **纯本地存储**：API Key 和历史记录只保存在 `chrome.storage.local`
- **可自定义提示词**：在设置页里调 LLM 行为
- **处理历史**：工具栏弹窗可查看最近 50 条决策
- **一键开关**：无需卸载即可临时禁用

## 安装

在上架 Chrome 商店之前，按开发者模式加载：

1. 克隆本仓库或下载 ZIP 解压
2. 打开 `chrome://extensions/`
3. 打开右上角的 **开发者模式**
4. 点 **加载已解压的扩展程序**，选中项目文件夹
5. 首次安装会自动打开设置页，填写你的 API Key 和模型即可

## 配置

右键扩展图标 → **选项**；或点击工具栏弹窗里的 **设置** 链接。

| 字段 | 说明 |
| --- | --- |
| **API Key** | 你的 LLM 服务 Key，仅存在 `chrome.storage.local` |
| **模型** | 如 `moonshot-v1-8k`、`kimi-k2-0905-preview`、`deepseek-chat`、`gpt-4o-mini` |
| **API Base URL** | 任何 OpenAI 兼容接口。默认 `https://api.moonshot.cn/v1` |
| **启用自动处理** | 总开关 |
| **尊重用户手动修改** | 在检测窗口内你手动改了名称/文件夹，扩展将跳过 |
| **允许自动新建文件夹** | 是否允许 LLM 建议的新文件夹被创建 |
| **手动修改检测窗口** | 添加书签后等多少毫秒再调 LLM，默认 `1500` |
| **系统提示词** | 可编辑的 LLM 指令 |

### 获取 API Key

- **Kimi / Moonshot**（默认）：<https://platform.moonshot.cn/console/api-keys>
- **DeepSeek**：<https://platform.deepseek.com/api_keys> — Base URL 改为 `https://api.deepseek.com/v1`
- **OpenAI**：<https://platform.openai.com/api-keys> — Base URL 改为 `https://api.openai.com/v1`

只要服务支持 `chat/completions` + `response_format: json_object`，就可以接入。

## 隐私

- API Key 仅存在 `chrome.storage.local`，只会发到你配置的 Base URL
- 每次添加书签时，扩展会发给你配置的 LLM：URL、标题、description、`og:*`、`<h1>`、前 ~500 字正文、以及现有书签文件夹名称（只有标题，没有书签 URL）
- 最近 50 条处理记录保存在本地供查阅
- 除了你配置的 LLM 之外，不向任何第三方发送数据

## 已知限制

- **Chrome 原生"已添加书签"弹窗不会实时刷新**。它只在打开时读一次书签值，扩展在后台改完后那个弹窗依旧显示旧值。关掉弹窗后书签已经是正确的——可在 `chrome://bookmarks` 验证。这是 Chrome 的限制，扩展 API 无法更新该弹窗。
- **处理延迟**：每条书签 ~1-2 秒（LLM 往返）
- **受限页面**：`chrome://`、Chrome 商店、PDF、以及阻止 content script 的页面，扩展会降级为仅用 URL 分类，准确度较低
- **文件夹落位保守**：如果 LLM 返回的路径以一个不存在的一级文件夹开头，扩展会放到"其他书签"下以免出错

## 开发

纯 MV3 JavaScript，无构建步骤。

```
├── manifest.json
├── background.js   # service worker：书签事件、LLM 调用、文件夹逻辑
├── options.html    # 设置页
├── options.js
├── popup.html      # 工具栏弹窗（历史 + 开关）
└── popup.js
```

调试：`chrome://extensions/` → 找到扩展 → 点 **服务工作进程** → Console 标签。每一步都有 `[智能书签]` 前缀日志。

## 开源协议

[MIT](./LICENSE)
