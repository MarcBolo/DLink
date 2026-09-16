export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'];
export const IMAGE_EXTENSIONS_SET = new Set(IMAGE_EXTENSIONS);

export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'avi', 'mov', 'mkv', 'flv', 'wmv'];
export const VIDEO_EXTENSIONS_SET = new Set(VIDEO_EXTENSIONS);

export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'];
export const AUDIO_EXTENSIONS_SET = new Set(AUDIO_EXTENSIONS);

export const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];
export const MEDIA_EXTENSIONS_SET = new Set(MEDIA_EXTENSIONS);

export function isImageExt(ext: string): boolean {
    return IMAGE_EXTENSIONS_SET.has(ext.toLowerCase().replace('.', ''));
}

export function isVideoExt(ext: string): boolean {
    return VIDEO_EXTENSIONS_SET.has(ext.toLowerCase().replace('.', ''));
}

export function isAudioExt(ext: string): boolean {
    return AUDIO_EXTENSIONS_SET.has(ext.toLowerCase().replace('.', ''));
}

export function isMediaExt(ext: string): boolean {
    return MEDIA_EXTENSIONS_SET.has(ext.toLowerCase().replace('.', ''));
}
