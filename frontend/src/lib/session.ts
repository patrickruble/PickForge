// src/lib/session.ts
import { supabase } from "./supabase";

export async function ensureSession() {
  // return a user id, creating an anonymous session if needed
  const { data: s1 } = await supabase.auth.getSession();
  if (s1.session?.user?.id) return s1.session.user.id;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.user?.id ?? null;
}