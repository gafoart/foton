/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_VIEWER_API_ORIGIN?: string;
  readonly VITE_MANIFEST_SAVE_SECRET?: string;
  readonly VITE_PUBLIC_ASSETS_BASE?: string;
  /** Optional; must match EDITOR_DEPLOY_SECRET on the Vite dev server for deploy buttons */
  readonly VITE_EDITOR_DEPLOY_SECRET?: string;
  /**
   * Editor Pages URL for latest main (production hostname or branch alias).
   * Used by the ↗ button next to “Deploy to Cloudflare”. Defaults to spark-viewer-editor.pages.dev.
   */
  readonly VITE_CF_PAGES_EDITOR_MAIN_URL?: string;
}
