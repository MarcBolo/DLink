/**
 * 本地媒体 Blob URL 生命周期管理（#3 修复）
 *
 * 阅读视图/Gallery 需要把外部 file:/// 媒体读入 Blob 后以内嵌元素展示。
 * 旧实现每处渲染都 URL.createObjectURL 且从不 revoke，DOM 被 Obsidian
 * 重渲染丢弃时 URL 随之泄漏，长时间会话内内存持续增长。
 *
 * 本模块统一：
 * 1. mime 映射与“整读文件 → objectURL”创建（替代散落在各文件的重复实现）；
 * 2. 生命周期：元素被 GC 回收时才 revokeObjectURL（原因见 trackBlobNode 注释）。
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
    const url = URL.createObjectURL(new Blob([buf], { type: mime }));
    if (blobDebugEnabled()) debugCreated.set(url, { path: filePath, at: Date.now() });
    debugLog('create', { path: filePath, url, bytes: buf.length });
    return url;
  } catch {
    return null;
  }
}

/**
 * 诊断埋点（默认关闭，零开销）。控制台执行 `window.duallinkDebugBlob = true` 后生效：
 *   create     创建 blob URL（文件路径、URL、字节数）
 *   track      URL 挂到元素上（标签、是否已入文档、所属文档）
 *   load-error 媒体加载失败 —— 最关键的一条：该 URL 是否由本插件创建、是否已被回收
 *   revoke     元素被 GC 回收、URL 释放（存活时长）
 * 关闭时既不输出、也不写入下面两个调试点状态。
 */
type BlobDebugWindow = Window & { duallinkDebugBlob?: boolean };

/** 打开埋点后记录所有创建过的 URL（含文件路径与时间），用于判断失败 URL 的来源与存活时长 */
const debugCreated = new Map<string, { path: string; at: number }>();
/** 打开埋点后记录已回收的 URL，用于区分「被本插件提前回收」与「其他原因」 */
const debugRevoked = new Set<string>();

function blobDebugEnabled(): boolean {
  return (window as BlobDebugWindow).duallinkDebugBlob === true;
}

function debugLog(event: string, data: Record<string, unknown>, warn = false): void {
  if (!blobDebugEnabled()) return;
  if (warn) console.warn('[DLink/blob]', event, data);
  else console.debug('[DLink/blob]', event, data);
}

function describeDoc(node: Node): string {
  const doc = node.ownerDocument;
  return doc ? doc.URL || 'about:blank' : 'no-document';
}

/**
 * 元素被 GC 回收时 revoke 其 blob URL。
 *
 * 为何以「可达性」而非「是否还在文档里」作为回收判据：
 * Obsidian 的阅读视图会把渲染好的 DOM 从文档中**摘下来缓存/复用**（切换文件后
 * 再切回、切换阅读/编辑视图等），此时元素仍然存活、随时可能被重新挂回文档。
 * 若按「已移出文档」回收，就会 revoke 掉这些仍在使用的 URL；缓存 DOM 被重新
 * 挂回时，浏览器对每个媒体各发一次请求，控制台即刷出
 * `GET blob:… net::ERR_FILE_NOT_FOUND`（症状：切回笔记立即报错、关掉标签重开
 * 反而正常，因为重开会重新渲染并生成新的 blob URL）。
 *
 * FinalizationRegistry 只在元素连同引用它的 DOM 一起被 GC 回收后才触发，既不
 * 会误杀仍可能被复用的 URL，也不会在长会话里无界增长。
 * 注意：GC 时机由引擎决定，回收是「最终」而非「及时」的——这正对应 blob 内存
 * 真实的存活期（DOM 被丢弃前，媒体本就还需要它）。
 */
const blobUrlRegistry = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry<string>((url) => {
      if (blobDebugEnabled()) {
        const info = debugCreated.get(url);
        debugRevoked.add(url);
        debugLog('revoke', {
          url,
          path: info?.path,
          livedMs: info === undefined ? undefined : Date.now() - info.at,
          stillReferenced: isUrlReferencedInAnyDocument(url),
        });
      }
      try {
        URL.revokeObjectURL(url);
      } catch { /* 已失效则忽略 */ }
    })
  : null;

/** 该 URL 是否仍被某个已打开的文档（主窗口 / popout）中的媒体元素引用 */
function isUrlReferencedInAnyDocument(url: string): boolean {
  const docs: Document[] = [];
  for (const win of getOpenWindows()) docs.push(win.document);
  return docs.some((doc) => doc.querySelector(`img[src="${url}"], video[src="${url}"], audio[src="${url}"], source[src="${url}"]`) !== null);
}

/** 当前打开的所有窗口（主窗口 + popout）；取不到时回退到主窗口 */
function getOpenWindows(): Window[] {
  const wins: Window[] = [window];
  const app = (window as unknown as { app?: { workspace?: { iterateAllLeaves?: (cb: (leaf: { view?: { containerEl?: { win?: Window } } }) => void) => void } } }).app;
  app?.workspace?.iterateAllLeaves?.((leaf) => {
    const win = leaf.view?.containerEl?.win;
    if (win && !wins.includes(win)) wins.push(win);
  });
  return wins;
}

/**
 * 登记一个“其 src 已指向 blob URL”的元素，元素被 GC 回收时自动 revoke 该 URL。
 * 只接受 blob: URL：vault 内资源走 app:// 形式，不应（也无法）被 revoke。
 */
export function trackBlobNode(node: HTMLElement, url: string | null): void {
  if (!url || !url.startsWith('blob:') || !blobUrlRegistry) return;

  // 埋点：加载失败是「URL 确实被浏览器拒收」的第一手证据，直接在元素上捕获
  node.addEventListener('error', () => {
    if (!blobDebugEnabled()) return;
    debugLog('load-error', {
      url,
      tag: node.tagName.toLowerCase(),
      doc: describeDoc(node),
      connected: node.isConnected,
      createdByPlugin: debugCreated.has(url),
      revokedByPlugin: debugRevoked.has(url),
      referencedInOpenDocs: isUrlReferencedInAnyDocument(url),
    }, true);
  });
  debugLog('track', {
    url,
    tag: node.tagName.toLowerCase(),
    doc: describeDoc(node),
    connected: node.isConnected,
  });

  // 只持有 node 的弱引用，否则元素永远可达、注册表永不触发
  blobUrlRegistry.register(node, url);
}
