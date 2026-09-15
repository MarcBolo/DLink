import { App, PluginSettingTab, Setting } from 'obsidian';
import type LocalFileLinkerPlugin from './main';

export class LocalFileLinkerSettingTab extends PluginSettingTab {
  plugin: LocalFileLinkerPlugin;

  constructor(app: App, plugin: LocalFileLinkerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('本地文件映射 & 实时预览设置面板').setHeading();

    new Setting(containerEl).setName('文件浏览器默认目录').setHeading();

    new Setting(containerEl)
      .setName('外部模式默认路径 (External)')
      .setDesc('「插入本地文件」弹窗的外模式打开时默认进入的目录。在该弹窗中切换目录时会自动更新此值。')
      .addText(text => text
        .setPlaceholder('例如: D:/MediaArchive/图片库')
        .setValue(this.plugin.settings.defaultFolderPath)
        .onChange(async (value) => {
          this.plugin.settings.defaultFolderPath = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('内部模式默认路径 (Internal)')
      .setDesc('「插入本地文件」弹窗的内模式打开时默认进入的目录。留空则自动采用当前库配置的 Obsidian 附件目录，附件目录不可用时回退到库根目录。')
      .addText(text => text
        .setPlaceholder('例如: 附件 或 D:/MediaArchive/媒体库')
        .setValue(this.plugin.settings.internalFolderPath)
        .onChange(async (value) => {
          this.plugin.settings.internalFolderPath = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('文档内嵌渲染媒体 (Inline Rendering)')
      .setDesc('在阅读视图下，自动将带感叹号的 ![视频](local-file://...) 媒体链接原内联转换为播放器、图片组件。')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.inlineRenderEnabled)
        .onChange(async (value) => {
          this.plugin.settings.inlineRenderEnabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('外部媒体归档目录 (External Media Folder)')
      .setDesc('DualOut 功能将内部附件迁移至此目录。留空则每次使用时手动选择。')
      .addText(text => text
        .setPlaceholder('例如: D:/MediaArchive')
        .setValue(this.plugin.settings.externalMediaFolder)
        .onChange(async (value) => {
          this.plugin.settings.externalMediaFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('外置模式 (Pack-Out Mode)')
      .setDesc('移动：将文件从保险库剪切到外部目录；复制：保留原文件并复制到外部目录。')
      .addDropdown(dropdown => dropdown
        .addOption('move', '移动 (剪切)')
        .addOption('copy', '复制 (保留)')
        .setValue(this.plugin.settings.packOutMode)
        .onChange(async (value: 'move' | 'copy') => {
          this.plugin.settings.packOutMode = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('移动端工具栏按钮 (Mobile Toolbar Button)')
      .setDesc('在移动端编辑器工具栏上显示 DualLink 快捷按钮（仅在移动端有效）。')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showMobileToolbarButton)
        .onChange(async (value) => {
          this.plugin.settings.showMobileToolbarButton = value;
          await this.plugin.saveSettings();
        }));
  }
}
