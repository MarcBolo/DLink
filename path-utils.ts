/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Obsidian Vault adapter 类型不完整，运行时代理可能包含额外方法 */
import { App, Platform } from 'obsidian';
import { VaultAdapter, VaultExt } from './types';

/**
 * #11：decodeURIComponent 遇到未编码的孤立 '%' 会抛 URIError。
 * 链接文本/URL 属用户可控输入，统一安全解码：解码失败时原样返回。
 */
export function safeDecodeURIComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function getCleanLocalPath(href: string): string {
    let filePath = '';
    const cleanHref = href.replace(/^[<"']|[>"']$/g, '').trim();
    const matchLocal = cleanHref.match(/local-file:\/\/(.+)/);
    const matchFile = cleanHref.match(/file:\/\/\/(.+)/);

    if (matchLocal) {
        filePath = safeDecodeURIComponent(matchLocal[1]);
    } else if (matchFile) {
        filePath = safeDecodeURIComponent(matchFile[1]);
    } else {
        filePath = safeDecodeURIComponent(cleanHref.replace('local-file://', '').replace('file:///', ''));
    }

    return filePath.replace(/\)$/, '').replace(/['">]/g, '').trim();
}

/**
 * 从 app://<id>/ URL 中提取干净的绝对路径。
 * 兼容两种前缀：
 *   - 旧版 Obsidian：app://local/
 *   - 新版 Obsidian：app://<random-id>/
 *
 * 路径形态分两类：
 *   - 库内文件：app://local/<vault-id>/<vault-relative>  → 剥离 vault-id 段
 *   - 库外文件：app://local/E:/xxx                        → 盘符段（E:）必须保留
 *
 * 旧实现的正则 `^app:\/\/local\/[^/]*\/` 会把 Windows 盘符 `E:` 误判为
 * vault-id 一并剥离，导致盘符丢失、blob 读取失败，浏览器回退加载 app://local/
 * 协议从而报 ERR_FILE_NOT_FOUND。
 */
export function getCleanAppLocalPath(src: string): string {
    // 去掉 app://<任意id>/ 前缀
    let path = src.replace(/^app:\/\/[^/]+\//, '');
    // 首个段若是 vault-id（非 Windows 盘符 X:）则剥离；盘符段必须保留
    const firstSeg = path.split('/')[0];
    if (firstSeg && !/^[a-zA-Z]:$/.test(firstSeg)) {
        path = path.slice(firstSeg.length + 1);
    }
    return safeDecodeURIComponent(path);
}

function getVaultBasePath(app: App): string {
    try {
        const adapter = app.vault.adapter as unknown as VaultAdapter;
        if (adapter.getBasePath) {
            return adapter.getBasePath().replace(/\\/g, '/').replace(/\/+$/, '');
        }
    } catch { /* vault adapter error, return empty string */ }
    return '';
}

/**
 * 判定绝对路径是否位于库内（#10 重构的统一入口）：
 * - 路径边界：库根 D:/Notes 不会把 D:/NotesBackup/x 误判为库内文件；
 * - 大小写：比较前统一转小写（Obsidian 链接解析对大小写不敏感），
 *   返回的相对路径保留输入原大小写，便于与 Obsidian 文件路径保持一致；
 * - 非库内或路径等于库根本身返回 null。
 */
export function vaultRelativeFromAbsolute(app: App, absPath: string): string | null {
    const vaultBase = getVaultBasePath(app);
    if (!vaultBase) return null;
    const clean = absPath.replace(/[<>"']/g, '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!clean || clean.toLowerCase() === vaultBase.toLowerCase()) return null;
    if (!clean.toLowerCase().startsWith(vaultBase.toLowerCase() + '/')) return null;
    return clean.substring(vaultBase.length).replace(/^\/+/, '');
}

/**
 * 绝对路径 → file:/// 链接所需的编码路径段（逐段 encodeURIComponent，盘符冒号保留）。
 * 与 main 的 generateMarkdownLink、Gallery、DualOut 等原先各自手写的编码逻辑等价。
 */
export function encodeFileUriPath(absPath: string): string {
    const clean = absPath.replace(/[<>"']/g, '').trim().replace(/\\/g, '/');
    let encoded = clean.split('/').map(c => encodeURIComponent(c)).join('/');
    if (encoded.startsWith('/')) encoded = encoded.substring(1); // POSIX 绝对路径去掉空首段
    return encoded.replace(/^([a-zA-Z])%3A/, '$1:');
}

export function getConvertPath(app: App, filePath: string): string {
    const cleanPath = filePath.replace(/['">]/g, '').trim().replace(/\\/g, '/');
    const relativePath = vaultRelativeFromAbsolute(app, cleanPath);
    if (relativePath !== null) {
        const encoded = relativePath.split('/').map(c => encodeURIComponent(c)).join('/');
        return (app.vault as unknown as VaultExt).getResourcePath(encoded).split('?')[0];
    }
    // 库外文件：使用当前平台的资源路径前缀（旧版 app://local/，新版 app://<random-id>/）。
    // 注意：Obsidian 协议仅服务库内文件，库外文件的 app:// 前缀仅作占位，
    // 实际渲染需走 blob URL（见 blobUrlForFilePath）。
    const prefix = Platform.resourcePathPrefix || 'app://local/';
    return `${prefix}${cleanPath}`;
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access -- 恢复 no-unsafe-member-access 检查 */
