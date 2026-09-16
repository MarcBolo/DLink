/**
 * 本地媒体 Blob URL 生命周期管理（#3 修复）
 *
 * 阅读视图/Gallery 需要把外部 file:/// 媒体读入 Blob 后以内嵌元素展示。
 * 旧实现每处渲染都 URL.createObjectURL 且从不 revoke，DOM 被 Obsidian
 * 重渲染丢弃时 URL 随之泄漏，长时间会话内内存持续增长。
 *
 * 本模块统一：
 * 1. mime 映射与“整读文件 → objectURL”创建（替代散落在各文件的重复实现）；
 * 2. 通过 document 级 MutationObserver 监控被跟踪节点的 DOM 移除，节点被 Obsidian
 *    重渲染回收后**延迟** revokeObjectURL（时机说明见 REVOKE_GRACE_MS）。
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

/**
 * 回收延迟（毫秒）。
 *
 * 阅读模式/编辑模式下 Obsidian 重渲染时，经常把节点「先移除、再重新插入」，
 * 或复制节点用于悬浮预览。若在移除的瞬间就 revokeObjectURL，仍在使用的
 * blob URL 会失效，控制台随之报 `GET blob:… net::ERR_FILE_NOT_FOUND`。
 * 因此这里延后一拍再回收，并在回收前确认该 URL 确实已无人引用。
 */
const REVOKE_GRACE_MS = 1000;
const pendingRevokes = new Map<HTMLElement, number>();

function revokeElement(el: HTMLElement): void {
  if (!trackedNodes.has(el)) return;
  trackedNodes.delete(el);
  const url = nodeUrls.get(el);
  if (url) URL.revokeObjectURL(url);
}

/** 递归回收根节点（含自身）内所有被跟踪的元素 */
function revokeSubtree(root: HTMLElement): void {
  revokeElement(root);
  const doc = root.ownerDocument ?? activeDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let next: Node | null;
  while ((next = walker.nextNode()) !== null) {
    revokeElement(next as HTMLElement);
  }
}

/** 该 blob URL 是否仍被文档中的媒体元素引用（例如 Obsidian 复制出来的节点） */
function isUrlStillReferenced(doc: Document, url: string): boolean {
  const medias = doc.querySelectorAll('img, video, audio, source');
  for (const media of Array.from(medias)) {
    if (media.getAttribute('src') === url) return true;
  }
  return false;
}

/** 延迟回收：节点若已回到文档、或其 URL 仍被引用，则取消本次回收 */
function scheduleRevoke(node: HTMLElement): void {
  const pending = pendingRevokes.get(node);
  if (pending !== undefined) window.clearTimeout(pending);
  const handle = window.setTimeout(() => {
    pendingRevokes.delete(node);
    if (node.isConnected) return;
    const url = nodeUrls.get(node);
    if (url && isUrlStillReferenced(node.ownerDocument ?? activeDocument, url)) return;
    revokeSubtree(node);
  }, REVOKE_GRACE_MS);
  pendingRevokes.set(node, handle);
}

function ensureObserver(): void {
  if (observer) return;
  observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.removedNodes)) {
        if (node instanceof HTMLElement) {
          scheduleRevoke(node);
        }
      }
    }
  });
  observer.observe(activeDocument.body, { childList: true, subtree: true });
}

/**
 * 登记一个“其 src 已指向 blob URL”的元素；该元素从 DOM 移除后自动回收。
 * 元素尚未插入 DOM 也可登记（Observer 在 body 上监听全局移除）。
 */
export function trackBlobNode(node: HTMLElement, url: string | null): void {
  if (!url) return;
  const pending = pendingRevokes.get(node);
  if (pending !== undefined) { // 曾被排入回收队列，如今重新启用 → 取消回收
    window.clearTimeout(pending);
    pendingRevokes.delete(node);
  }
  trackedNodes.add(node);
  nodeUrls.set(node, url);
  ensureObserver();
}
