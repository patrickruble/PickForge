/// <reference types="vite/client" />

// (optional but nice for autocomplete)
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_API_URL?: string
  readonly VITE_NFL_SEASON_START_TUE?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}