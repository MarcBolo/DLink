/**
 * Node.js 内置模块 - 仅 Electron 桌面环境可用
 * 所有 require() 调用集中在此文件，避免分散在多处导致 lint 警告扩散
 *
 * #5：桌面功能在 onload 时都有 isDesktop() && fs && path && electron 守卫，
 * 因此各模块导出改为“非桌面直接短路返回 null”，杜绝移动/Web 环境下
 * 在模块顶层执行 require('fs') 抛错导致整个插件加载失败的问题。
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-var-requires -- 
   require() 返回类型为 any，但已通过显式类型注解约束导出的接口；Node.js 内置模块使用 require() 加载是 CommonJS 规范
*/
import { isDesktop } from './platform';

interface ElectronShell {
  openPath(filePath: string): Promise<string>;
  showItemInFolder(filePath: string): void;
}

/** 仅在桌面 Electron 下 require；移动/Web 或加载失败时返回 null，避免顶层抛错 */
function tryRequire<T>(id: string): T | null {
  try {
    if (!isDesktop()) return null;
    return require(id) as T;
  } catch {
    return null;
  }
}

export const electron: { shell: ElectronShell } | null = tryRequire<{ shell: ElectronShell }>('electron');
export const fs: typeof import('fs') | null = tryRequire<typeof import('fs')>('fs');
export const path: typeof import('path') | null = tryRequire<typeof import('path')>('path');
export const crypto: typeof import('crypto') | null = tryRequire<typeof import('crypto')>('crypto');
/* eslint-enable -- 恢复被禁用的 ESLint 规则 */
