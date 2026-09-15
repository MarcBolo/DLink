export const isDesktop = (): boolean => {
    return typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
};

export const isMobile = (): boolean => {
    return !isDesktop();
};

/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Electron 环境中 window.require 确实存在 */
export const isElectron = (): boolean => {
    return isDesktop() && typeof (window as unknown as { require: unknown }).require !== 'undefined';
};
/* eslint-enable -- 恢复 no-unsafe-member-access 检查 */
