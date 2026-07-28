/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PUBLIC_ASSETS_BASE?: string;
  /** If set, showroom shows a link to the web editor (e.g. Pages URL). */
  readonly VITE_PUBLIC_EDITOR_URL?: string;
}
