/** @kernel/storage — swappable byte storage for uploads. */
export type { StorageAdapter, PutOptions, PutResult, ObjectHead, UrlOptions } from './types'
export { memoryStorage, type MemoryStorageOptions } from './memory'
export { localStorage, localObjectPath, type LocalStorageOptions } from './local'
export { s3Storage, r2, type S3StorageOptions } from './s3'
export { sniffMimeType, isContentTypeConsistent } from './sniff'
export { generateKey, sanitizeFilename, assertSafeKey } from './key'
export { extForFormat } from './image'
export type {
  ImageProcessor,
  ImageInfo,
  ImageFit,
  ImageFormat,
  ResizeOptions,
  ResizeResult,
} from './image'
