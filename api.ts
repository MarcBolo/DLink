import type LocalFileLinkerPlugin from './main';

export interface DualLinkPublicAPI {
  generateMarkdownLink(fileName: string, filePath: string): string;
  packToVault(): Promise<void>;
  packOut(): Promise<void>;
  findExternalFileRec(fileName: string, dir: string, maxDepth?: number, currentDepth?: number): Promise<string | null>;
}

export function createPublicAPI(plugin: LocalFileLinkerPlugin): DualLinkPublicAPI {
  return {
    generateMarkdownLink: (fileName: string, filePath: string) => plugin.generateMarkdownLink(fileName, filePath),
    packToVault: () => plugin.packToVault(),
    packOut: () => plugin.packOut(),
    findExternalFileRec: (fileName: string, dir: string, maxDepth?: number, currentDepth?: number) => plugin.findExternalFileRec(fileName, dir, maxDepth, currentDepth),
  };
}
