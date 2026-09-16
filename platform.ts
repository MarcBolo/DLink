export const isDesktop = (): boolean => {
    const proc = (window as unknown as { process?: { versions?: { node?: string } } }).process;
    return proc?.versions?.node != null;
};

export const isMobile = (): boolean => {
    return !isDesktop();
};

export const isElectron = (): boolean => {
    return isDesktop() && typeof (window as unknown as { require: unknown }).require !== 'undefined';
};
