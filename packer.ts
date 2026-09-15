/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Node.js内置模块成员访问 */
import { Notice, Modal, App, TFile, MarkdownView } from 'obsidian';
import { isMediaExt, isVideoExt, isAudioExt, isImageExt } from './constants';
import { encodeFileUriPath } from './path-utils';
import { blobUrlForFilePath, trackBlobNode } from './media-blob';
import { IDualLinkPlugin, VaultAdapter, MetadataCacheExt } from './types';
import { fs, path } from './node-modules';

// 配置目录名称（Obsidian 允许用户自定义，默认为 .obsidian）
const DEFAULT_CONFIG_DIR = '.obsidian';
// #13：递归查名结果缓存加容量上限，避免大库/多次操作下无界增长
const findFileCache = new Map<string, string | null>();
const FIND_FILE_CACHE_LIMIT = 512;

function cacheFindFile(cacheKey: string, value: string | null): void {
  findFileCache.set(cacheKey, value);
  if (findFileCache.size > FIND_FILE_CACHE_LIMIT) {
    const oldestKey = findFileCache.keys().next().value as string | undefined;
    if (oldestKey !== undefined) findFileCache.delete(oldestKey);
  }
}

function getSkipDirs(app?: App): Set<string> {
  const configDir = app?.vault?.configDir ?? DEFAULT_CONFIG_DIR;
  return new Set(['node_modules', '.git', configDir, '$RECYCLE.BIN', 'System Volume Information']);
}

/**
 * 整文件内容比对（#12 修复）：旧实现只读首 64KB + 比较大小，
 * 头部相同但后续不同的两个文件会被误判为同一文件，可能导致去重时跳过拷贝
 * 甚至剪走仍被引用的原件。改为等大小前提下的分块全量比对，遇首处差异即短路。
 */
export function isSameFile(path1: string, path2: string): boolean {
  let fd1: number | null = null;
  let fd2: number | null = null;
  try {
    const stat1 = fs.statSync(path1);
    const stat2 = fs.statSync(path2);
    if (stat1.size !== stat2.size) return false;
    if (stat1.size === 0) return true; // 两个空文件视为相同

    fd1 = fs.openSync(path1, 'r');
    fd2 = fs.openSync(path2, 'r');
    const BUF_SIZE = 65536;
    const buf1 = Buffer.allocUnsafe(BUF_SIZE);
    const buf2 = Buffer.allocUnsafe(BUF_SIZE);
    let remaining = stat1.size;
    while (remaining > 0) {
      const read1 = fs.readSync(fd1, buf1, 0, BUF_SIZE, null);
      const read2 = fs.readSync(fd2, buf2, 0, BUF_SIZE, null);
      if (read1 !== read2 || read1 === 0) return false;
      if (!buf1.slice(0, read1).equals(buf2.slice(0, read2))) return false;
      remaining -= read1;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd1 !== null) { try { fs.closeSync(fd1); } catch { /* ignore */ } }
    if (fd2 !== null) { try { fs.closeSync(fd2); } catch { /* ignore */ } }
  }
}

/**
 * 判断目标文件是否被「除当前笔记外」的其他文档引用。
 * 先走 metadataCache 精确判定（resolvedLinks/backlinks，天然覆盖带路径的引用）；
 * 仅在缓存未覆盖时回退为逐文件文本扫描——该扫描异步执行且解析每个
 * [[目标|别名#...]] 的目标段，同时匹配「裸文件名」与「完整库内路径」两种写法，
 * 修复旧实现只查 [[basename 而漏掉 [[文件夹/名.png]] 引用的问题。
 */
export async function hasOtherReferences(app: App, file: TFile, currentPath: string): Promise<boolean> {
  try {
    const metadataCache = app.metadataCache as unknown as MetadataCacheExt;
    const resolvedLinks = metadataCache.resolvedLinks;
    if (resolvedLinks) {
      for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
        if (sourcePath === currentPath) continue;
        if (links[file.path]) return true;
      }
    }
  } catch { /* metadataCache may not support resolvedLinks */ }

  try {
    const metadataCache = app.metadataCache as unknown as MetadataCacheExt;
    const backlinks = metadataCache.getBacklinksForFile?.(file);
    if (backlinks?.data) {
      for (const sourcePath of Object.keys(backlinks.data)) {
        if (sourcePath !== currentPath) return true;
      }
    }
  } catch { /* metadataCache may not support getBacklinksForFile */ }

  try {
    const vaultBase = (app.vault.adapter as unknown as VaultAdapter).getBasePath?.();
    if (!vaultBase) return false;

    const nameLower = file.name.toLowerCase();
    const pathLower = file.path.toLowerCase();
    const linkRe = /\[\[([^\]|#]+)/g;
    for (const mf of app.vault.getMarkdownFiles()) {
      if (mf.path === currentPath) continue;
      const lower = (await fs.promises.readFile(path.join(vaultBase, mf.path), 'utf8').catch(() => null))?.toLowerCase();
      if (!lower) continue;
      linkRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(lower)) !== null) {
        const target = m[1].trim();
        if (target === nameLower || target === pathLower) {
          return true;
        }
      }
    }
  } catch { /* readdirSync may fail on some directories */ }

  return false;
}

export function findFileRecursive(dir: string, targetName: string, maxDepth: number = 5, app?: App): string | null {
  const cacheKey = `${dir}::${targetName}::${maxDepth}`;
  if (findFileCache.has(cacheKey)) {
    return findFileCache.get(cacheKey) ?? null;
  }

  const skipDirs = getSkipDirs(app);
  const stack: { dirPath: string; depth: number }[] = [{ dirPath: dir, depth: 0 }];

  while (stack.length > 0) {
    const { dirPath, depth } = stack.pop() as { dirPath: string; depth: number } | undefined;
    if (!dirPath) break;
    const dirName = path.basename(dirPath);

    if (depth >= maxDepth || skipDirs.has(dirName)) continue;

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          stack.push({ dirPath: fullPath, depth: depth + 1 });
        } else if (entry.isFile() && entry.name === targetName) {
          cacheFindFile(cacheKey, fullPath);
          return fullPath;
        }
      }
    } catch (e) { /* directory read error, skip */ }
  }

  cacheFindFile(cacheKey, null);
  return null;
}

export async function findExternalFileRec(
  fileName: string,
  dir: string,
  maxDepth = 4,
  currentDepth = 0
): Promise<string | null> {
  if (currentDepth > maxDepth || !dir) return null;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = await findExternalFileRec(
          fileName,
          path.join(dir, entry.name),
          maxDepth,
          currentDepth + 1
        );
        if (found) return found;
      } else if (entry.name === fileName) {
        return path.join(dir, entry.name);
      }
    }
  } catch (e) { /* directory read error, skip */ }
  return null;
}

/* ===== 笔记内容改写提交（防丢稿）===== */

/** 找到指定笔记当前正以源码/Live Preview(可编辑)模式打开的视图 */
function findEditingViews(app: App, filePath: string): MarkdownView[] {
  const views: MarkdownView[] = [];
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === filePath && view.getMode() !== 'preview') {
      views.push(view);
    }
  }
  return views;
}

/** 按 old→new 全量替换（长串优先，保持原 sort+split/join 语义） */
function applyReplacements(content: string, replacements: { old: string; new: string }[]): string {
  const sorted = [...replacements].sort((a, b) => b.old.length - a.old.length);
  let out = content;
  for (const r of sorted) {
    out = out.split(r.old).join(r.new);
  }
  return out;
}

/**
 * 提交对笔记的一次"基于快照改写"写入：
 * - 笔记正在编辑(源码/Live Preview)时，以编辑器最新缓冲区为基准重放替换，
 *   经编辑器提交并落盘——避免直接改磁盘覆盖用户尚未保存的键入内容；
 * - 否则用 vault.process 原子改写磁盘，并对最新磁盘内容重放，避免覆盖并发修改。
 */
async function commitContentRewrite(
  plugin: IDualLinkPlugin,
  file: TFile,
  snapshot: string,
  replacements: { old: string; new: string }[]
): Promise<void> {
  const editingViews = findEditingViews(plugin.app, file.path);
  if (editingViews.length > 0) {
    const buffer = editingViews[0].editor.getValue();
    const finalContent = applyReplacements(buffer, replacements);
    for (const view of editingViews) {
      view.editor.setValue(finalContent);
    }
    await plugin.app.vault.modify(file, finalContent);
    return;
  }
  await plugin.app.vault.process(file, (data: string) =>
    data === snapshot ? applyReplacements(snapshot, replacements) : applyReplacements(data, replacements)
  );
}


export async function packToVault(plugin: IDualLinkPlugin): Promise<void> {
  const activeFile = plugin.app.workspace.getActiveFile();
  if (!activeFile) {
    new Notice('请先打开一个 Markdown 文档。');
    return;
  }

  // #1：笔记正在编辑(源码/Live Preview)时以编辑器缓冲区为基准，
  // 其内容可能比磁盘新，直接基于磁盘快照改写会覆盖用户尚未保存的键入内容。
  const editingViews = findEditingViews(plugin.app, activeFile.path);
  const content = editingViews.length > 0
    ? editingViews[0].editor.getValue()
    : await plugin.app.vault.read(activeFile);
  const vaultBasePath = (plugin.app.vault.adapter as any).getBasePath();

  const attachmentFolderCfg =
    ((plugin.app.vault as any).config?.attachmentFolderPath as string) || '.';
  let attachmentsDir: string;
  let attachmentVaultPrefix: string;

  if (attachmentFolderCfg.startsWith('./')) {
    const relFolder = attachmentFolderCfg.substring(2);
    const noteDir = path.dirname(path.join(vaultBasePath, activeFile.path));
    attachmentsDir = path.join(noteDir, relFolder);
    const noteVaultDir = path.dirname(activeFile.path);
    attachmentVaultPrefix = noteVaultDir === '.' ? relFolder : `${noteVaultDir}/${relFolder}`;
  } else if (attachmentFolderCfg === '.' || attachmentFolderCfg === './') {
    const noteDir = path.dirname(path.join(vaultBasePath, activeFile.path));
    attachmentsDir = noteDir;
    attachmentVaultPrefix = path.dirname(activeFile.path);
    if (attachmentVaultPrefix === '.') attachmentVaultPrefix = '';
  } else {
    attachmentsDir = path.join(vaultBasePath, attachmentFolderCfg);
    attachmentVaultPrefix = attachmentFolderCfg;
  }

  if (!fs.existsSync(attachmentsDir)) {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  }

  const replacements: { old: string; new: string }[] = [];
  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;
  const processed = new Set<string>();

  const getUniqueName = (dir: string, name: string): string => {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let candidate = name;
    let counter = 1;
    while (fs.existsSync(path.join(dir, candidate))) {
      candidate = `${base}_${counter}${ext}`;
      counter++;
    }
    return candidate;
  };

  const imgRegex = /!\[.*?\]\(<(file:\/\/\/|local-file:\/\/)([^>]+)>\)/g;
  const linkRegex = /(?<!!)\[.*?\]\(<(file:\/\/\/|local-file:\/\/)([^>]+)>\)/g;
  const mediaRegex = /<(video|audio)\s+src="(file:\/\/\/)([^"]+)"/g;

  for (const regex of [imgRegex, linkRegex, mediaRegex]) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      let extPath: string;
      if (match[1] === 'video' || match[1] === 'audio') {
        extPath = match[3];
      } else {
        extPath = match[2];
      }

      try { extPath = decodeURIComponent(extPath); } catch { /* invalid URI */ }
      extPath = extPath.replace(/\)$/, '').replace(/['">]/g, '').trim();

      if (processed.has(extPath)) continue;

      if (!fs.existsSync(extPath)) {
        skipCount++;
        processed.add(extPath);
        continue;
      }

      const fileName = path.basename(extPath);
      let finalName = fileName;
      const destPath = path.join(attachmentsDir, finalName);
      let shouldCopy = true;
      let existingVaultPath = '';

      if (fs.existsSync(destPath)) {
        existingVaultPath = destPath;
      } else {
        existingVaultPath = findFileRecursive(attachmentsDir, fileName) || '';
      }

      if (existingVaultPath) {
        if (isSameFile(extPath, existingVaultPath)) {
          shouldCopy = false;
          const rel = existingVaultPath
            .substring(attachmentsDir.length)
            .replace(/\\/g, '/')
            .replace(/^\//, '');
          finalName = rel;
        } else {
          const decision = await new Promise<'use-existing' | 'rename'>((resolve) => {
            new FileDedupModal(plugin, existingVaultPath, extPath, resolve).open();
          });
          if (decision === 'use-existing') {
            shouldCopy = false;
            const rel = existingVaultPath
              .substring(attachmentsDir.length)
              .replace(/\\/g, '/')
              .replace(/^\//, '');
            finalName = rel;
          } else {
            finalName = getUniqueName(attachmentsDir, fileName);
          }
        }
      }

      try {
        const internalPath = attachmentVaultPrefix
          ? `${attachmentVaultPrefix}/${finalName}`
          : finalName;
        const ext = path.extname(finalName).toLowerCase();
        const media = isMediaExt(ext);

        // #2：需要实际新增文件时改经 vault.createBinary 写入，
        // 让 Obsidian 立即登记新文件与父目录索引；替代原 fs.copyFileSync 直写库内
        // 后只能等待文件系统 watcher 被动发现而导致的索引/同步失步。
        if (shouldCopy) {
          const data = await fs.promises.readFile(extPath);
          const arrayBuffer =
            data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
              ? data.buffer as ArrayBuffer
              : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
          await plugin.app.vault.createBinary(internalPath, arrayBuffer);
        }

        replacements.push({
          old: match[0],
          new: media ? `![[${internalPath}]]` : `[[${internalPath}]]`,
        });
        successCount++;
      } catch (e) {
        failCount++;
      }
      processed.add(extPath);
    }
  }

  if (replacements.length === 0) {
    new Notice('DualIn: 未找到可打包的外部资源链接。');
    return;
  }

  await commitContentRewrite(plugin, activeFile, content, replacements);
  new Notice(`DualIn 完成：成功 ${successCount} 个，跳过 ${skipCount} 个，失败 ${failCount} 个。`);
}

export async function packOut(plugin: IDualLinkPlugin): Promise<void> {
  const activeFile = plugin.app.workspace.getActiveFile();
  if (!activeFile) {
    new Notice('请先打开一个 Markdown 文档。');
    return;
  }

  let externalDir = plugin.settings.externalMediaFolder;
  if (!externalDir) {
    new Notice('请在插件设置中配置"外部媒体归档目录"，或稍后设置后再试。');
    return;
  }

  if (!fs.existsSync(externalDir)) {
    fs.mkdirSync(externalDir, { recursive: true });
  }

  const isCopyMode = plugin.settings.packOutMode === 'copy';

  // #1：笔记正在编辑(源码/Live Preview)时以编辑器缓冲区为基准，
  // 其内容可能比磁盘新，直接基于磁盘快照改写会覆盖用户尚未保存的键入内容。
  const editingViews = findEditingViews(plugin.app, activeFile.path);
  const content = editingViews.length > 0
    ? editingViews[0].editor.getValue()
    : await plugin.app.vault.read(activeFile);
  const vaultBasePath = (plugin.app.vault.adapter as any).getBasePath();

  const replacements: { old: string; new: string }[] = [];
  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;
  let copyCount = 0;
  const processed = new Set<string>();
  // #2：剪出语义下待删除的库内原件，统一在笔记内容改写成功后经 vault.delete 删除，
  // 让 Obsidian 文件索引/元数据缓存同步更新，避免 fs.unlink + 手动 trigger 的失步。
  const pendingVaultDeletes: TFile[] = [];
  const queuedDeletePaths = new Set<string>();

  const getUniqueName = (dir: string, name: string): string => {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let candidate = name;
    let counter = 1;
    while (fs.existsSync(path.join(dir, candidate))) {
      candidate = `${base}_${counter}${ext}`;
      counter++;
    }
    return candidate;
  };

  const internalLinkRegex = /!\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = internalLinkRegex.exec(content)) !== null) {
    const linkPath = match[1].split('|')[0].trim();
    if (processed.has(linkPath)) continue;

    const dest = plugin.app.metadataCache.getFirstLinkpathDest(linkPath, activeFile.path);
    if (!dest) {
      skipCount++;
      processed.add(linkPath);
      continue;
    }

    // #6：仅外置媒体(图片/音/视频)。PDF 等嵌入与非媒体转义(如 ![[其他笔记]])
    // 保持原样，否则会被当成图片重写为损坏的 file:/// 语法，甚至误删仍被引用的笔记文件。
    if (!isMediaExt(dest.extension.toLowerCase())) {
      skipCount++;
      processed.add(linkPath);
      continue;
    }

    const srcFullPath = path.join(vaultBasePath, dest.path);
    if (!fs.existsSync(srcFullPath)) {
      skipCount++;
      processed.add(linkPath);
      continue;
    }

    const fileName = path.basename(dest.path);
    const destFullPath = path.join(externalDir, fileName);

    const hasOtherRefs = await hasOtherReferences(plugin.app, dest, activeFile.path);
    const forceCopyForFile = hasOtherRefs && !isCopyMode;
    if (hasOtherRefs) {
      new Notice(`⚠️ "${fileName}" 被其他文档引用，将复制而非剪切到外部目录。`, 5000);
    }

    let finalName = fileName;
    let existingExtPath = '';
    let skipMove = false;

    if (fs.existsSync(destFullPath)) {
      existingExtPath = destFullPath;
    } else {
      existingExtPath = findFileRecursive(externalDir, fileName) || '';
    }

    if (existingExtPath) {
      if (isSameFile(srcFullPath, existingExtPath)) {
        skipMove = true;
        finalName = existingExtPath
          .substring(externalDir.length)
          .replace(/\\/g, '/')
          .replace(/^\//, '');
        if (!isCopyMode && !forceCopyForFile && !queuedDeletePaths.has(dest.path)) {
          queuedDeletePaths.add(dest.path);
          pendingVaultDeletes.push(dest);
        }
      } else {
        finalName = getUniqueName(externalDir, fileName);
        new Notice(`⚠️ "${fileName}" 与外部目录已有同名不同内容的文件，已重命名为 "${finalName}"。`, 5000);
      }
    }

    const finalDestPath = path.join(externalDir, finalName);
    try {
      if (!skipMove) {
        // 先把文件字节安全写入外部目录（外部目录非库内，属原生磁盘操作）。
        // 原实现在此直接 fs.rename/unlink 剪走库内文件再手动 trigger('delete')，
        // 会绕过 Obsidian 的文件索引与元数据缓存；改为仅做外部落盘，
        // 库内原件留到内容改写成功后统一经 vault.delete 处理。
        fs.copyFileSync(srcFullPath, finalDestPath);
        if (!isCopyMode && !forceCopyForFile && !queuedDeletePaths.has(dest.path)) {
          queuedDeletePaths.add(dest.path);
          pendingVaultDeletes.push(dest);
        }
      }

      const ext = path.extname(finalName).toLowerCase();
      const encodedPath = encodeFileUriPath(finalDestPath);

      let newSyntax: string;
      if (isVideoExt(ext)) {
        newSyntax = `![🎬 ${finalName}](<file:///${encodedPath}>)`;
      } else if (isAudioExt(ext)) {
        newSyntax = `![🎵 ${finalName}](<file:///${encodedPath}>)`;
      } else {
        newSyntax = `![🖼 ${finalName}](<file:///${encodedPath}>)`;
      }

      replacements.push({ old: match[0], new: newSyntax });
      successCount++;
      if (hasOtherRefs) copyCount++;
    } catch { /* replacement failed */ }
    processed.add(linkPath);
  }

  if (replacements.length === 0) {
    new Notice('DualOut: 未找到可外置的内部媒体链接。');
    return;
  }

  await commitContentRewrite(plugin, activeFile, content, replacements);

  // 内容已改写为指向外部文件，此时才删除被剪出的库内原件。
  // 删除失败(如已被外部程序清理/权限)时留下库内副本，链接已指向外部副本，不造成丢失。
  for (const f of pendingVaultDeletes) {
    try {
      await plugin.app.vault.delete(f);
    } catch { /* 删除失败时保留库内副本 */ }
  }

  const copyMsg = copyCount > 0 ? `，其中 ${copyCount} 个被其他文档引用已复制保留` : '';
  new Notice(`DualOut 完成：成功 ${successCount} 个${copyMsg}，跳过 ${skipCount} 个，失败 ${failCount} 个。`);
}

class FileDedupModal extends Modal {
  private resolve: (value: 'use-existing' | 'rename') => void;
  private existingPath: string;
  private newPath: string;
  private plugin: IDualLinkPlugin;

  constructor(
    plugin: IDualLinkPlugin,
    existingPath: string,
    newPath: string,
    resolve: (value: 'use-existing' | 'rename') => void
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.existingPath = existingPath;
    this.newPath = newPath;
    this.resolve = resolve;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('duallink-dedup-content');

    contentEl.createEl('h3', { text: '发现同名文件' });
    contentEl.createEl('p', { text: '保险库中已存在同名文件，请确认是否与此文件相同：', cls: 'duallink-dedup-desc' });

    const previewRow = contentEl.createEl('div', { cls: 'duallink-dedup-preview-row' });

    const leftCol = previewRow.createEl('div', { cls: 'duallink-dedup-preview-col' });
    leftCol.createEl('div', { text: '保险库已有', cls: 'duallink-dedup-preview-title' });
    this.renderFilePreview(leftCol, this.existingPath);

    const rightCol = previewRow.createEl('div', { cls: 'duallink-dedup-preview-col' });
    rightCol.createEl('div', { text: '即将导入', cls: 'duallink-dedup-preview-title' });
    this.renderFilePreview(rightCol, this.newPath);

    const infoRow = contentEl.createEl('div', { cls: 'duallink-dedup-info-row' });
    for (const p of [this.existingPath, this.newPath]) {
      const col = infoRow.createEl('div', { cls: 'duallink-dedup-info-col' });
      try {
        const stat = fs.statSync(p);
        col.createEl('div', { text: `${(stat.size / 1024).toFixed(1)} KB` });
        col.createEl('div', { text: stat.mtime.toLocaleString() });
      } catch { /* stat failed */ }
    }

    const btnRow = contentEl.createEl('div', { cls: 'duallink-dedup-btn-row' });

    const sameBtn = btnRow.createEl('button', { cls: 'duallink-dedup-btn--primary' });
    sameBtn.textContent = '是同一个文件，使用现有';
    sameBtn.addEventListener('click', () => {
      this.resolve('use-existing');
      this.close();
    });

    const renameBtn = btnRow.createEl('button', { cls: 'duallink-dedup-btn--secondary' });
    renameBtn.textContent = '是不同的文件，重命名导入';
    renameBtn.addEventListener('click', () => {
      this.resolve('rename');
      this.close();
    });

    activeDocument.addEventListener('keydown', this.escHandler);
  }

  private escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      this.resolve('rename');
      this.close();
    }
  };

  onClose() {
    activeDocument.removeEventListener('keydown', this.escHandler);
    this.contentEl.empty();
  }

  private renderFilePreview(container: HTMLElement, filePath: string) {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const image = isImageExt(ext);

    if (image) {
      try {
        const blobUrl = blobUrlForFilePath(filePath);
        if (blobUrl) {
          const img = container.createEl('img', { cls: 'duallink-dedup-preview-img' });
          img.src = blobUrl;
          trackBlobNode(img, blobUrl);
        }
      } catch { /* preview failed */ }
    } else {
      const icon = container.createEl('div', { text: '📄', cls: 'duallink-dedup-preview-icon' });
      container.createEl('div', { text: path.basename(filePath), cls: 'duallink-dedup-preview-name' });
    }
  }
}

/* ===== 失效外部文件自动重定位（根目录名称/盘符变化后找回）===== */
// 缓存：`新根::文件名` → Promise<最优路径 | null>。会话内缓存并限制大小，避免大目录反复扫描；
// 未命中结果同样入缓存（结构与文件名都检索不到时，短期内重试无意义）。
const relocateCache = new Map<string, Promise<string | null>>();
const RELOCATE_CACHE_LIMIT = 256;

/**
 * 与主插件生成链接一致的路径分段编码（保留盘符冒号）。
 * 用于在笔记源码文本中匹配/生成 URL 编码形式的路径片段。
 */
export function encodeExternalPathText(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const encoded = normalized.split('/').map(c => encodeURIComponent(c)).join('/');
  return encoded.replace(/^([a-zA-Z])%3A/, '$1:');
}

/**
 * 结构化匹配：在新根下逐级尝试「旧路径去掉前若干段后剩余的相对后缀」。
 * 盘符变化、整棵子树平移但目录结构保留时，能以最小开销精确命中。
 */
function locateByRelativeStructure(oldPath: string, newRoot: string): string | null {
  const comps = oldPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (comps.length === 0) return null;
  // Windows 盘符段（如 E:）不参与后缀拼接
  const startIndex = comps[0].length === 2 && comps[0][1] === ':' ? 1 : 0;
  for (let i = startIndex; i < comps.length; i++) {
    const suffix = comps.slice(i).join('/');
    const candidate = path.join(newRoot, suffix);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* 该层级不存在，继续尝试更短的相对后缀 */ }
  }
  return null;
}

/**
 * 按文件名递归扫描新根及其全部子文件夹；同名多命中时，
 * 自动选择「从文件向根的目录链」与旧路径最接近（结构相似度最高）的一个。
 */
async function locateByFileName(oldPath: string, newRoot: string, skipDirs: Set<string>): Promise<string | null> {
  const targetName = path.basename(oldPath).toLowerCase();
  const oldDirLeafUp = oldPath.replace(/\\/g, '/').split('/').filter(Boolean);
  oldDirLeafUp.pop();

  let bestPath: string | null = null;
  let bestScore = -1;
  let bestDepthDiff = Number.POSITIVE_INFINITY;
  const stack: string[] = [newRoot];

  while (stack.length > 0) {
    const dirPath = stack.pop() as string;
    let entries;
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch { /* 无权限目录，跳过 */ continue; }
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === targetName) {
        const candDirLeafUp = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
        candDirLeafUp.pop();
        let score = 0;
        while (
          score < candDirLeafUp.length &&
          score < oldDirLeafUp.length &&
          candDirLeafUp[candDirLeafUp.length - 1 - score].toLowerCase() ===
            oldDirLeafUp[oldDirLeafUp.length - 1 - score].toLowerCase()
        ) {
          score++;
        }
        const depthDiff = Math.abs(candDirLeafUp.length - oldDirLeafUp.length);
        if (bestPath === null || score > bestScore || (score === bestScore && depthDiff < bestDepthDiff)) {
          bestPath = fullPath;
          bestScore = score;
          bestDepthDiff = depthDiff;
        }
      }
    }
  }
  return bestPath;
}

/**
 * 失效外部文件重定位（面向「根目录名称/盘符变化」场景）：
 * 1) 优先在新根下按旧路径的相对结构精确命中（结构保留时开销极低）；
 * 2) 结构对不上时，递归扫描新根全部子文件夹按文件名检索，
 *    同名冲突自动选择目录结构最接近者；
 * 3) 均未命中返回 null（调用方保持原行为，不做任何改动）。
 */
export function relocateMissingFile(oldPath: string, newRoot: string, app?: App): Promise<string | null> {
  const cleanRoot = (newRoot || '').trim();
  if (!oldPath || !cleanRoot) return Promise.resolve(null);

  const structural = locateByRelativeStructure(oldPath, cleanRoot);
  if (structural) return Promise.resolve(structural);

  const cacheKey = `${cleanRoot}::${path.basename(oldPath).toLowerCase()}`;
  const cached = relocateCache.get(cacheKey);
  if (cached) return cached;

  const skipDirs = getSkipDirs(app);
  const task = locateByFileName(oldPath, cleanRoot, skipDirs);
  relocateCache.set(cacheKey, task);
  if (relocateCache.size > RELOCATE_CACHE_LIMIT) {
    const oldestKey = relocateCache.keys().next().value as string | undefined;
    if (oldestKey !== undefined) relocateCache.delete(oldestKey);
  }
  return task;
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access -- 恢复 no-unsafe-member-access 检查 */
