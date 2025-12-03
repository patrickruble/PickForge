import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function AuthCallback() {
  const nav = useNavigate();
  const [msg, setMsg] = useState("Loading…");

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        // If we already have a session, bounce home.
        const existing = await supabase.auth.getSession();
        if (existing.data.session) {
          nav("/", { replace: true });
          return;
        }

        const url = new URL(window.location.href);
        const hasCode = !!url.searchParams.get("code");
        const hasToken = window.location.hash.includes("access_token");
        if (!hasCode && !hasToken) {
          nav("/", { replace: true });
          return;
        }

        setMsg("Signing you in…");

        try {
          await supabase.auth.exchangeCodeForSession(window.location.href);
        } catch (err) {
          // Hash flow may have already set session; verify before failing.
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) throw err;
        }

        if (!mounted) return;
        setMsg("Signed in! Redirecting…");
        nav("/", { replace: true });
      } catch (e) {
        console.error("auth callback error:", e);
        if (!mounted) return;
        setMsg("Sign-in failed. Redirecting to login…");
        setTimeout(() => nav("/login", { replace: true }), 1200);
      }
    })();
    return () => { mounted = false; };
  }, [nav]);

  return (
    <div className="min-h-[60vh] grid place-items-center text-slate-300">
      {msg}
    </div>
  );
}