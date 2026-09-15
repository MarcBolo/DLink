declare module 'electron' {
  interface Shell {
    openPath(filePath: string): Promise<string>;
    showItemInFolder(filePath: string): void;
  }
  export const shell: Shell;
}
