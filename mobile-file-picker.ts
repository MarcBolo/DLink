import { Modal, Notice, TFile, MarkdownView, Editor } from 'obsidian';
import { isImageExt, isVideoExt, isAudioExt, isMediaExt } from './constants';
import { IDualLinkPlugin } from './types';

export class MobileFilePickerModal extends Modal {
  private plugin: IDualLinkPlugin;
  private editor: Editor;
  private allFiles: TFile[] = [];
  private searchQuery: string = '';
  private currentTab: 'all' | 'image' | 'video' | 'audio' | 'doc' = 'all';
  private contentContainer: HTMLElement;

  constructor(plugin: IDualLinkPlugin, editor: Editor) {
    super(plugin.app);
    this.plugin = plugin;
    this.editor = editor;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // 加载保险库中所有文件
    this.allFiles = this.app.vault.getFiles();

    const isMobileDevice = window.innerWidth < 768;
    this.modalEl.addClass('mobile-file-picker-modal');
    this.modalEl.addClass(isMobileDevice ? 'mobile-file-picker-modal--mobile' : 'mobile-file-picker-modal--desktop');

    contentEl.addClass('mobile-file-picker-content');

    // 标题
    contentEl.createEl('h3', { text: '选择保险库中的文件', cls: 'mobile-file-picker-title' });

    // 搜索框
    const searchRow = contentEl.createDiv({ cls: 'mobile-file-picker-search-row' });

    const searchInput = searchRow.createEl('input', {
      type: 'text',
      placeholder: '搜索文件名...',
      cls: 'mobile-file-picker-search-input',
    });
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value.toLowerCase();
      this.renderFiles();
    });

    setTimeout(() => searchInput.focus(), 100);

    // 标签栏
    const tabsRow = contentEl.createDiv({ cls: 'mobile-file-picker-tabs-row' });

    const tabs = [
      { id: 'all', label: '全部' },
      { id: 'image', label: '图片' },
      { id: 'video', label: '视频' },
      { id: 'audio', label: '音频' },
      { id: 'doc', label: '文档' },
    ] as const;

    tabs.forEach((tab) => {
      const tabEl = tabsRow.createEl('button', { text: tab.label, cls: 'mobile-file-picker-tab-btn' });

      if (this.currentTab === tab.id) {
        tabEl.addClass('mobile-file-picker-tab-btn--active');
      }

      tabEl.addEventListener('click', () => {
        this.currentTab = tab.id;
        Array.from(tabsRow.children).forEach((child: HTMLElement) => {
          child.removeClass('mobile-file-picker-tab-btn--active');
        });
        tabEl.addClass('mobile-file-picker-tab-btn--active');
        this.renderFiles();
      });
    });

    // 文件列表容器
    this.contentContainer = contentEl.createDiv({ cls: 'mobile-file-picker-file-container' });

    this.renderFiles();
  }

  renderFiles() {
    this.contentContainer.empty();

    const filtered = this.allFiles.filter((file) => {
      if (this.searchQuery && !file.name.toLowerCase().includes(this.searchQuery)) {
        return false;
      }

      const ext = file.extension.toLowerCase();
      switch (this.currentTab) {
        case 'image':
          return isImageExt(ext);
        case 'video':
          return isVideoExt(ext);
        case 'audio':
          return isAudioExt(ext);
        case 'doc':
          return ext === 'md';
        default:
          return true;
      }
    });

    if (filtered.length === 0) {
      this.contentContainer.createDiv({
        text: '没有找到匹配的文件',
        cls: 'mobile-file-picker-empty',
      });
      return;
    }

    // 显示结果计数
    this.contentContainer.createDiv({
      text: `共 ${filtered.length} 个文件`,
      cls: 'mobile-file-picker-count',
    });

    filtered.forEach((file) => {
      void this.renderFileItem(file);
    });
  }

  private renderFileItem(file: TFile) {
    const isMobileDevice = window.innerWidth < 768;
    const ext = file.extension.toLowerCase();

    const item = this.contentContainer.createDiv({ cls: isMobileDevice ? 'mobile-file-picker-item mobile-file-picker-item--mobile' : 'mobile-file-picker-item' });

    // 缩略图或图标
    const iconDiv = item.createDiv({ cls: isMobileDevice ? 'mobile-file-picker-icon mobile-file-picker-icon--mobile' : 'mobile-file-picker-icon' });

    // 尝试加载媒体预览
    // #3：直接使用 Obsidian vault 资源 URL(原生协议，带缓存)，不再 readBinary 整读全文件进 Blob。
    // 选文件时本列表会遍历整个库的媒体，旧实现每个文件全量读入会显著抬高内存/IO。
    let previewLoaded = false;
    if (isImageExt(ext) || isVideoExt(ext)) {
      const resource = this.app.vault.getResourcePath(file);
      if (isImageExt(ext)) {
        const img = iconDiv.createEl('img', { cls: 'mobile-file-picker-media-preview' });
        img.src = resource;
        previewLoaded = true;
      } else {
        const video = iconDiv.createEl('video', { cls: 'mobile-file-picker-media-preview mobile-file-picker-media-preview--video' });
        video.src = resource;
        video.muted = true;
        video.autoplay = true;
        video.loop = true;
        previewLoaded = true;
      }
    }

    if (!previewLoaded) {
      // 显示文件类型图标
      let iconText = '📄';
      if (isImageExt(ext)) iconText = '🖼';
      else if (isVideoExt(ext)) iconText = '🎬';
      else if (isAudioExt(ext)) iconText = '🎵';
      else if (ext === 'md') iconText = '📝';

      iconDiv.createSpan({ text: iconText, cls: isMobileDevice ? 'mobile-file-picker-file-icon mobile-file-picker-file-icon--mobile' : 'mobile-file-picker-file-icon' });
    }

    // 文件信息
    const infoDiv = item.createDiv({ cls: 'mobile-file-picker-info' });

    infoDiv.createDiv({ text: file.name, cls: 'mobile-file-picker-name' });

    // 路径
    const dirPath = file.parent?.path || '';
    infoDiv.createDiv({ text: dirPath || '根目录', cls: 'mobile-file-picker-path' });

    // 点击事件 - 插入链接到编辑器
    item.addEventListener('click', () => {
      this.insertFileLink(file);
    });
  }

  private insertFileLink(file: TFile) {
    const ext = file.extension.toLowerCase();
    const isMedia = isMediaExt(ext);
    const vaultPath = file.path;

    // 媒体文件用 ![[path]]，普通文件用 [[path]]
    const link = isMedia ? `![[${vaultPath}]]` : `[[${vaultPath}]]`;

    if (this.editor) {
      const cursor = this.editor.getCursor();
      this.editor.replaceRange(link + '\n', cursor);
    } else {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view?.editor) {
        view.editor.replaceRange(link + '\n', view.editor.getCursor());
      }
    }

    new Notice(`✅ 已插入: ${file.name}`);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
