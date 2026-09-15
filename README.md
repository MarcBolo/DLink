# DLink (Obsidian Local File Linker)

**DLink** is an efficient Obsidian plugin for linking, managing, and live previewing local and external physical files.

Due to Obsidian's vault mechanism limitations, handling large resource files (such as videos of tens of GB, lossless audio collections, or engineering source files) or system-level network drive mappings often requires keeping them outside the `.obsidian` vault. This plugin perfectly solves the pain point of "needing external path large file associations while also requiring smooth built-in preview", helping you seamlessly integrate **external absolute path files** and **internal vault files** within the same panel.

---

## 🌟 Core Features

- **📂 Dual Link Mode**
  The left sidebar includes an interactive file browser that supports one-click switching between **📦 Internal Vault Mode** and **🌐 External Path Mode**. You can use it to quickly browse massive images and videos on external disks.
- **🖱️ Drag & Drop Mapping**
  Directly drag external files into the Obsidian editor to instantly convert them into safe and smooth `local-file://` association links, eliminating tedious manual path typing.
- **👁️ Hover & Inline Preview**
  In reading or editing mode, simply hover over the generated link to reveal a elegant card-style preview (supports common image formats). If inline mode is enabled, external images will be rendered directly in the document flow.
- **🎵 Multimedia Instant Decoding**
  No longer limited to images! For formats like `.mp4`, `.webm`, `.mp3`, etc., supports inline rendering or native application activation, without consuming any vault storage space.
- **⚙️ Multi-Protocol Adaptation**
  Provides 3 ready-to-use link injection protocol formats for advanced user scenarios:
  1. `custom-protocol://` (Recommended: safe sandbox isolation)
  2. `file:///` (Standard cross-tool compatible protocol)
  3. `Absolute Path` (Raw direct address)
- **✨ Smart Link Detection**
  When selecting files from the browser to inject into documents, it automatically determines: for external resources, generates corresponding external link format `![]()`; for "Internal Vault Mode", automatically derives standard internal link format `[[ ]]` and media resources auto-add prefix `![[ ]]`.

---

## 🚀 Installation

### From Obsidian Community Plugin Marketplace

DLink is now available on the official Obsidian Community Plugin Marketplace!

1. Open Obsidian **Settings → Community Plugins**
2. Turn off **Safe Mode** if enabled
3. Click **Browse** and search for **"DLink"**
4. Click **Install**, then **Enable**

### Manual Installation

1. Download the latest release from [GitHub Releases](https://github.com/MarcBolo/DualLink/releases)
2. Extract `main.js`, `styles.css`, and `manifest.json` into your vault's `.obsidian/plugins/dlink/` directory
3. Enable the plugin in **Settings → Community Plugins**

---

## 📖 Usage Guide

### 1. Left External File Browser
After enabling the plugin, you'll find a new icon in the left ribbon. Click to expand the interactive panel:
- **Switch Path Mode**: Click the 📦/🌐 button combination to toggle between internal vault and last opened external root path.
- **Browse Folder**: Click "Browse" to invoke native file manager to specify external disk location.
- **Quick Filter/Tags**: Panel includes real-time text filter and media format filter (All/Images/Video/Audio).
- **Click to Inject**: Position cursor in editor, click any file in the list to inject the reference.

### 2. Markdown Drag & Drop
Open any system file manager, select files, drag directly to Markdown text position to generate links or image tags.

### 3. Three Generation Format Settings
Open plugin settings to change "Default Link Format":
- **`custom-protocol:// (Recommended)`** 
  Uses Obsidian's exposed safe protocol routing (starting with `local-file://`). Benefits: **ignores cross-origin and strict security policy restrictions**, can load external disk content without errors.
- **`file:/// Standard Protocol`**
  Generated format starts with traditional browser file:// protocol. Better compatibility when using other third-party Markdown editors. May be blocked in strict security configurations.
- **`Absolute Path`**
  No protocol tags, raw `C:\Users\...` format. Recommended for physical archive management directory registration.

### 4. Gallery & Path Auto-Correction
- **Quick Gallery Insert**: Browse images/videos in the file browser panel:
  - **Single Insert**: Click a media file to insert with 1-column format.
  - **Multi-Select Columns**: Hold `Ctrl` or `Cmd` and click multiple files, "Insert N images (N columns)" button appears (auto-calculates ideal layout, supports up to 5 columns). Click to generate elegant ````duallink-gallery```` code block.
- **Path Auto-Correction**: For gallery content rendered in this format:
  - If internal links become dead due to folder restructuring, plugin will use internal API to search vault-wide and fix link references.
  - If external image original path is affected by relocation or disk letter changes, as long as it's still within the configured "Default External Resource Root Directory", plugin will perform background deep traversal search and silently fix the Markdown source path after finding the target!

---

## 🔌 Public API

DLink exposes a public API for other plugins to programmatically generate links, pack files, and search external directories.

### Accessing the API

```typescript
const dualLinkPlugin = this.app.plugins.getPlugin('dlink');
if (dualLinkPlugin) {
  const api = dualLinkPlugin.api;
  // use api methods...
}
```

### API Reference

#### `api.generateMarkdownLink(fileName: string, filePath: string): string`

Generates a formatted Markdown link based on the plugin's current settings (link style, file type detection, etc.).

```typescript
const link = api.generateMarkdownLink('photo.jpg', 'D:/Photos/photo.jpg');
// Returns something like: "![photo.jpg](local-file://D%3A/Photos/photo.jpg)"
```

#### `api.packToVault(): Promise<void>`

Opens the "Pack to Vault" modal, allowing users to copy or move external files into the Obsidian vault.

```typescript
await api.packToVault();
```

#### `api.packOut(): Promise<void>`

Opens the "Pack Out" modal, allowing users to export vault files to an external directory.

```typescript
await api.packOut();
```

#### `api.findExternalFileRec(fileName: string, dir: string, maxDepth?: number, currentDepth?: number): Promise<string | null>`

Recursively searches for a file by name within an external directory. Returns the full path if found, or `null` if not found.

```typescript
const found = await api.findExternalFileRec('project-final.mp4', 'D:/Projects');
if (found) {
  // found = "D:/Projects/2025/exports/project-final.mp4"
}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `fileName` | `string` | (required) | The file name to search for |
| `dir` | `string` | (required) | Starting directory for recursive search |
| `maxDepth` | `number` | `4` | Maximum directory depth to traverse |
| `currentDepth` | `number` | `0` | Internal recursion tracker (usually omitted) |

---

## 🛠 Development & Build Commands

```bash
# Install dependencies
npm install

# Frontend watch mode for instant debugging
npm run dev

# Build production targets
npm run build
```

---

## 中文说明

**DLink** 是一款专为 Obsidian 打造的高效本地及外部物理文件关联、管理与实时预览插件。

已上架 Obsidian 社区插件市场，可直接在 **设置 → 第三方插件 → 浏览** 中搜索 **"DLink"** 安装。

### 核心特性
- **📂 双轨模式驱动** - 左侧边栏内置交互式文件浏览器，支持内部库与外部路径一键切换
- **🖱️ 极速拖入映射** - 外部文件拖拽进入编辑器自动转为 `local-file://` 关联
- **👁️ 实时悬浮与内嵌预览** - 鼠标悬浮卡片式预览，支持图片内嵌渲染
- **🎵 多媒体即时解码** - `.mp4` / `.webm` / `.mp3` 等格式内联渲染
- **⚙️ 多形式协议适配** - 3 种链接格式：custom-protocol、file:///、绝对路径
- **✨ 智能区分链接** - 自动判断内外资源生成对应格式

### 公共 API

其他插件可通过 `this.app.plugins.getPlugin('dlink')` 获取 DLink 实例，调用 `.api` 上的方法：

| 方法 | 说明 |
|------|------|
| `generateMarkdownLink(name, path)` | 根据当前设置生成格式化链接 |
| `packToVault()` | 打开"导入到保险库"对话框 |
| `packOut()` | 打开"导出到外部"对话框 |
| `findExternalFileRec(name, dir, depth?)` | 递归查找外部文件并返回完整路径 |

---

## 📝 License

MIT License
