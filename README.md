# DLink (Obsidian Local File Linker)

Link, preview and manage files that live outside your vault — large videos, lossless audio, engineering assets, network drives — right inside Obsidian notes.

# Features

- **Dual-mode file browser** — switch between vault and external paths in one click, with search and type filters (all / image / video / audio / document).

- **Drag & drop linking** — drag files from your system file manager into the editor to generate a link instantly.

- **Three link formats** — `local-file://` (recommended, bypasses CSP), `file:///` (cross-tool compatible), or raw absolute path.

- **Inline preview & playback** — images, videos and audio render directly in reading view; hover a link for a card preview.

- **Gallery** — the `duallink-gallery` code block builds a waterfall gallery with adjustable columns, drag-to-reorder, double-click zoom and audio support.

- **DualIn / DualOut** — copy externally referenced files into the vault (`DualIn`), or move vault media out to an archive directory (`DualOut`). Referenced attachments are protected, name conflicts are resolved automatically, and broken links can be repaired.

## Installation

**Community plugins:** Settings → Community plugins → Browse → search **DLink** → Install → Enable.

**Manual:** download `main.js`, `styles.css` and `manifest.json` from [Releases](https://github.com/MarcBolo/DualLink/releases) into `.obsidian/plugins/dlink/`, then enable the plugin.

## Usage

1. Click the DLink ribbon icon to open the file browser. Use **Browse** to pick an external folder, filter files, then click one to insert it at the cursor.
2. Or drag files straight from your system file manager into a note.
3. Hold `Ctrl`/`Cmd` and click multiple media files, then **Insert N images (N columns)** to create a gallery.
4. Run `DualIn` / `DualOut` from the command palette, editor context menu or ribbon to move files in and out of the vault.

## Public API

```typescript
const api = this.app.plugins.getPlugin('dlink').api;
```

| Method                                      | Description                                              |
| ------------------------------------------- | -------------------------------------------------------- |
| `generateMarkdownLink(name, path)`          | Build a link using the current settings                  |
| `packToVault()`                             | Open the "pack to vault" modal                           |
| `packOut()`                                 | Open the "pack out" modal                                |
| `findExternalFileRec(name, dir, maxDepth?)` | Recursively find a file, returns its full path or `null` |

## Development

```bash
npm install
npm run dev     # watch mode
npm run build   # production build
```

## 中文说明

**DLink** 让本地磁盘文件（大体积视频、音频、工程资料等）与 Obsidian 笔记双向关联，并支持内联预览与播放。

**核心功能**

- **双轨文件浏览器**：内库 / 外部路径一键切换，支持搜索与类型筛选

- **拖拽成链**：从系统资源管理器拖入编辑器，自动生成链接

- **三种链接格式**：`local-file://`（推荐）/ `file:///` / 绝对路径

- **内联预览**：图片、视频、音频在阅读模式下直接渲染，链接悬浮显示卡片预览

- **分栏组图**：`duallink-gallery` 代码块生成瀑布流画廊，列数可调、支持拖拽排序与双击放大

- **DualIn / DualOut**：外部资源一键入库、库内媒体一键外置，含被引用保护、冲突重命名与链接修复

**安装**：设置 → 第三方插件 → 浏览 → 搜索 **DLink** 安装启用；或从 [Releases](https://github.com/MarcBolo/DualLink/releases) 下载三个文件放入 `.obsidian/plugins/dlink/`。

**使用**

1. 点击侧边栏 DLink 图标打开文件浏览器，通过 **Browse** 选择外部目录，筛选后点击文件即插入到光标处
2. 或直接从系统资源管理器把文件拖入笔记
3. 按住 `Ctrl`/`Cmd` 多选媒体文件，点击 **Insert N images (N columns)** 生成画廊
4. 通过命令面板、编辑器右键菜单或侧边栏图标执行 `DualIn` / `DualOut` 完成文件进出库

## License

MIT
