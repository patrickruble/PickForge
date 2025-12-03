import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url  = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anon) {
  // Helps catch misconfigured .env in dev
  console.warn(
    "[supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. " +
    "Check your .env/.env.local and restart Vite."
  );
}

export const supabase: SupabaseClient = createClient(url!, anon!, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

// Expose the client in dev so you can use it from DevTools console
// Usage: await supabase.rpc("set_username", { new_username: "Pattymelt" })
if (import.meta.env.DEV) {
  (window as any).supabase = supabase;
}

export default supabase;