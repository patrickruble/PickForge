// src/components/Header.tsx
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

type ProfileRow = {
  username: string | null;
  avatar_url: string | null;
};

export default function Header() {
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;

    async function load() {
      const {
        data: { session },
        error,
      } = await supabase.auth.getSession();

      if (error) {
        console.error("[Header] getSession error:", error);
      }
      if (!mounted) return;

      const u = session?.user ?? null;
      setUserId(u?.id ?? null);
      setEmail(u?.email ?? null);

      if (!u?.id) {
        setUsername(null);
        setAvatarUrl(null);
        return;
      }

      const { data, error: profileError } = await supabase
        .from("profiles")
        .select("username, avatar_url")
        .eq("id", u.id)
        .maybeSingle();

      if (!mounted) return;

      if (profileError) {
        console.error("[Header] profile load error:", profileError);
      }

      const row = data as ProfileRow | null;
      setUsername(row?.username ?? null);
      setAvatarUrl(row?.avatar_url ?? null);
    }

    load();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null;

      if (!u) {
        setUserId(null);
        setEmail(null);
        setUsername(null);
        setAvatarUrl(null);
        return;
      }

      setUserId(u.id);
      setEmail(u.email ?? null);

      supabase
        .from("profiles")
        .select("username, avatar_url")
        .eq("id", u.id)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error) {
            console.error("[Header] profile load error (sub):", error);
          }
          const row = data as ProfileRow | null;
          setUsername(row?.username ?? null);
          setAvatarUrl(row?.avatar_url ?? null);
        });
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const displayName = useMemo(() => {
    if (username && username.trim()) return `@${username.trim()}`;
    if (email) return email.split("@")[0];
    return null;
  }, [username, email]);

  return (
    <header className="border-b border-slate-800 bg-slate-900/95 backdrop-blur">
      <div className="mx-auto max-w-6xl px-3 sm:px-4 py-2 sm:py-3 space-y-1.5">
        {/* ROW 1: logo + nav */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {/* Logo */}
          <Link to="/" className="pf-logo text-yellow-400">
            <span className="pf-logo-lock text-[0.6rem] font-bold">🔒</span>
            <span className="pf-logo-text font-display text-xl sm:text-2xl tracking-[0.12em] uppercase">
              PickForge
            </span>
          </Link>

          {/* Main nav */}
          <nav className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-sm text-slate-200">
            <NavLink
              to="/"
              className={({ isActive }) =>
                isActive ? "text-white" : "hover:text-white"
              }
            >
              Weekly Picks
            </NavLink>

            <NavLink
              to="/mypicks"
              className={({ isActive }) =>
                isActive ? "text-white" : "hover:text-white"
              }
            >
              My Picks
            </NavLink>

            <NavLink
              to="/leaderboard"
              className={({ isActive }) =>
                isActive ? "text-white" : "hover:text-white"
              }
            >
              Leaderboard
            </NavLink>

            {displayName && (
              <NavLink
                to="/stats"
                className={({ isActive }) =>
                  isActive ? "text-white" : "hover:text-white"
                }
              >
                Stats
              </NavLink>
            )}
          </nav>
        </div>

        {/* ROW 2: profile / auth bar */}
        <div className="flex items-center justify-end gap-2">
          {displayName ? (
            <>
              <Link
                to="/username"
                state={userId && email ? { userId, email } : undefined}
                className="flex items-center gap-2 text-[11px] sm:text-xs px-2 py-1 rounded bg-slate-800 border border-slate-700 hover:bg-slate-700"
                title="Profile / username"
              >
                <div className="w-6 h-6 rounded-full bg-slate-900 flex items-center justify-center overflow-hidden text-[0.7rem] font-bold text-yellow-400">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt="Avatar"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    displayName.replace("@", "")[0]?.toUpperCase()
                  )}
                </div>
                <span className="truncate max-w-[120px] sm:max-w-none">
                  {displayName}
                </span>
              </Link>

              <button
                onClick={async () => {
                  await supabase.auth.signOut();
                  navigate("/");
                }}
                className="bg-yellow-400 text-black px-3 py-1 rounded-xl text-xs sm:text-sm"
              >
                Logout
              </button>
            </>
          ) : (
            <Link
              to="/login"
              className="bg-yellow-400 text-black px-3 py-1 rounded-xl text-xs sm:text-sm"
              title="Sign in"
            >
              Login
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}