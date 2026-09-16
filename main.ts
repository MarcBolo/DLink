/**
 * Obsidian Local File Linker & Live Preview Plugin
 * Built for Obsidian (runs on Electron)
 */

import { 
  Plugin, 
  MarkdownView, 
  Notice,
  Modal,
  Menu,
  setIcon,
  Editor,
  TFile
} from 'obsidian';
import { isDesktop } from './platform';
import { isImageExt, isVideoExt, isAudioExt, isMediaExt } from './constants';
import { getCleanLocalPath, getCleanAppLocalPath, safeDecodeURIComponent, vaultRelativeFromAbsolute, encodeFileUriPath } from './path-utils';
import { blobUrlForFilePath, trackBlobNode, PREVIEW_VIDEO_BYTE_LIMIT } from './media-blob';
import { electron, fs, path, type NodeDirent } from './node-modules';
import {
  findExternalFileRec,
  relocateMissingFile,
  encodeExternalPathText,
  packToVault as doPackToVault,
  packOut as doPackOut,
} from './packer';
import { registerGalleryProcessor } from './gallery-processor';
import { LocalFileLinkerSettingTab } from './setting-tab';
import { MobileFilePickerModal } from './mobile-file-picker';
import { createPublicAPI, DualLinkPublicAPI } from './api';

import { LocalFileLinkerSettings, FileItem, VaultAdapter, VaultConfigExt, FileWithPath } from './types';


const DEFAULT_SETTINGS: LocalFileLinkerSettings = {
  inlineRenderEnabled: true,
  customPreviewFolders: '',
  defaultFolderPath: '',
  internalFolderPath: '',
  externalMediaFolder: '',
  packOutMode: 'move',
  showMobileToolbarButton: true
};

/**
 * 识别 Markdown 链接/图片目标中遗留的「明文绝对路径」(旧 absolute-path 格式，如 E:/a b.pdf)。
 * 匹配两种书写：<E:/a b.pdf> 与 E:/a b.pdf。
 */
const PLAIN_LINK_PATTERNS: RegExp[] = [
  /(!?\[[^\]]*\])\(<\s*([A-Za-z]:[^>]*?)\s*>\)/g,
  /(!?\[[^\]]*\])\(([A-Za-z]:[^)\r\n()]*?)\)/g,
];

/**
 * 将 content 中的明文绝对路径链接改写为标准 file:/// 编码链接。
 * 已编码(含 %xx)或非盘符根路径跳过，避免二次编码/误伤。
 */
function rewritePlainLinksToFileUri(content: string): { out: string; count: number } {
  let count = 0;
  const toFileUri = (rawPath: string): string | null => {
    const clean = rawPath.replace(/[<>"']/g, '').trim().replace(/\\/g, '/');
    if (!/^[A-Za-z]:\//.test(clean)) return null;
    if (/%[0-9A-Fa-f]{2}/.test(clean)) return null;
    return `file:///${encodeExternalPathText(clean)}`;
  };

  let out = content;
  for (const re of PLAIN_LINK_PATTERNS) {
    out = out.replace(re, (whole: string, prefix: string, rawPath: string) => {
      const uri = toFileUri(rawPath);
      if (uri === null) return whole;
      count++;
      return `${prefix}(<${uri}>)`;
    });
  }
  return { out, count };
}

export default class LocalFileLinkerPlugin extends Plugin {
  settings: LocalFileLinkerSettings;
  api: DualLinkPublicAPI;
  /** 同一笔记源码的“失效链接改写”串行队列，避免并发 vault.process 相互覆盖 */
  private relocateQueue = new Map<string, Promise<void>>();

  async onload() {
    await this.loadSettings();

    // 初始化公共 API（供其他插件调用）
    this.api = createPublicAPI(this);

    // 桌面环境才启用的功能
    if (isDesktop() && fs && path && electron) {
      // 注册自定义 local-file:// 安全协议解析与快捷点击动作
      this.registerObsidianProtocol();

      // 1. 注册编辑器拖拽 (Drag & Drop) 拦截监听，拖入任何系统外围文件即刻自动生成映射外链
      this.registerEvent(
        this.app.workspace.on('editor-drop', (evt: DragEvent, editor: Editor) => {
          if (evt.defaultPrevented) return;
          
          const files = evt.dataTransfer?.files;
          if (!files || files.length === 0) return;

          // Electron 特性：拖拽获得的 File 对象自带原始物理磁盘绝对路径（file.path)
          const fileList = Array.from(files);
          let insertedAny = false;

          fileList.forEach(file => {
            const systemPath = (file as FileWithPath).path;
            if (!systemPath) return;

            evt.preventDefault();
            insertedAny = true;

            // 依据设置转化成相对应的 Markdown 连接样式
            const markdownLink = this.generateMarkdownLink(file.name, systemPath);
            
            // 在光标所在处或托落节点植入文本
            const cursor = editor.getCursor();
            editor.replaceRange(markdownLink + '\n', cursor);
          });

          if (insertedAny) {
            new Notice('🔗 成功通过外部映射方式创建了本地文件的物理双链！');
          }
        })
      );

      // 4. 注册全局命令列表便于键盘流操作
      this.addCommand({
        id: 'insert-local-file-link',
        name: '插入本地物理文件绝对路径链接',
        editorCallback: (editor) => {
          void this.promptForLocalFileLink(editor);
        }
      });

      this.addCommand({
        id: 'duallink-pack-to-vault',
        name: 'DualIn: 打包外部资源到保险库',
        editorCallback: () => { void this.packToVault(); }
      });

      this.addCommand({
        id: 'duallink-pack-out',
        name: 'DualOut: 外置内部媒体到外部目录',
        editorCallback: () => { void this.packOut(); }
      });

      this.addCommand({
        id: 'duallink-repair-plain-links',
        name: '修复历史明文绝对路径链接 → file:///',
        callback: () => { void this.repairPlainAbsoluteLinks(); }
      });

      // 4.5 注册右键菜单 (Editor Context Menu)
      this.registerEvent(
        this.app.workspace.on('editor-menu', (menu, editor) => {
          menu.addItem((item) => {
            item
              .setTitle('DLink')
              .setIcon('link-2')
              .onClick(() => {
                void this.promptForLocalFileLink(editor);
              });
          });
          menu.addItem((item) => {
            item
              .setTitle('DualIn')
              .setIcon('archive')
              .onClick(() => {
                void this.packToVault();
              });
          });
          menu.addItem((item) => {
            item
              .setTitle('DualOut')
              .setIcon('external-link')
              .onClick(() => {
                void this.packOut();
              });
          });
        })
      );

      // 5. 注册 Markdown 渲染后处理器, 用于在只读模式下内联渲染图片与音视频
      this.registerMarkdownPostProcessor((element, context) => {
        if (!this.settings.inlineRenderEnabled) return;

        // 失效外部文件被自动重定位后，用新路径在阅读视图中就地渲染为对应媒体
        const renderRelocatedMedia = (el: HTMLElement, newPath: string): void => {
          const newBlobUrl = blobUrlForFilePath(newPath);
          if (!newBlobUrl) return;
          const newExt = newPath.split('.').pop()?.toLowerCase() || '';

          if (el.tagName === 'A') {
            const prevNode = el.previousSibling;
            if (prevNode && prevNode.nodeType === Node.TEXT_NODE && prevNode.textContent?.endsWith('!')) {
              prevNode.textContent = prevNode.textContent.slice(0, -1);
            }
          }

          if (isVideoExt(newExt)) {
            const video = createEl('video');
            video.src = newBlobUrl;
            video.controls = false;
            video.addEventListener('mouseenter', () => video.controls = true);
            video.addEventListener('mouseleave', () => video.controls = false);
            video.className = 'duallink-rendered-video';
            el.replaceWith(video);
            trackBlobNode(video, newBlobUrl);
          } else if (isAudioExt(newExt)) {
            const audio = createEl('audio');
            audio.src = newBlobUrl;
            audio.controls = true;
            audio.className = 'duallink-rendered-audio';
            el.replaceWith(audio);
            trackBlobNode(audio, newBlobUrl);
          } else if (el.tagName === 'IMG') {
            (el as HTMLImageElement).src = newBlobUrl;
            (el as HTMLImageElement).className = 'duallink-rendered-image';
            trackBlobNode(el, newBlobUrl);
          } else {
            const img = createEl('img');
            img.src = newBlobUrl;
            img.className = 'duallink-rendered-image';
            el.replaceWith(img);
            trackBlobNode(img, newBlobUrl);
          }
        };

        // 1. 处理标准的嵌入语法 (形如 ![name](local-file://...)) 被 Obsidian 渲染成的 <img>
        const images = Array.from(element.querySelectorAll('img'));
        images.forEach((img) => {
          const src = img.getAttribute('src');
          if (src && (src.startsWith('local-file://') || src.startsWith('file:///') || src.startsWith('app://'))) {
            // 立即移除原始 src，避免浏览器在我们替换为 blob URL 之前尝试加载
            // app://local/（已弃用）或 file:/// 协议而报 ERR_FILE_NOT_FOUND
            img.removeAttribute('src');
            const filePath = src.startsWith('app://')
              ? getCleanAppLocalPath(src)
              : getCleanLocalPath(src);
            if (!filePath) return;
            
            const ext = filePath.split('.').pop()?.toLowerCase() || '';
            const blobUrl = blobUrlForFilePath(filePath);

            if (isVideoExt(ext)) {
              if (blobUrl) {
                const video = createEl('video');
                video.src = blobUrl;
                video.controls = false;
                video.addEventListener('mouseenter', () => video.controls = true);
                video.addEventListener('mouseleave', () => video.controls = false);
                video.className = 'duallink-rendered-video';
                img.replaceWith(video);
                trackBlobNode(video, blobUrl);
              }
            } else if (isAudioExt(ext)) {
              if (blobUrl) {
                const audio = createEl('audio');
                audio.src = blobUrl;
                audio.controls = true;
                audio.className = 'duallink-rendered-audio';
                img.replaceWith(audio);
                trackBlobNode(audio, blobUrl);
              }
            } else if (blobUrl) {
              img.src = blobUrl;
              img.className = 'duallink-rendered-image';
              trackBlobNode(img, blobUrl);
            }

            // 文件缺失（如根目录/盘符变化）时，自动在 defaultFolderPath 下重定位并写回笔记源码
            // （跳过 Gallery 容器内的元素：Gallery 有自身的失效兜底与编辑交互，避免相互干扰）
            if (!blobUrl && this.settings.defaultFolderPath && isMediaExt(ext) && !img.closest('.duallink-gallery-container')) {
              this.scheduleExternalRelocate(context.sourcePath, filePath, img, renderRelocatedMedia);
            }
          }
        });

        // 2. 某些情况下 Obsidian 会把媒体文件语法当成 <a> 展现
        const links = Array.from(element.querySelectorAll('a.external-link'));
        links.forEach(a => {
          const href = a.getAttribute('href');
          if (href && (href.startsWith('local-file://') || href.startsWith('file:///') || href.startsWith('app://'))) {
            const filePath = href.startsWith('app://')
              ? getCleanAppLocalPath(href)
              : getCleanLocalPath(href);
            if (!filePath) return;
            const ext = filePath.split('.').pop()?.toLowerCase() || '';
            
            if (isMediaExt(ext)) {
              const blobUrl = blobUrlForFilePath(filePath);
              if (!blobUrl) {
                // 文件缺失（如根目录/盘符变化）时，自动在 defaultFolderPath 下重定位并写回笔记源码
                // （跳过 Gallery 容器内的元素：Gallery 有自身的失效兜底与编辑交互，避免相互干扰）
                if (this.settings.defaultFolderPath && !a.closest('.duallink-gallery-container')) {
                  this.scheduleExternalRelocate(context.sourcePath, filePath, a as HTMLElement, renderRelocatedMedia);
                }
                return;
              }

              const prevNode = a.previousSibling;
              if (prevNode && prevNode.nodeType === Node.TEXT_NODE && prevNode.textContent?.endsWith('!')) {
                prevNode.textContent = prevNode.textContent.slice(0, -1); 
              }

              if (isVideoExt(ext)) {
                const video = createEl('video');
                video.src = blobUrl;
                video.controls = false;
                video.addEventListener('mouseenter', () => video.controls = true);
                video.addEventListener('mouseleave', () => video.controls = false);
                video.className = 'duallink-rendered-video';
                a.replaceWith(video);
                trackBlobNode(video, blobUrl);
              } else if (isAudioExt(ext)) {
                const audio = createEl('audio');
                audio.src = blobUrl;
                audio.controls = true;
                audio.className = 'duallink-rendered-audio';
                a.replaceWith(audio);
                trackBlobNode(audio, blobUrl);
              } else if (isImageExt(ext)) {
                const img = createEl('img');
                img.src = blobUrl;
                img.className = 'duallink-rendered-image';
                a.replaceWith(img);
                trackBlobNode(img, blobUrl);
              }
            }
          }
        });
      });
    }

    // 5.5 注册分栏组图 (Gallery) 的 代码块处理器（通用功能）
    registerGalleryProcessor(this, PathPromptModal);

    // 6. 注册通用命令 - 插入保险库内文件链接（桌面和移动端均可使用）
    this.addCommand({
      id: 'insert-vault-file-link',
      name: '插入保险库文件链接',
      editorCallback: (editor) => {
        new MobileFilePickerModal(this, editor).open();
      }
    });

    // 7. 添加 Ribbon 图标（桌面和移动端通用）
    if (this.settings.showMobileToolbarButton) {
      this.addRibbonIcon('link-2', 'DLink', () => {
        if (isDesktop() && fs && path && electron) {
          this.showDesktopMenu();
        } else {
          this.showMobileMenu();
        }
      });
    }

    // 8. 注册设置管理面板
    this.addSettingTab(new LocalFileLinkerSettingTab(this.app, this));
  }

  // 显示桌面端菜单
  showDesktopMenu() {
    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle('插入本地文件链接')
        .setIcon('link-2')
        .onClick(() => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (view) {
            void this.promptForLocalFileLink(view.editor);
          }
        });
    });

    menu.addItem((item) => {
      item.setTitle('插入保险库文件')
        .setIcon('folder')
        .onClick(() => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (view) {
            new MobileFilePickerModal(this, view.editor).open();
          } else {
            new Notice('请先打开一个 Markdown 编辑器');
          }
        });
    });

    menu.addSeparator();

    menu.addItem((item) => {
      item.setTitle('DualIn：打包到保险库')
        .setIcon('archive')
        .onClick(() => void this.packToVault());
    });

    menu.addItem((item) => {
      item.setTitle('DualOut：外置到外部')
        .setIcon('external-link')
        .onClick(() => void this.packOut());
    });

    menu.showAtPosition({ x: 50, y: 50 });
  }

  // 显示移动端菜单
  showMobileMenu() {
    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle('插入保险库文件')
        .setIcon('folder')
        .onClick(() => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (view) {
            new MobileFilePickerModal(this, view.editor).open();
          } else {
            new Notice('请先打开一个 Markdown 编辑器');
          }
        });
    });

    menu.addSeparator();

    menu.addItem((item) => {
      item.setTitle('关于 DLink')
        .setIcon('info')
        .onClick(() => {
          new Notice('DLink - 管理本地与保险库文件链接的插件。桌面端支持更多功能。');
        });
    });

    menu.showAtPosition({ x: 50, y: 50 });
  }

  async loadSettings() {
    const data = await this.loadData() as Partial<LocalFileLinkerSettings> | null;
    if (data) {
      // 自 v1.1 起路径格式统一为 file:///，清理旧「默认双链格式」设置残留（避免历史 absolute-path 值被沿用）
      delete (data as Partial<Record<string, unknown>>).defaultLinkStyle;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  public async findExternalFileRec(fileName: string, dir: string, maxDepth = 4, currentDepth = 0): Promise<string | null> {
    return findExternalFileRec(fileName, dir, maxDepth, currentDepth);
  }

  /**
   * 渲染时发现外部文件缺失后的自动重定位：
   * 在 defaultFolderPath（新根）下定位文件，并把笔记源码中的旧路径改写为新路径。
   * @returns 找到的新路径；未配置根目录 / 未找到 / 文件不存在时不返回（调用方保持原行为）。
   */
  private async relocateMissingAndRewrite(sourcePath: string, oldPath: string): Promise<string | null> {
    const newRoot = this.settings.defaultFolderPath;
    if (!newRoot || !isDesktop() || !fs) return null;

    const foundPath = await relocateMissingFile(oldPath, newRoot, this.app);
    if (!foundPath || foundPath === oldPath) return null;

    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return foundPath;

    // 正在源码 / Live Preview 中被编辑的笔记不写盘（避免与编辑器缓冲区冲突），只返回新路径供本次渲染
    const editingOpen = this.app.workspace.getLeavesOfType('markdown').some((leaf) => {
      const view = leaf.view;
      return view instanceof MarkdownView && !!view.file && view.file.path === sourcePath && view.getMode() !== 'preview';
    });
    if (editingOpen) return foundPath;

    const rewrite = async (): Promise<void> => {
      const encodedOld = encodeExternalPathText(oldPath);
      const encodedNew = encodeExternalPathText(foundPath);
      let changed = false;
      try {
        await this.app.vault.process(file, (data: string) => {
          if (data.indexOf(encodedOld) === -1 && data.indexOf(oldPath) === -1) return data;
          let out = data;
          if (encodedOld !== oldPath && out.includes(encodedOld)) {
            out = out.split(encodedOld).join(encodedNew);
            changed = true;
          }
          if (out.includes(oldPath)) {
            out = out.split(oldPath).join(foundPath);
            changed = true;
          }
          return out;
        });
      } catch { /* 写入失败时静默，不影响本次渲染 */ }
      if (changed) {
        new Notice(`已自动修复失效的外部文件链接 → ${path.basename(foundPath)}`);
      }
    };

    // 同一笔记的改写任务串行排队，避免并发 process 相互覆盖
    const prev = this.relocateQueue.get(sourcePath) ?? Promise.resolve();
    const next = prev.then(rewrite).catch(() => { /* 忽略单次改写失败，避免阻塞同笔记的后续任务 */ });
    this.relocateQueue.set(sourcePath, next);
    void next.then(() => {
      if (this.relocateQueue.get(sourcePath) === next) this.relocateQueue.delete(sourcePath);
    });
    return foundPath;
  }

  /**
   * 调度一次“渲染时缺文件 → 自动重定位并写回”任务；
   * 找到新路径且原元素仍在文档中时，用新文件把占位元素渲染为对应媒体。
   */
  private scheduleExternalRelocate(
    sourcePath: string,
    oldPath: string,
    el: HTMLElement,
    applyMedia: (el: HTMLElement, newPath: string) => void
  ): void {
    void this.relocateMissingAndRewrite(sourcePath, oldPath).then((foundPath) => {
      if (!foundPath || !el.isConnected) return;
      applyMedia(el, foundPath);
    });
  }

  generateMarkdownLink(fileName: string, path: string): string {
    const cleanName = fileName.replace(/['"]/g, '').trim();
    const ext = cleanName.split('.').pop()?.toLowerCase() || '';

    // 自 v1.1 起统一输出 file:/// 编码格式（媒体与非媒体一致），跨端与外部工具兼容
    const finalSrc = `file:///${encodeFileUriPath(path)}`;

    if (isMediaExt(ext) && this.settings.inlineRenderEnabled) {
      if (isVideoExt(ext)) return `![🎬 ${cleanName}](<${finalSrc}>)`;
      if (isAudioExt(ext)) return `![🎵 ${cleanName}](<${finalSrc}>)`;
      return `![🖼 ${cleanName}](<${finalSrc}>)`;
    }

    return `[📄 ${cleanName}](<${finalSrc}>)`;
  }

  async packToVault() {
    if (!isDesktop() || !fs || !path) {
      new Notice('DualIn 功能仅支持桌面版 Obsidian');
      return;
    }
    await doPackToVault(this);
  }

  async packOut() {
    if (!isDesktop() || !fs || !path) {
      new Notice('DualOut 功能仅支持桌面版 Obsidian');
      return;
    }
    await doPackOut(this);
  }

  /**
   * 一次性修复命令：把历史遗留的「明文绝对路径」(旧 absolute-path 格式) 外链
   * 改写为标准 file:/// 编码链接。正在源码 / Live Preview 中编辑的笔记跳过写盘。
   */
  async repairPlainAbsoluteLinks(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    let fixedFiles = 0;
    let totalLinks = 0;
    let skippedEditing = 0;

    for (const file of files) {
      // 源码 / Live Preview 中被编辑的笔记不写盘（避免与编辑器缓冲区冲突）
      const editingOpen = this.app.workspace.getLeavesOfType('markdown').some((leaf) => {
        const view = leaf.view;
        return view instanceof MarkdownView && !!view.file && view.file.path === file.path && view.getMode() !== 'preview';
      });
      if (editingOpen) {
        skippedEditing++;
        continue;
      }

      const text = await this.app.vault.cachedRead(file);
      const result = rewritePlainLinksToFileUri(text);
      if (result.count === 0) continue;

      totalLinks += result.count;
      fixedFiles++;
      await this.app.vault.process(file, (data: string) => (data === text ? result.out : rewritePlainLinksToFileUri(data).out));
    }

    if (totalLinks === 0) {
      new Notice('未发现需要修复的明文绝对路径链接。');
    } else {
      new Notice(`✅ 已修复 ${fixedFiles} 个文件中的 ${totalLinks} 条明文路径链接 → file:/// 格式`);
    }
    if (skippedEditing > 0) {
      new Notice(`⚠️ ${skippedEditing} 个正在编辑中的笔记已跳过，请关闭相关源码/Live Preview 后重试。`, 5000);
    }
  }

  /**
   * 注册自定义底层协议与 DOM 交互拦截
   */
  registerObsidianProtocol() {
    // 监听 Obsidian 内部路由：obsidian://local-file-open?path=...
    this.registerObsidianProtocolHandler('local-file-open', (args) => {
      const pathWithSlash = args.path;
      if (pathWithSlash) {
        const decodedPath = safeDecodeURIComponent(pathWithSlash);
        this.openFileInSystem(decodedPath);
      }
    });

    // 捕获阅读视图中的 A 标签事件。如果是 local-file:// 开头则安全拦截，通过系统原生应用调取
    this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      if (!target) return;

      if (target.tagName !== 'A' && !target.classList.contains('cm-url') && !target.classList.contains('cm-link') && !target.classList.contains('cm-underline')) {
        return;
      }

      let href: string | null = null;
      if (target.tagName === 'A' && target.classList.contains('external-link')) {
        href = target.getAttribute('href');
      } else if (target.classList.contains('cm-url') || target.classList.contains('cm-link') || target.classList.contains('cm-underline')) {
        href = target.innerText || target.textContent;
      }

      if (href && (href.startsWith('local-file://') || href.includes('local-file://') || href.includes('file:///'))) {
        evt.preventDefault();
        const filePath = getCleanLocalPath(href);
        if (filePath) {
          this.openFileInSystem(filePath);
        }
      }
    });

    // 监听右键点击，唤起辅助菜单（实现：4. 在资源管理器中显示该文件）
    this.registerDomEvent(document, 'contextmenu', (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      if (!target) return;

      let href: string | null = null;
      if (target.tagName === 'A' && target.classList.contains('external-link')) {
        href = target.getAttribute('href');
      } else if (target.classList.contains('cm-url') || target.classList.contains('cm-link') || target.classList.contains('cm-underline')) {
        href = target.innerText || target.textContent;
      }

      if (href && (href.startsWith('local-file://') || href.includes('local-file://') || href.includes('file:///'))) {
        const filePath = getCleanLocalPath(href);
        if (!filePath) return;

        evt.preventDefault();

        const menu = new Menu();

        // 也可以选择在默认应用中打开文件 (行为类似鼠标左键点击)
        menu.addItem((item) => {
          item.setTitle('在相关默认应用中打开文件')
            .setIcon('popup-open')
            .onClick(() => {
              this.openFileInSystem(filePath);
            });
        });

        // 核心功能：在系统文件资源管理器中显示（Reveal in Explorer / Show in Finder）
        if (electron) {
          menu.addItem((item) => {
            item.setTitle('在系统资源管理器中显示 (Reveal)')
              .setIcon('folder')
              .onClick(() => {
                try {
                  electron.shell.showItemInFolder(filePath);
                  new Notice('正在文件系统的所在文件夹中高亮显示该文件...');
                } catch (e) {
                  new Notice('无法调用系统资源管理器定位：' + (e instanceof Error ? e.message : String(e)), 5000);
                }
              });
          });
        }

        menu.addItem((item) => {
          item.setTitle('复制绝对路径')
            .setIcon('link')
            .onClick(async () => {
              await navigator.clipboard.writeText(filePath);
              new Notice('已复制文件的绝对路径到剪贴板！');
            });
        });

        menu.showAtMouseEvent(evt);
      }
    });
  }

  /**
   * 获取当前 Obsidian 库在磁盘上的根目录绝对路径。
   */
  getVaultBasePath(): string {
    const adapter = this.app.vault.adapter as unknown as VaultAdapter;
    return adapter.getBasePath ? adapter.getBasePath() : '';
  }

  /**
   * 解析当前 Obsidian 库配置的附件目录绝对路径。
   * 兼容 attachmentFolderPath 的多种取值：文件夹名、绝对路径、'.'(库根)、'./'(当前笔记目录) 等。
   * 内模式的默认浏览根目录采用该路径。
   */
  getAttachmentFolderPath(): string {
    const vaultBase = this.getVaultBasePath();
    if (!vaultBase) return '';
    const cfg = String((this.app.vault as unknown as VaultConfigExt).config?.attachmentFolderPath ?? '.');
    const activeNoteDir = () => {
      const af = this.app.workspace.getActiveFile();
      return af ? path.dirname(path.join(vaultBase, af.path)) : vaultBase;
    };
    if (cfg === '.') return vaultBase;        // 附件存于保险库根
    if (cfg === './') return activeNoteDir(); // 附件存于当前笔记所在目录
    if (cfg.startsWith('./')) return path.join(activeNoteDir(), cfg.substring(2));
    return path.isAbsolute(cfg) ? cfg : path.join(vaultBase, cfg);
  }

  /**
   * 唤醒宿主机操作系统的底层默认程序（无需复制或加载大容量文件）
   */
  openFileInSystem(filePath: string) {
    if (!isDesktop() || !electron) {
      new Notice('提示：当前不在本地 Electron 桌面外壳中。请在桌面版 Obsidian 中使用以一键唤起。');
      return;
    }
    const fileName = filePath.split('/').pop() || '外部文件';
    new Notice(`📂 正在调取系统原生应用打开文件: ${fileName}`);
    try {
      electron.shell.openPath(filePath).then((err: string) => {
                if (err) {
                  new Notice(`⚠️ 无法唤醒程序: ${err}`, 5000);
                }
              }).catch((e: unknown) => {
                const msg = e instanceof Error ? e.message : (typeof e === 'string' ? e : '未知错误');
                new Notice(`⚠️ 无法打开文件: ${msg}`, 5000);
              });
    } catch {
      // 兼容非 Electron Web 环境下的说明
      new Notice('提示：当前不在本地 Electron 桌面外壳中。请在桌面版 Obsidian 中使用以一键唤起。');
    }
  }

  /**
   * 手动指令录入全路径降级辅助
   */
  promptForLocalFileLink(editor?: Editor) {
    if (!isDesktop() || !fs || !path) {
      new Notice('文件浏览器功能仅支持桌面版 Obsidian');
      return;
    }
    const defaultEditor = editor || this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
    if (!defaultEditor) {
      new Notice('无法读取到当前正在编辑的活动 Markdown 文档！');
      return;
    }

    const selectedText = defaultEditor.getSelection().trim();

    new PathPromptModal(this, selectedText, (inputPath, customName) => {
      if (!inputPath) return;

      if (customName && customName.startsWith('____GALLERY_CONFIG_COLUMNS_')) {
          const colsCount = customName.replace('____GALLERY_CONFIG_COLUMNS_', '');
          const paths = inputPath.split('|||');
          
          let blockContent = `\`\`\`duallink-gallery\n{ "columns": ${colsCount} }\n`;
          paths.forEach(p => {
              const cleanP = p.replace(/['"]/g, '').trim();
              const internalPath = vaultRelativeFromAbsolute(this.app, cleanP);
              if (internalPath !== null) {
                  blockContent += `![[${internalPath}]]\n`;
              } else {
                  blockContent += `![](<file:///${encodeFileUriPath(cleanP)}>)\n`;
              }
          });
          blockContent += '```\n';
          
          const cursor = defaultEditor.getCursor();
          defaultEditor.replaceRange(blockContent, cursor);
          new Notice('✅ 已向文档焦点处注入了分栏组图！');
          return;
      }

      const cleanInputPath = inputPath.replace(/['"]/g, '').trim();
      const defaultName = cleanInputPath.split(/[/\\]/).pop() || '外部关联文件';
      const finalName = customName.trim() || defaultName;
      
      let mdLink = '';

      const internalPath = vaultRelativeFromAbsolute(this.app, cleanInputPath);
      if (internalPath !== null) {
          const ext = internalPath.split('.').pop()?.toLowerCase() || '';
          const media = isMediaExt(ext);
          mdLink = media ? `![[${internalPath}]]` : `[[${internalPath}|${finalName}]]`;
      } else {
          mdLink = this.generateMarkdownLink(finalName, cleanInputPath);
      }
      
      const cursor = defaultEditor.getCursor();
      if (selectedText) {
        defaultEditor.replaceSelection(mdLink);
      } else {
        defaultEditor.replaceRange(mdLink, cursor);
      }
      new Notice('✅ 已向文档焦点处注入了本地文件物理软连接！');
    }).open();
  }
}

export class PathPromptModal extends Modal {
  private onSubmit: (path: string, name: string) => void;
  private inputPath: string = '';
  private customName: string = '';
  private currentFolderPath: string = '';
  private searchQuery: string = '';
  private currentTab: 'all' | 'image' | 'video' | 'audio' = 'all';
  private filesList: FileItem[] = [];
  private contentContainer: HTMLElement;
  private pathInputEl: HTMLInputElement | null = null;
  private plugin: LocalFileLinkerPlugin;
  private currentMode: 'external' | 'internal' = 'external';
  private lastExternalPath: string = '';

  private selectedFiles: Set<FileItem> = new Set();
  private isMultiSelectMode: boolean = false;
  private colsCount: number = 3;
  private updateInsertBtn?: () => void;

  constructor(plugin: LocalFileLinkerPlugin, defaultName: string, onSubmit: (path: string, name: string) => void) {
    super(plugin.app);
    this.plugin = plugin;
    this.customName = defaultName;
    this.onSubmit = onSubmit;
    this.currentFolderPath = plugin.settings.defaultFolderPath || '';
    this.lastExternalPath = this.currentFolderPath;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
    // 检测设备并设置合适的弹窗尺寸
    const isMobileDevice = window.innerWidth < 768;
    
    this.modalEl.addClass('dual-link-modal');
    if (isMobileDevice) {
      this.modalEl.addClass('dual-link-modal--mobile');
    }
    
    // 内容区的布局配置
    contentEl.addClass('content-wrapper');

    // 顶部设置区域
    const topArea = contentEl.createDiv({ cls: 'top-area' });
    
    // 1. 文件夹路径选择行 - 移动端优化
    const pathRow = topArea.createDiv({ cls: 'path-row' });
    
    this.pathInputEl = pathRow.createEl('input', { 
      type: 'text', 
      placeholder: '粘贴文件夹的绝对路径...',
      cls: 'path-input'
    });
    this.pathInputEl.value = this.currentFolderPath;
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- 事件回调内含 await，返回值被忽略是预期行为
    this.pathInputEl.addEventListener('change', async (e) => {
        this.currentFolderPath = (e.target as HTMLInputElement).value;
        await this.loadFiles();
    });
    
    // 浏览按钮 - 优先用 Electron 原生对话框
    const browseBtn = pathRow.createEl('button', { text: '浏览', cls: 'btn-plain btn-browse' });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- 事件回调内含 await，返回值被忽略是预期行为
    browseBtn.addEventListener('click', async () => {
        // 尝试 Electron 原生对话框
        let selectedDir: string | null = null;
        try {
            const remoteDialog = electron?.remote?.dialog;
            if (remoteDialog) {
                const result = await remoteDialog.showOpenDialog({
                    title: '选择文件夹',
                    properties: ['openDirectory']
                });
                if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                    selectedDir = result.filePaths[0];
                }
            }
        } catch {
            // remote 不可用，降级到 HTML input
        }

        if (selectedDir) {
            this.currentFolderPath = selectedDir;
            if (this.pathInputEl) this.pathInputEl.value = this.currentFolderPath;
            await this.loadFiles();
        } else {
            // 降级: HTML webkitdirectory input
            const fileInput = createEl('input');
            fileInput.type = 'file';
            fileInput.setAttribute('webkitdirectory', '');
            fileInput.setAttribute('directory', '');
            fileInput.webkitdirectory = true;
            fileInput.addClass('file-input-hidden');
            activeDocument.body.appendChild(fileInput);
            
            fileInput.onchange = () => {
                void (async () => {
                    if (fileInput.files && fileInput.files.length > 0) {
                        const f = fileInput.files[0];
                        const sysPath = (f as FileWithPath).path;
                        if (sysPath) {
                            try {
                                const relPath = (f as FileWithPath).webkitRelativePath;
                                let dirPath: string;
                                if (relPath && relPath.includes('/')) {
                                    let d = relPath.split('/').length - 1;
                                    dirPath = sysPath;
                                    while (d > 0) { dirPath = path.dirname(dirPath); d--; }
                                } else {
                                    dirPath = path.dirname(sysPath);
                                }
                                this.currentFolderPath = dirPath;
                                if (this.pathInputEl) this.pathInputEl.value = this.currentFolderPath;
                                await this.loadFiles();
                            } catch (err) {
                                new Notice('读取目录失败: ' + (err instanceof Error ? err.message : String(err)));
                            }
                        } else {
                            new Notice('无法获取系统路径，请手动输入。');
                        }
                    } else {
                        new Notice('所选目录为空或无法读取。');
                    }
                    fileInput.remove();
                })();
            };
            fileInput.click();
        }
    });

    const modeBtn = pathRow.createEl('button', { cls: 'btn-plain btn-mode' });
    modeBtn.title = '在外部绝对路径与当前 Obsidian 库目录模式之间切换';
    
    const updateModeBtn = () => {
        modeBtn.empty();
        if (this.currentMode === 'external') {
            setIcon(modeBtn, 'link-2-off');
            modeBtn.createSpan({ text: '外' });
        } else {
            setIcon(modeBtn, 'link-2');
            modeBtn.createSpan({ text: '内' });
        }
    };
    updateModeBtn();

    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- 事件回调内含 await，返回值被忽略是预期行为
    modeBtn.addEventListener('click', async () => {
        if (this.currentMode === 'external') {
            this.currentMode = 'internal';
            this.lastExternalPath = this.currentFolderPath; 

            if (this.plugin.settings.internalFolderPath) {
                this.currentFolderPath = this.plugin.settings.internalFolderPath;
            } else {
                // 内模式默认进入 Obsidian 附件目录；目录缺失时自动补建（Obsidian 也会在首次存附件时创建），失败则回退到库根目录
                this.currentFolderPath = '';
                const attachDir = this.plugin.getAttachmentFolderPath();
                if (attachDir) {
                    if (!fs.existsSync(attachDir)) {
                        try {
                            fs.mkdirSync(attachDir, { recursive: true });
                        } catch {
                            // 创建失败（如权限不足），交由下方库根回退处理
                        }
                    }
                    if (fs.existsSync(attachDir)) {
                        this.currentFolderPath = attachDir;
                    }
                }
                if (!this.currentFolderPath) {
                    const vaultBase = this.plugin.getVaultBasePath();
                    if (vaultBase) {
                        this.currentFolderPath = vaultBase;
                    } else {
                        new Notice('无法获取当前库目录的绝对路径');
                    }
                }
            }
        } else {
            this.currentMode = 'external';
            this.currentFolderPath = this.lastExternalPath || this.plugin.settings.defaultFolderPath; 
        }

        // 模式切换后恢复的路径可能已失效，同样做一次自动回退
        await this.ensureValidFolder();
        
        updateModeBtn();

        if (this.pathInputEl) this.pathInputEl.value = this.currentFolderPath;
        await this.loadFiles();
    });

    // 2. 搜索框与分类标签栏 - 移动端优化为垂直布局
    const filterRow = topArea.createDiv({ cls: isMobileDevice ? 'filter-row filter-row--mobile' : 'filter-row' });
    
    const searchInput = filterRow.createEl('input', { 
      type: 'text', 
      placeholder: '搜索该目录下的文件...',
      cls: isMobileDevice ? 'search-input search-input--mobile' : 'search-input'
    });
    searchInput.addEventListener('input', (e) => {
        this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
        this.renderFiles();
    });
    
    // 聚焦到文件搜索框中
    window.setTimeout(() => {
        searchInput.focus();
    }, 50);
    
    const tabsDiv = filterRow.createDiv({ cls: 'tabs-wrapper' });

    // 2.5 多选模式与栏数控制
    const galleryControls = filterRow.createDiv({ cls: 'gallery-controls' });

    const insertGalleryBtn = galleryControls.createEl('button', { text: '插入多项', cls: 'btn-insert-gallery' });

    insertGalleryBtn.addEventListener('click', () => {
        if (this.selectedFiles.size === 0) {
            new Notice('请先选择至少一个图像');
            return;
        }
        const selected = Array.from(this.selectedFiles);
        this.close();
        
        const paths = selected.map(f => f.path).join('|||');
        const count = selected.length;
        this.colsCount = count > 5 ? 5 : count;
        this.onSubmit(paths, `____GALLERY_CONFIG_COLUMNS_${this.colsCount}`);
    });
    
    this.updateInsertBtn = () => {
        if (this.selectedFiles.size > 0) {
            insertGalleryBtn.addClass('btn-insert-gallery--visible');
            const count = this.selectedFiles.size;
            const cols = count > 5 ? 5 : count;
            insertGalleryBtn.textContent = `插入 ${count} 张图 (分${cols}栏)`;
        } else {
            insertGalleryBtn.removeClass('btn-insert-gallery--visible');
        }
    };

    const tabs = [
        { id: 'all', label: '全部' },
        { id: 'image', label: '图片' },
        { id: 'video', label: '视频' },
        { id: 'audio', label: '音频' }
    ];
    
    tabs.forEach(tab => {
        const tabEl = tabsDiv.createEl('button', { text: tab.label, cls: 'duallink-tab-btn' });
        if (this.currentTab === tab.id) {
            tabEl.addClass('duallink-tab-btn--active');
        }
        tabEl.addEventListener('click', () => {
            this.currentTab = tab.id as typeof this.currentTab;
            Array.from(tabsDiv.children).forEach((child: HTMLElement) => {
                child.removeClass('duallink-tab-btn--active');
            });
            tabEl.addClass('duallink-tab-btn--active');
            this.renderFiles();
        });
    });
    
    // 内容显示区 - 移动端优化 (使用同一个 isMobileDevice 变量)
    this.contentContainer = contentEl.createDiv({ cls: 'content-container' });

    // 恢复/切换默认目录时校验一次：上次记录的目录可能已被删除或移动，
    // 自动回退到可用目录，避免每次打开都对不存在的路径 readdir 报 ENOENT。
    await this.ensureValidFolder();

    if (this.currentFolderPath) {
      await this.loadFiles();
    } else {
      this.renderEmptyState('请输入或选择一个文件夹路径开始预览。');
    }
  }

  /**
   * 目录失效自动回退：当恢复的默认目录（或模式切换后的路径）不存在时，
   * 依次尝试另一模式的已存目录、当前 Obsidian 库根目录；全部无效则清空路径并提示。
   * 仅用于"打开/切换默认目录"场景，不影响用户手动输入路径的原有行为。
   */
  private async ensureValidFolder() {
    if (!this.currentFolderPath || fs.existsSync(this.currentFolderPath)) return;

    const stalePath = this.currentFolderPath;
    const otherModePath =
      this.currentMode === 'external'
        ? this.plugin.settings.internalFolderPath
        : this.plugin.settings.defaultFolderPath;
    const attachmentDir = this.plugin.getAttachmentFolderPath();
    const adapter = this.plugin.app.vault.adapter as unknown as VaultAdapter;
    const vaultBase = adapter.getBasePath ? adapter.getBasePath() : '';
    const fallback = [otherModePath, attachmentDir, vaultBase].find(
      (p) => !!p && p !== stalePath && fs.existsSync(p)
    );

    if (fallback) {
      this.currentFolderPath = fallback;
      if (this.currentMode === 'external') {
        this.lastExternalPath = fallback;
        if (!this.plugin.settings.defaultFolderPath || this.plugin.settings.defaultFolderPath === stalePath) {
          this.plugin.settings.defaultFolderPath = fallback;
          await this.plugin.saveSettings();
        }
      } else if (this.plugin.settings.internalFolderPath === stalePath) {
        this.plugin.settings.internalFolderPath = fallback;
        await this.plugin.saveSettings();
      }
      new Notice(`上次的目录「${stalePath}」不存在，已自动切换到「${fallback}」`, 5000);
    } else {
      this.currentFolderPath = '';
      if (this.currentMode === 'external' && this.plugin.settings.defaultFolderPath === stalePath) {
        this.plugin.settings.defaultFolderPath = '';
        await this.plugin.saveSettings();
      }
      if (this.plugin.settings.internalFolderPath === stalePath) {
        this.plugin.settings.internalFolderPath = '';
        await this.plugin.saveSettings();
      }
      new Notice(`上次的目录「${stalePath}」不存在，请重新输入或选择路径`, 5000);
    }

    if (this.pathInputEl) {
      this.pathInputEl.value = this.currentFolderPath;
    }
  }

  async loadFiles() {
      if (!this.currentFolderPath) return;
      try {
          const dirents = await fs.promises.readdir(this.currentFolderPath, { withFileTypes: true });
          
          this.filesList = dirents.map((dirent: NodeDirent) => {
              const fullPath = path.join(this.currentFolderPath, dirent.name);
              return {
                  name: dirent.name,
                  path: fullPath,
                  isDirectory: dirent.isDirectory(),
                  ext: dirent.isDirectory() ? '' : path.extname(dirent.name).toLowerCase().replace('.', '')
              };
          }).filter((f: FileItem) => f !== null);

          // 排序：文件夹在前，文件在后
          this.filesList.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
          });
          
          // 更新设置中的默认文件路径，这样下次打开会自动处于该目录
          if (this.currentMode === 'external') {
              this.plugin.settings.defaultFolderPath = this.currentFolderPath;
              await this.plugin.saveSettings();
              this.lastExternalPath = this.currentFolderPath;
          } else {
              this.plugin.settings.internalFolderPath = this.currentFolderPath;
              await this.plugin.saveSettings();
          }

          if (this.pathInputEl) {
              this.pathInputEl.value = this.currentFolderPath;
          }

          this.renderFiles();
      } catch (e) {
          console.error('DLink loadFiles error:', e);
          new Notice('无法读取该路径: ' + (e instanceof Error ? e.message : String(e)));
          this.renderEmptyState('无法读取该路径，请检查路径是否正确或是否存在权限限制。');
      }
  }

  renderEmptyState(text: string) {
      this.contentContainer.empty();
      this.contentContainer.createDiv({ text, cls: 'empty-msg' });
  }

  renderFiles() {
      this.contentContainer.empty();
      
      const isMobileDevice = window.innerWidth < 768;
      
      const filtered = this.filesList.filter(file => {
          if (this.searchQuery && !file.name.toLowerCase().includes(this.searchQuery)) return false;
          
          if (this.currentTab === 'image' && !file.isDirectory && !isImageExt(file.ext)) return false;
          if (this.currentTab === 'video' && !file.isDirectory && !isVideoExt(file.ext)) return false;
          if (this.currentTab === 'audio' && !file.isDirectory && !isAudioExt(file.ext)) return false;
          
          return true;
      });

      // 文件夹排在前面（CSS columns 中 DOM 靠前的元素会优先填满各列顶部，自然置顶）
      const ordered: FileItem[] = [];

      // 添加返回上级目录选项
      try {
          const parentDir = path.dirname(this.currentFolderPath);
          if (parentDir && parentDir !== this.currentFolderPath) {
              ordered.push({
                  name: '.. (上级目录)',
                  path: parentDir,
                  isDirectory: true,
                  ext: ''
              });
          }
      } catch {
          // 无法解析上级目录时忽略，不添加「返回上级目录」选项
      }

      filtered.forEach(file => {
          if (file.isDirectory) ordered.push(file);
      });
      filtered.forEach(file => {
          if (!file.isDirectory) ordered.push(file);
      });
      
      if (ordered.length === 0) {
          this.renderEmptyState('该目录下没有找到匹配的文件。');
          return;
      }
      
      ordered.forEach(file => {
          const item = this.contentContainer.createDiv({ cls: isMobileDevice ? 'file-item file-item--mobile' : 'file-item' });
          
          const previewDiv = item.createDiv({ cls: isMobileDevice ? 'preview-div preview-div--mobile' : 'preview-div' });
          
          const imageCheck = !file.isDirectory && isImageExt(file.ext);
          const videoCheck = !file.isDirectory && isVideoExt(file.ext);

          if (file.isDirectory) {
              previewDiv.addClass('folder-preview-div');
              previewDiv.createDiv({ text: '📁', cls: 'file-icon' });
          } else if (imageCheck || videoCheck) {
              const renderBadge = () =>
                  previewDiv.createDiv({ text: file.ext ? file.ext.toUpperCase() : '?', cls: 'file-type-badge' });
              try {
                  const stat = fs.statSync(file.path);
                  if (stat.size > PREVIEW_VIDEO_BYTE_LIMIT) {
                      renderBadge();
                  } else {
                      const blobUrl = blobUrlForFilePath(file.path);
                      if (!blobUrl) {
                          renderBadge();
                      } else if (imageCheck) {
                          const img = previewDiv.createEl('img', { cls: 'preview-image' });
                          img.src = blobUrl;
                          trackBlobNode(img, blobUrl);
                      } else {
                          const video = previewDiv.createEl('video', { cls: 'preview-video' });
                          video.src = blobUrl;
                          video.muted = true;
                          video.autoplay = true;
                          video.loop = true;
                          trackBlobNode(video, blobUrl);
                      }
                  }
              } catch {
                  renderBadge();
              }
          } else {
              previewDiv.createDiv({ text: file.ext ? file.ext.toUpperCase() : '?', cls: 'file-type-badge' });
          }
          
          const nameSpan = item.createDiv({ 
            text: file.name, 
            cls: isMobileDevice ? 'file-name file-name--mobile' : 'file-name' 
          });
          nameSpan.title = file.name;
          
          let isSelected = Array.from(this.selectedFiles).some((f: FileItem) => f.path === file.path);
          if (isSelected) {
              item.addClass('file-item--selected');
          }

          // eslint-disable-next-line @typescript-eslint/no-misused-promises -- 事件回调内含 await，返回值被忽略是预期行为
          item.addEventListener('click', async (e) => {
              if (file.isDirectory) {
                  this.currentFolderPath = file.path;
                  this.searchQuery = '';
                  const searchInput = activeDocument.querySelector<HTMLInputElement>('input[placeholder="搜索该目录下的文件..."]');
                  if (searchInput) searchInput.value = '';
                  await this.loadFiles();
              } else {
                  if (e.ctrlKey || e.metaKey) {
                      // Toggle selection
                      if (isSelected) {
                          const toRemove = Array.from(this.selectedFiles).find((f: FileItem) => f.path === file.path);
                          this.selectedFiles.delete(toRemove);
                          isSelected = false;
                          item.removeClass('file-item--selected');
                      } else {
                          this.selectedFiles.add(file);
                          isSelected = true;
                          item.addClass('file-item--selected');
                      }
                      this.isMultiSelectMode = this.selectedFiles.size > 0;
                      if (this.updateInsertBtn) this.updateInsertBtn();
                  } else {
                      this.inputPath = file.path;
                      const nameToUse = this.customName || file.name;
                      this.close();
                      const media = isMediaExt(file.ext.toLowerCase());
                      if (media) {
                          this.onSubmit(this.inputPath, `____GALLERY_CONFIG_COLUMNS_1`);
                      } else {
                          this.onSubmit(this.inputPath, nameToUse);
                      }
                  }
              }
          });
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}


