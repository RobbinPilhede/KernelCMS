/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_KERNEL_API?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
