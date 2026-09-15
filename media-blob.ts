/**
 * 本地媒体 Blob URL 生命周期管理（#3 修复）
 *
 * 阅读视图/Gallery 需要把外部 file:/// 媒体读入 Blob 后以内嵌元素展示。
 * 旧实现每处渲染都 URL.createObjectURL 且从不 revoke，DOM 被 Obsidian
 * 重渲染丢弃时 URL 随之泄漏，长时间会话内内存持续增长。
 *
 * 本模块统一：
 * 1. mime 映射与“整读文件 → objectURL”创建（替代散落在各文件的重复实现）；
 * 2. 通过 document 级 MutationObserver 监控被跟踪节点的 DOM 移除，
 *    节点一旦被 Obsidian 重渲染回收即自动 revokeObjectURL。
 */

import { isImageExt, isVideoExt, isAudioExt } from './constants';
import { fs } from './node-modules';

/** 文件列表/缩略图场景允许整读成 Blob 的最大字节数（超过则只显示类型徽标，避免大文件内存尖峰） */
export const PREVIEW_VIDEO_BYTE_LIMIT = 12 * 1024 * 1024;

/** 根据扩展名推断 mime；非媒体返回 null */
function mimeForExt(ext: string): string | null {
  if (isImageExt(ext)) {
    const imageMimes: Record<string, string> = { jpg: 'jpeg', svg: 'svg+xml' };
    return `image/${imageMimes[ext] || ext}`;
  }
  if (isVideoExt(ext)) {
    return `video/${ext}`;
  }
  if (isAudioExt(ext)) {
    const audioMimes: Record<string, string> = { mp3: 'mpeg' };
    return `audio/${audioMimes[ext] || ext}`;
  }
  return null;
}

/**
 * 整读外部文件并创建 objectURL。仅桌面有 fs；读取失败/非媒体返回 null。
 * 注意：大文件会整文件进内存（Blob 无流式接口），请勿用于巨型文件。
 */
export function blobUrlForFilePath(filePath: string): string | null {
  if (!fs) return null;
  try {
    const buf = fs.readFileSync(filePath);
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const mime = mimeForExt(ext);
    if (!mime) return null;
    return URL.createObjectURL(new Blob([buf], { type: mime }));
  } catch {
    return null;
  }
}

const trackedNodes = new Set<HTMLElement>();
const nodeUrls = new WeakMap<HTMLElement, string>();
let observer: MutationObserver | null = null;

function revokeElement(el: HTMLElement): void {
  if (!trackedNodes.has(el)) return;
  trackedNodes.delete(el);
  const url = nodeUrls.get(el);
  if (url) URL.revokeObjectURL(url);
}

/** 递归回收根节点（含自身）内所有被跟踪的元素 */
function revokeSubtree(root: HTMLElement): void {
  revokeElement(root);
  const walker = activeDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let next: Node | null;
  while ((next = walker.nextNode()) !== null) {
    revokeElement(next as HTMLElement);
  }
}

function ensureObserver(): void {
  if (observer) return;
  observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.removedNodes)) {
        if (node instanceof HTMLElement) {
          revokeSubtree(node);
        }
      }
    }
  });
  observer.observe(activeDocument.body, { childList: true, subtree: true });
}

/**
 * 登记一个“其 src 已指向 blob URL”的元素；该元素从 DOM 移除时自动 revoke。
 * 元素尚未插入 DOM 也可登记（Observer 在 body 上监听全局移除）。
 */
export function trackBlobNode(node: HTMLElement, url: string | null): void {
  if (!url) return;
  trackedNodes.add(node);
  nodeUrls.set(node, url);
  ensureObserver();
}
