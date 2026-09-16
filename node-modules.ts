/**
 * Node.js 内置模块 - 仅 Electron 桌面环境可用
 * 所有 require() 调用集中在此文件，避免分散在多处导致 lint 警告扩散
 *
 * #5：桌面功能在 onload 时都有 isDesktop() && fs && path && electron 守卫，
 * 因此各模块导出改为“非桌面直接短路返回 null”，杜绝移动/Web 环境下
 * 在模块顶层执行 require('fs') 抛错导致整个插件加载失败的问题。
 */

/* eslint-disable @typescript-eslint/no-require-imports -- 
   require() 返回类型为 any，且必须用 CommonJS 方式加载 Node 内置模块；返回值已由下方显式类型约束
*/
import { isDesktop } from './platform';

interface ElectronShell {
  openPath(filePath: string): Promise<string>;
  showItemInFolder(filePath: string): void;
}

interface ElectronDialogResult {
  canceled: boolean;
  filePaths: string[];
}

interface ElectronRemoteDialog {
  showOpenDialog(options: { title: string; properties: string[] }): Promise<ElectronDialogResult>;
}

interface ElectronModule {
  shell: ElectronShell;
  remote?: { dialog?: ElectronRemoteDialog };
}

/**
 * 以下 Node 内置模块的最小结构类型均为手写（不使用 `typeof import('fs')`）。
 * 原因：类型化 lint 程序解析不到 Node 内置模块类型时，fs/path/Buffer 会整体
 * 退化成 error 类型，进而级联出上百条 no-unsafe-assignment / no-unsafe-call。
 * 只声明本项目实际用到的成员，与 electron 的处理方式保持一致。
 */
export interface NodeStats {
  size: number;
  mtime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface NodeBuffer extends Uint8Array {
  size?: number;
  buffer: ArrayBuffer;
  slice(start?: number, end?: number): NodeBuffer;
  equals(other: Uint8Array): boolean;
}

export interface NodeDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface NodeFs {
  existsSync(path: string): boolean;
  statSync(path: string): NodeStats;
  readFileSync(path: string): NodeBuffer;
  readdirSync(path: string, options: { withFileTypes: boolean }): NodeDirent[];
  mkdirSync(path: string, options: { recursive: boolean }): void;
  copyFileSync(src: string, dest: string): void;
  openSync(path: string, flags: string): number;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  closeSync(fd: number): void;
  promises: {
    readFile(path: string, encoding: string): Promise<string>;
    readFile(path: string): Promise<NodeBuffer>;
    readdir(path: string, options: { withFileTypes: boolean }): Promise<NodeDirent[]>;
  };
}

export interface NodePath {
  join(...parts: string[]): string;
  basename(path: string, ext?: string): string;
  dirname(path: string): string;
  extname(path: string): string;
  isAbsolute(path: string): boolean;
}

export interface NodeBufferCtor {
  allocUnsafe(size: number): NodeBuffer;
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

export const electron: ElectronModule | null = tryRequire<ElectronModule>('electron');
export const fs: NodeFs | null = tryRequire<NodeFs>('fs');
export const path: NodePath | null = tryRequire<NodePath>('path');
/** Node 的 Buffer 构造器（等价于全局 Buffer，但无需 @types/node 的全局声明） */
export const BufferCtor: NodeBufferCtor | null = tryRequire<{ Buffer: NodeBufferCtor }>('buffer')?.Buffer ?? null;
/* eslint-enable -- 恢复被禁用的 ESLint 规则 */
