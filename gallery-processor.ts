/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Node.js 内置模块 (fs/path) 成员访问，ESLint 无法跨模块解析其类型 */
import { MarkdownRenderer, MarkdownPostProcessorContext, MarkdownView, Notice, setIcon, TFile } from 'obsidian';
import { isImageExt, isVideoExt, isAudioExt, isMediaExt } from './constants';
import { IDualLinkPlugin } from './types';
import { fs, path } from './node-modules';
import { blobUrlForFilePath, trackBlobNode } from './media-blob';
import { safeDecodeURIComponent, vaultRelativeFromAbsolute, encodeFileUriPath } from './path-utils';

interface IGalleryPathPromptModal {
  new(plugin: IDualLinkPlugin, defaultName: string, onSubmit: (path: string, name?: string) => void): { open(): void };
}

function addGalleryItemButtons(
    item: HTMLDivElement,
    images: string[],
    index: number,
    columns: number,
    plugin: IDualLinkPlugin,
    el: HTMLElement,
    updateCodeBlock: (newColumns: number, newImages: string[]) => Promise<void>,
    PathPromptModal: IGalleryPathPromptModal
) {
    const editImageBtn = item.createDiv({
        text: '\u270e',
        cls: 'duallink-gallery-item-btn duallink-gallery-item-btn--edit',
        title: '\u66ff\u6362\u6b64\u56fe\u7247'
    });

    const removeBtn = item.createDiv({
        text: '\u2715',
        cls: 'duallink-gallery-item-btn duallink-gallery-item-btn--remove',
        title: '\u79fb\u9664\u6b64\u56fe\u7247'
    });

    item.addEventListener('mouseenter', () => {
        if (el.closest('.markdown-reading-view')) return;
        removeBtn.addClass('duallink-gallery-item-btn--visible');
        editImageBtn.addClass('duallink-gallery-item-btn--visible');
    });
    item.addEventListener('mouseleave', () => {
        removeBtn.removeClass('duallink-gallery-item-btn--visible');
        editImageBtn.removeClass('duallink-gallery-item-btn--visible');
    });

    removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (el.closest('.markdown-reading-view')) return;
        const newImages = [...images];
        newImages.splice(index, 1);
        void updateCodeBlock(columns, newImages);
    });

    editImageBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (el.closest('.markdown-reading-view')) return;
        if (!fs) {
            new Notice('插入/替换本地文件仅支持桌面版 Obsidian。');
            return;
        }
        const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;

        new PathPromptModal(plugin, '', (inputPath: string) => {
            if (!inputPath) return;
            const cleanP = inputPath.replace(/['"]/g, '').trim();
            const internalPath = vaultRelativeFromAbsolute(plugin.app, cleanP);
            let newSyntax = '';
            if (internalPath !== null) {
                newSyntax = `![[${internalPath}]]`;
            } else {
                newSyntax = `![](<file:///${encodeFileUriPath(cleanP)}>)`;
            }
            const newImages = [...images];
            newImages[index] = newSyntax;
            void updateCodeBlock(columns, newImages);
        }).open();
    });
}

export function registerGalleryProcessor(plugin: IDualLinkPlugin, PathPromptModal: IGalleryPathPromptModal): void {
    plugin.app.workspace.onLayoutReady(() => {
      plugin.registerMarkdownCodeBlockProcessor('duallink-gallery', (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        const lines = source.split('\n');
        let columns = 3;
        const images: string[] = [];
        let isConfig = true;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (isConfig && trimmed.startsWith('{')) {
                try {
                    const config = JSON.parse(trimmed) as { columns?: number } | null;
                    if (config?.columns) columns = config.columns;
                } catch { /* invalid JSON config, skip */ }
                isConfig = false;
            } else {
                isConfig = false;
                images.push(trimmed);
            }
        }

        el.addClass('duallink-gallery-container');

        const updateCodeBlock = async (newColumns: number, newImages: string[]) => {
            const info = ctx.getSectionInfo(el);
            if (!info) {
                new Notice('\u65e0\u6cd5\u83b7\u53d6\u533a\u5757\u5728\u6587\u6863\u4e2d\u7684\u884c\u53f7\uff0c\u8bf7\u786e\u4fdd\u6587\u6863\u5df2\u88ab\u6b63\u786e\u89e3\u6790\u3002');
                return;
            }
            const newContent = `\`\`\`duallink-gallery\n{ "columns": ${newColumns} }\n${newImages.join('\n')}\n\`\`\``;

            // #4：列数增减/增删图/拖拽排序都经由此处改写源码。
            // 必须按 ctx.sourcePath 定位真正在编辑该文档的视图(源码/Live Preview)，
            // 不能用全局活动视图——否则图库所在笔记不是活动笔记时，
            // 会把另一篇打开笔记的同一行区间误写成 gallery 代码块。
            const editingView =
                plugin.app.workspace
                    .getLeavesOfType('markdown')
                    .map((leaf) => leaf.view)
                    .find(
                        (view): view is MarkdownView =>
                            view instanceof MarkdownView &&
                            view.file?.path === ctx.sourcePath &&
                            view.getMode() !== 'preview'
                    ) ?? null;

            if (editingView) {
                const e = editingView.editor;
                e.replaceRange(
                    newContent,
                    { line: info.lineStart, ch: 0 },
                    { line: info.lineEnd, ch: e.getLine(info.lineEnd).length }
                );
                return;
            }

            // 无对应编辑视图(如笔记仅以阅读视图打开)时，回退到对该文档的原子磁盘改写。
            const targetFile = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
            if (targetFile instanceof TFile) {
                await plugin.app.vault.process(targetFile, (data: string) => {
                    const lines = data.split('\n');
                    lines.splice(info.lineStart, info.lineEnd - info.lineStart + 1, newContent);
                    return lines.join('\n');
                });
            }
        };

        window.setTimeout(() => {
            void (async () => {
                let hasFixes = false;
                const newImages = [...images];
                for (let i = 0; i < newImages.length; i++) {
                    const imgSource = newImages[i];
                    const internalMatch = imgSource.match(/!\[\[(.*?)\]\]/);
                    if (internalMatch) {
                        const linkText = internalMatch[1].split('|')[0];
                        const dest = plugin.app.metadataCache.getFirstLinkpathDest(linkText, ctx.sourcePath);
                        if (!dest) {
                            const fileName = linkText.split(/[/\\]/).pop();
                            if (fileName) {
                                const fallbackDest = plugin.app.metadataCache.getFirstLinkpathDest(fileName, ctx.sourcePath);
                                if (fallbackDest) {
                                    hasFixes = true;
                                    const newLinkText = fallbackDest.path + (internalMatch[1].includes('|') ? '|' + internalMatch[1].split('|')[1] : '');
                                    newImages[i] = imgSource.replace(internalMatch[1], newLinkText);
                                }
                            }
                        }
                        continue;
                    }

                    const externalMatch = imgSource.match(/!\[.*?\]\(<file:\/\/\/(.*?)>\)/) || imgSource.match(/!\[.*?\]\(file:\/\/\/(.*?)\)/);
                    if (externalMatch) {
                    const rawPath = safeDecodeURIComponent(externalMatch[1]);
                    if (fs && !fs.existsSync(rawPath) && plugin.settings.defaultFolderPath) {
                        const fileName = path.basename(rawPath);
                        const newPath = await plugin.findExternalFileRec(fileName, plugin.settings.defaultFolderPath, 4, 0);
                        if (newPath) {
                            hasFixes = true;
                            newImages[i] = imgSource.replace(externalMatch[1], encodeFileUriPath(newPath));
                        }
                    }
                    continue;
                }
            }
            if (hasFixes) {
                void updateCodeBlock(columns, newImages);
            }
            })();
        }, 100);

        const galleryWrapper = el.createDiv();
        galleryWrapper.className = 'duallink-gallery-wrapper';

        const grid = galleryWrapper.createDiv();
        grid.className = 'duallink-gallery-grid';

        const colEls: HTMLElement[] = [];
        for (let i = 0; i < columns; i++) {
            const col = grid.createDiv();
            col.className = 'duallink-gallery-col';
            colEls.push(col);
        }

        // 列控制按钮 (左侧)
        const colControls = galleryWrapper.createDiv({ cls: 'duallink-gallery-col-ctrl duallink-gallery-col-ctrl--left duallink-gallery-control' });

        const createColBtn = (text: string, title: string, onClick: () => void) => {
            const btn = colControls.createEl('button', { text, title });
            btn.className = 'duallink-gallery-col-btn';
            btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        };

        createColBtn('-', '\u51cf\u5c11\u5217\u6570', () => { if (columns > 1) void updateCodeBlock(columns - 1, images); });
        createColBtn('+', '\u589e\u52a0\u5217\u6570', () => { if (columns < 8) void updateCodeBlock(columns + 1, images); });

        // 添加按钮 (右侧)
        const addControls = galleryWrapper.createDiv({ cls: 'duallink-gallery-col-ctrl duallink-gallery-col-ctrl--right duallink-gallery-control' });

        const addBtn = addControls.createEl('button', { 
          cls: 'duallink-gallery-col-btn duallink-gallery-col-btn--add',
          title: '\u6dfb\u52a0\u65b0\u56fe\u7247' 
        });
        setIcon(addBtn, 'plus');

        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (el.closest('.markdown-reading-view')) return;
            if (!fs) {
                new Notice('插入本地文件仅支持桌面版 Obsidian。');
                return;
            }

            const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view) return;

            new PathPromptModal(plugin, '', (inputPath: string) => {
                if (!inputPath) return;
                const cleanP = inputPath.replace(/['"]/g, '').trim();
                const internalPath = vaultRelativeFromAbsolute(plugin.app, cleanP);
                let newSyntax = '';
                if (internalPath !== null) {
                    newSyntax = `![[${internalPath}]]`;
                } else {
                    newSyntax = `![](<file:///${encodeFileUriPath(cleanP)}>)`;
                }
                void updateCodeBlock(columns, [...images, newSyntax]);
            }).open();
        });

        galleryWrapper.addEventListener('mouseenter', () => {
            if (!el.closest('.markdown-reading-view')) {
                colControls.addClass('duallink-gallery-control--visible');
                addControls.addClass('duallink-gallery-control--visible');
            }
        });
        galleryWrapper.addEventListener('mouseleave', () => {
            colControls.removeClass('duallink-gallery-control--visible');
            addControls.removeClass('duallink-gallery-control--visible');
        });

        const items: HTMLElement[] = [];
        let lastLayout = '';

        const distributeItems = () => {
            const colHeights = new Array<number>(columns).fill(0);
            const targetCols = new Array(items.length);

            items.forEach((it, idx) => {
                let shortestIdx = 0;
                let minHeight = colHeights[0];
                for (let i = 1; i < columns; i++) {
                    if (colHeights[i] < minHeight) {
                        minHeight = colHeights[i];
                        shortestIdx = i;
                    }
                }
                targetCols[idx] = shortestIdx;
                const h = it.getBoundingClientRect().height;
                colHeights[shortestIdx] += (h > 0 ? h : 100) + 12;
            });

            const newLayout = targetCols.join(',');
            if (lastLayout !== newLayout) {
                lastLayout = newLayout;
                const colCounters = new Array(columns).fill(0);
                targetCols.forEach((colIdx, itemIdx) => {
                    const targetCol = colEls[colIdx];
                    const currentElement = items[itemIdx];
                    const expectedIndex = colCounters[colIdx]++;

                    if (targetCol.children[expectedIndex] !== currentElement) {
                        const referenceNode = targetCol.children[expectedIndex] || null;
                        targetCol.insertBefore(currentElement, referenceNode);
                    }
                });
            }
        };

        let rafId: number | null = null;
        const resizeObserver = new ResizeObserver(() => {
            if (rafId) return;
            rafId = window.requestAnimationFrame(() => {
                  rafId = null;
                  distributeItems();
              });
        });

        images.forEach((imgSource, index) => {
            const item = createDiv();
            items.push(item);
            resizeObserver.observe(item);

            item.className = 'duallink-gallery-item';

            const urlMatch = imgSource.match(/(?:file:\/\/\/|local-file:\/\/|\]\])([^)"'<>]+)/);
            const urlForExt = urlMatch ? urlMatch[1] : imgSource;
            const isAudioOnly = isAudioExt(urlForExt.split('.').pop() || '');

            if (!isAudioOnly) {
                item.addClass('duallink-gallery-item--visual');
            } else {
                item.addClass('duallink-gallery-item--audio');
            }

            item.draggable = true;
            item.addEventListener('dragstart', (e) => {
                e.stopPropagation();
                if (e.dataTransfer) {
                    e.dataTransfer.setData('duallink-gallery-index', index.toString());
                    e.dataTransfer.effectAllowed = 'move';
                }
                window.setTimeout(() => {
                    item.addClass('duallink-gallery-item--dragging');
                }, 0);
            });
            item.addEventListener('dragend', () => {
                item.removeClass('duallink-gallery-item--dragging');
                if (!isAudioOnly) {
                    item.addClass('duallink-gallery-item--normal-border');
                } else {
                    item.addClass('duallink-gallery-item--no-border');
                }
            });
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                item.addClass('duallink-gallery-item--drag-over');
            });
            item.addEventListener('dragleave', () => {
                item.removeClass('duallink-gallery-item--drag-over');
                if (!isAudioOnly) {
                    item.addClass('duallink-gallery-item--normal-border');
                } else {
                    item.addClass('duallink-gallery-item--no-outline');
                }
            });
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.removeClass('duallink-gallery-item--drag-over');
                item.addClass('duallink-gallery-item--normal-border');
                if (!e.dataTransfer) return;

                const originIndexStr = e.dataTransfer.getData('duallink-gallery-index');
                if (!originIndexStr) return;

                const originIndex = parseInt(originIndexStr, 10);
                if (originIndex === index || isNaN(originIndex)) return;

                const newImages = [...images];
                const [draggedImg] = newImages.splice(originIndex, 1);
                newImages.splice(index, 0, draggedImg);
                void updateCodeBlock(columns, newImages);
            });

            item.addEventListener('mouseenter', () => {
                if (el.closest('.markdown-reading-view')) return;
                item.addClass('duallink-gallery-item--scaled');
            });
            item.addEventListener('mouseleave', () => {
                if (el.closest('.markdown-reading-view')) return;
                item.removeClass('duallink-gallery-item--scaled');
            });

            item.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                const media = item.querySelector('img, video');
                if (!media) return;

                const overlay = activeDocument.body.createDiv();
                overlay.className = 'duallink-gallery-overlay';

                let clone: HTMLElement;
                if (media.tagName.toLowerCase() === 'img') {
                    clone = createEl('img');
                    (clone as HTMLImageElement).src = (media as HTMLImageElement).src;
                } else {
                    clone = createEl('video');
                    (clone as HTMLVideoElement).src = (media as HTMLVideoElement).src;
                    (clone as HTMLVideoElement).controls = true;
                    (clone as HTMLVideoElement).autoplay = true;
                }
                clone.className = 'duallink-gallery-overlay-media';

                clone.addEventListener('click', (e2) => { e2.stopPropagation(); });
                overlay.appendChild(clone);

                const closeBtn = overlay.createDiv({ text: '\u2715' });
                closeBtn.className = 'duallink-gallery-overlay-close';

                // #9：DOM 没有原生 'remove' 事件，旧实现依赖 overlay 的 'remove' 事件去
                // 注销 Escape 监听会永不触发，导致每次双击预览都向 document 泄漏一个监听器。
                // 改为单一 onEsc 处理器，Esc 与点击遮罩两条关闭路径都显式注销后移除。
                const onEsc = (e2: KeyboardEvent) => {
                    if (e2.key === 'Escape') {
                        activeDocument.removeEventListener('keydown', onEsc);
                        overlay.remove();
                    }
                };
                overlay.addEventListener('click', () => {
                    activeDocument.removeEventListener('keydown', onEsc);
                    overlay.remove();
                });
                activeDocument.addEventListener('keydown', onEsc);
            });

            addGalleryItemButtons(item, images, index, columns, plugin, el, updateCodeBlock, PathPromptModal);

            {
                let mediaSrc = '';
                let mediaType = '';
                // 外部文件读取失败时静默降级（文件被删除/移动/无权限等），不再逐条 console.error
                let externalReadFailed = false;
                let failedExternalPath = '';
                const cleanSrc = imgSource.replace(/[)>]+$/, '').replace(/^!\[.*?\]\(<?/, '').replace(/^!\[\[/, '');
                const ext = cleanSrc.split('.').pop()?.toLowerCase() || '';

                if (isVideoExt(ext)) mediaType = 'video';
                else if (isAudioExt(ext)) mediaType = 'audio';
                else if (isImageExt(ext)) mediaType = 'image';

                const internalMatch = imgSource.match(/!\[\[(.*?)\]\]/);
                const standardMatch = imgSource.match(/!\[.*?\]\((?!file:\/\/|local-file:\/\/)(.*?)\)/);

                let linkPath = '';
                if (internalMatch) {
                    linkPath = internalMatch[1].split('|')[0].trim();
                } else if (standardMatch) {
                    linkPath = standardMatch[1].split(' ')[0].trim();
                }

                if (linkPath) {
                    try { linkPath = decodeURIComponent(linkPath); } catch { /* invalid URI, keep original */ }

                    let dest = plugin.app.metadataCache.getFirstLinkpathDest(linkPath, ctx.sourcePath);
                    if (!dest) {
                        const abstractFile = plugin.app.vault.getAbstractFileByPath(linkPath);
                        if (abstractFile && abstractFile instanceof TFile) {
                            dest = abstractFile;
                        }
                    }
                    if (!dest) {
                        const targetName = linkPath.split('/').pop()?.toLowerCase() || linkPath.toLowerCase();
                        const files = plugin.app.vault.getFiles();
                        dest = files.find(f => f.name.toLowerCase() === targetName || f.path.toLowerCase() === linkPath.toLowerCase()) || null;
                    }

                    if (dest) {
                        mediaSrc = plugin.app.vault.getResourcePath(dest);
                    }
                }

                if (!mediaSrc) {
                    let externalPath = '';
                    const externalMatch = imgSource.match(/!\[.*?\]\(<file:\/\/\/(.*?)>\)/) || imgSource.match(/!\[.*?\]\(file:\/\/\/(.*?)\)/) || imgSource.match(/!\[.*?\]\(<local-file:\/\/(.*?)>\)/) || imgSource.match(/!\[.*?\]\(local-file:\/\/(.*?)\)/);
                    if (externalMatch) {
                        externalPath = externalMatch[1];
                    } else if (imgSource.includes('local-file://') || imgSource.includes('file://')) {
                        const m = imgSource.match(/(?:local-file|file):\/\/\/?([^)"'<>]+)/);
                        if (m) externalPath = m[1];
                    }
                    if (externalPath) {
                        try { externalPath = decodeURIComponent(externalPath); } catch { /* invalid URI, keep original */ }
                        const ext = externalPath.split('.').pop()?.toLowerCase() || '';
                        if (!fs || !fs.existsSync(externalPath)) {
                            // 文件不存在/不可读时标记为占位，交由下方统一渲染，避免控制台刷屏与 file:// 二次 404
                            externalReadFailed = true;
                            failedExternalPath = externalPath;
                        } else if (isMediaExt(ext)) {
                            // #3：经统一工具创建 Blob(节点被 DOM 移除时自动 revoke)
                            const blobUrl = blobUrlForFilePath(externalPath);
                            if (blobUrl) {
                                mediaSrc = blobUrl;
                            } else {
                                externalReadFailed = true;
                                failedExternalPath = externalPath;
                            }
                        }
                    }
                }

                if (mediaSrc) {
                    item.empty();
                    if (mediaType === 'video') {
                        const video = createEl('video');
                        video.src = mediaSrc;
                        video.controls = false;
                        video.addEventListener('mouseenter', () => video.controls = true);
                        video.addEventListener('mouseleave', () => video.controls = false);
                        video.setAttribute('controlslist', 'nodownload');
                        video.setAttribute('draggable', 'false');
                        video.className = 'duallink-gallery-media duallink-gallery-media--cover';
                        item.appendChild(video);
                        trackBlobNode(video, mediaSrc);
                    } else if (mediaType === 'audio') {
                        const audio = createEl('audio');
                        audio.src = mediaSrc;
                        audio.controls = true;
                        audio.setAttribute('draggable', 'false');
                        audio.className = 'duallink-gallery-media duallink-gallery-media--audio';
                        item.appendChild(audio);
                        trackBlobNode(audio, mediaSrc);
                    } else {
                        const img = createEl('img');
                        img.src = mediaSrc;
                        img.loading = 'lazy';
                        img.decoding = 'async';
                        img.setAttribute('draggable', 'false');
                        img.className = 'duallink-gallery-media duallink-gallery-media--cover duallink-gallery-media--img';
                        item.appendChild(img);
                        trackBlobNode(img, mediaSrc);
                    }
                    addGalleryItemButtons(item, images, index, columns, plugin, el, updateCodeBlock, PathPromptModal);
                } else if (externalReadFailed) {
                    // 外部文件缺失/不可读：渲染占位，不再回退 markdown 以免产生 file:// 二次 404
                    const missingBox = createDiv();
                    missingBox.className = 'duallink-gallery-missing';
                    missingBox.title = failedExternalPath || imgSource;
                    const missingIcon = createDiv();
                    missingIcon.className = 'duallink-gallery-missing--icon';
                    setIcon(missingIcon, 'image-off');
                    const missingName = createSpan();
                    missingName.className = 'duallink-gallery-missing--name';
                    missingName.textContent = (failedExternalPath.split(/[\\/]/).pop() || '文件缺失');
                    missingBox.appendChild(missingIcon);
                    missingBox.appendChild(missingName);
                    item.appendChild(missingBox);
                } else {
                    // MarkdownRenderer.render 的迁移需要重构，此处暂用已废弃的 renderMarkdown（返回的 Promise 无需等待）
                    void MarkdownRenderer.renderMarkdown(imgSource, item, ctx.sourcePath, plugin as unknown as import('obsidian').Component);

                    window.setTimeout(() => {
                        const medias = item.querySelectorAll('img, video, audio, .internal-embed');
                        medias.forEach(media => {
                            let isAudio = media.tagName.toLowerCase() === 'audio' || media.querySelector('audio') !== null;
                            const srcAttr = media.getAttribute('src');
                            if (srcAttr && /\.(mp3|wav|ogg|m4a|flac)$/i.test(srcAttr.split('?')[0])) {
                                isAudio = true;
                            }

                            if (isAudio && media.classList.contains('internal-embed')) {
                                media.setAttribute('draggable', 'false');
                                return;
                            }

                            media.addClass('duallink-gallery-media-full-width');
                            media.setAttribute('draggable', 'false');

                            if (!isAudio) {
                                if (!media.classList.contains('internal-embed')) {
                                    media.addClass('duallink-gallery-media-cover');
                                }
                            } else {
                                media.addClass('duallink-gallery-media-audio');
                            }

                            if (media.tagName.toLowerCase() === 'img') {
                                media.addClass('duallink-gallery-media-img');
                            }
                        });
                        const ps = item.querySelectorAll('p');
                        ps.forEach(p => {
                            p.addClass('duallink-gallery-p-margin-reset');
                        });
                    }, 50);
                }
            }
        });

        const remainingCols = columns - images.length;
        if (remainingCols > 0) {
            for (let i = 0; i < remainingCols; i++) {
                const emptyCell = createDiv();
                items.push(emptyCell);
                resizeObserver.observe(emptyCell);
                emptyCell.className = 'duallink-gallery-empty';

                setIcon(emptyCell, 'plus');
                emptyCell.addClass('duallink-gallery-empty--icon');

                emptyCell.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (el.closest('.markdown-reading-view')) return;
                    if (!fs) {
                        new Notice('插入本地文件仅支持桌面版 Obsidian。');
                        return;
                    }

                    emptyCell.empty();
                    emptyCell.addClass('duallink-gallery-empty--loading');
                    emptyCell.createSpan({ text: '\u6b63\u5728\u9009\u62e9\u6587\u4ef6...' });

                    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
                    if (!view) {
                        emptyCell.removeClass('duallink-gallery-empty--loading');
                        setIcon(emptyCell, 'plus');
                        emptyCell.addClass('duallink-gallery-empty--icon');
                        return;
                    }

                    new PathPromptModal(plugin, '', (inputPath: string) => {
                        emptyCell.removeClass('duallink-gallery-empty--loading');
                        if (!inputPath) {
                            setIcon(emptyCell, 'plus');
                            emptyCell.addClass('duallink-gallery-empty--icon');
                            return;
                        }
                        const cleanP = inputPath.replace(/['"]/g, '').trim();
                        const internalPath = vaultRelativeFromAbsolute(plugin.app, cleanP);
                        let newSyntax = '';
                        if (internalPath !== null) {
                            newSyntax = `![[${internalPath}]]`;
                        } else {
                            newSyntax = `![](<file:///${encodeFileUriPath(cleanP)}>)`;
                        }
                        void updateCodeBlock(columns, [...images, newSyntax]);
                    }).open();
                });
            }
        }

        // 标记父级代码块以便 CSS 替代 :has() 选择器
        const embedBlock = el.closest('.cm-embed-block') || el.closest('.cm-preview-code-block');
        if (embedBlock) {
            embedBlock.addClass('duallink-gallery-embed-block');
        }

        distributeItems();
    });
  });
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access -- 恢复 no-unsafe-member-access 检查 */
