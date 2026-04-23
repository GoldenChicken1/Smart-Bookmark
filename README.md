# Smart Bookmark

> Auto-rename and auto-categorize bookmarks using LLMs when you save them in Chrome.

[English](./README.md) | [简体中文](./README.zh.md)

---

## The problem

Every time you add a bookmark in Chrome, you see this popup:

- The name is the raw page title (often cluttered with `| Site Name` or marketing suffixes)
- The folder defaults to "Other Bookmarks" or the last-used one
- You manually clean up the name, pick a folder, click Done

**Smart Bookmark** does this for you. You click the star, close the popup, and the bookmark is already named well and filed into the right folder.

## How it works

1. You add a bookmark (star icon, `Ctrl/Cmd+D`, right-click menu — anything that creates a bookmark).
2. The extension captures the page's title, description, `og:*` meta, `<h1>`, and the first 500 chars of body text.
3. It sends this along with your existing bookmark folder structure to an OpenAI-compatible LLM API.
4. The LLM returns a clean name and the best folder path.
5. The extension renames the bookmark, creates the folder path if needed, and moves it in.

All of this happens in the background in ~1-2 seconds.

## Features

- **Works with any OpenAI-compatible LLM**: Moonshot (Kimi), DeepSeek, OpenAI, or your own endpoint.
- **Respects manual edits**: If you change the name or folder in Chrome's native popup, the extension leaves it alone.
- **Auto-creates folders**: The LLM can propose a new category and the extension creates the folder path on demand.
- **Local-only storage**: Your API key and history stay on your machine (`chrome.storage.local`).
- **Editable system prompt**: Tweak the LLM's behavior from the options page.
- **Process history**: See the last 50 decisions from the toolbar popup.
- **One-click disable**: Toggle the extension on/off without uninstalling.

## Install

Until this is published on the Chrome Web Store, install as an unpacked extension:

1. Clone this repo or download the ZIP.
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the extension folder.
5. The options page opens automatically on first install — fill in your API key and model.

## Configuration

Open the options page by right-clicking the extension icon → **Options** (or clicking the **Settings** link in the toolbar popup).

| Field | Description |
| --- | --- |
| **API Key** | Your LLM provider's key. Stored in `chrome.storage.local` only. |
| **Model** | e.g. `moonshot-v1-8k`, `kimi-k2-0905-preview`, `deepseek-chat`, `gpt-4o-mini` |
| **API Base URL** | Any OpenAI-compatible endpoint. Defaults to `https://api.moonshot.cn/v1`. |
| **Enable auto-processing** | Master switch. |
| **Respect manual edits** | If you edit the name/folder in the native popup within the detection window, the extension skips. |
| **Allow create folder** | Whether the LLM can create new folders. |
| **Manual edit detection window** | How long to wait (ms) after bookmark creation before calling the LLM. Default `1500`. |
| **System prompt** | Editable instructions for the LLM. |

### Where to get an API key

- **Moonshot / Kimi** (default): <https://platform.moonshot.cn/console/api-keys>
- **DeepSeek**: <https://platform.deepseek.com/api_keys> — set base URL to `https://api.deepseek.com/v1`
- **OpenAI**: <https://platform.openai.com/api-keys> — set base URL to `https://api.openai.com/v1`

Any other OpenAI-compatible provider works as long as it supports `chat/completions` with `response_format: json_object`.

## Privacy

- Your API key is stored only in `chrome.storage.local` and is sent only to the base URL you configure.
- On every bookmark creation the extension sends to your configured LLM provider: URL, page title, meta description, `og:*`, `<h1>`, and the first ~500 characters of body text, plus your existing bookmark folder names (titles only, no URLs).
- The last 50 processed bookmarks are stored locally for the history view.
- Nothing is sent to the extension authors or any third party.

## Known limitations

- **Chrome's native "Bookmark added" popup shows stale values.** It reads the bookmark once when it opens and does not refresh. After you close the popup, the bookmark is correctly renamed and filed — verify in `chrome://bookmarks`. This is a Chrome limitation; extensions cannot update that popup.
- **Processing latency**: ~1-2 seconds per bookmark (LLM round-trip).
- **Restricted pages**: On `chrome://`, the Chrome Web Store, PDFs, and pages that block content scripts, the extension falls back to URL-only classification, which is less accurate.
- **Folder placement is soft**: If the LLM returns a path starting with an unknown top-level folder, the extension places it under "Other Bookmarks" to be safe.

## Development

The extension is plain MV3 JavaScript — no build step.

```
├── manifest.json
├── background.js   # service worker: bookmark events, LLM call, folder logic
├── options.html    # settings page
├── options.js
├── popup.html      # toolbar popup (history + toggle)
└── popup.js
```

To debug: `chrome://extensions/` → find the extension → click **Service Worker** → Console tab. The extension logs every step prefixed with `[智能书签]`.

## License

[MIT](./LICENSE)
