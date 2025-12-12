// src/components/Header.tsx
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

function logSupabaseError(prefix: string, error: any) {
  if (!error) return;
  console.error(prefix, error);
  console.error(`${prefix} details:`, {
    message: error?.message,
    details: error?.details,
    hint: error?.hint,
    code: error?.code,
    status: error?.status,
  });
}

async function ensureProfileRow(userId: string) {
  // Create a minimal profile row if one doesn't exist.
  // Safe even if the trigger already did it.
  const { error } = await supabase.from("profiles").insert({ id: userId });
  if (error) {
    // ignore duplicate key; anything else is useful to see
    const msg = String(error?.message ?? "").toLowerCase();
    const code = String(error?.code ?? "").toLowerCase();
    if (!msg.includes("duplicate") && !code.includes("23505")) {
      logSupabaseError("[Header] profile insert error:", error);
    }
  }
}

type ProfileRow = {
  id?: string;
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
        logSupabaseError("[Header] getSession error:", error);
      }
      if (!mounted) return;

      const u = session?.user ?? null;
      setUserId(u?.id ?? null);
      setEmail(u?.email ?? null);
      console.log("[Header] user:", u?.id ?? null, u?.email ?? null);

      if (!u?.id) {
        setUsername(null);
        setAvatarUrl(null);
        return;
      }

      let { data, error: profileError } = await supabase
        .from("profiles")
        .select("username, avatar_url")
        .eq("id", u.id)
        .maybeSingle();

      if (!mounted) return;

      if (profileError) {
        logSupabaseError("[Header] profile load error:", profileError);
      }

      // If the profile row doesn't exist yet, create it and try once more.
      if (!profileError && !data) {
        await ensureProfileRow(u.id);
        const retry = await supabase
          .from("profiles")
          .select("username, avatar_url")
          .eq("id", u.id)
          .maybeSingle();
        data = retry.data;
        if (retry.error) {
          logSupabaseError("[Header] profile load error (retry):", retry.error);
        }
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

      console.log("[Header] auth change user:", u.id, u.email ?? null);

      supabase
        .from("profiles")
        .select("username, avatar_url")
        .eq("id", u.id)
        .maybeSingle()
        .then(async ({ data, error }) => {
          if (error) {
            logSupabaseError("[Header] profile load error (sub):", error);
            return;
          }

          // Create missing row, then refetch.
          if (!data) {
            await ensureProfileRow(u.id);
            const retry = await supabase
              .from("profiles")
              .select("username, avatar_url")
              .eq("id", u.id)
              .maybeSingle();
            if (retry.error) {
              logSupabaseError("[Header] profile load error (sub retry):", retry.error);
            }
            const row = retry.data as ProfileRow | null;
            setUsername(row?.username ?? null);
            setAvatarUrl(row?.avatar_url ?? null);
            return;
          }

          const row = data as ProfileRow | null;
          setUsername(row?.username ?? null);
          setAvatarUrl(row?.avatar_url ?? null);
        });
    });

    return () => {
      mounted = false;
      sub?.subscription?.unsubscribe();
    };
  }, []);

  // Text label shown in the top-right chip
  const displayName = useMemo(() => {
    if (username && username.trim()) return `@${username.trim()}`;
    if (email) return email.split("@")[0];
    return null;
  }, [username, email]);

  // URL slug for profile links: username (normalized) → id fallback
  const profileSlug = useMemo(() => {
    if (username && username.trim()) {
      return username.trim().toLowerCase().replace(/\s+/g, "");
    }
    return userId ?? null;
  }, [username, userId]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/");
  };

  const userBar = (
    <>
      {displayName && userId ? (
        <>
          {/* Avatar + name → go to user profile */}
          <Link
            to={profileSlug ? `/u/${profileSlug}` : "/leaderboard"}
            className="flex items-center gap-2 px-2 py-1 rounded bg-slate-800 border border-slate-700 hover:bg-slate-700 text-[11px] sm:text-xs"
            title="View profile"
          >
            <div className="w-6 h-6 rounded-full bg-slate-900 flex items-center justify-center overflow-hidden text-[0.7rem] font-bold text-yellow-400">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt="Avatar"
                  className="w-full h-full object-cover"
                />
              ) : (
                (displayName.replace("@", "")[0] ?? "?").toUpperCase()
              )}
            </div>
            <span className="truncate max-w-[110px] sm:max-w-none">
              {displayName}
            </span>
          </Link>

          <button
            onClick={handleLogout}
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
    </>
  );

  return (
    <header className="border-b border-slate-800 bg-slate-900">
      <div className="mx-auto max-w-6xl px-3 sm:px-4 py-2 sm:py-3 space-y-2">
        {/* Row 1: PickForge logo + user bar */}
        <div className="flex items-center justify-between gap-3">
          <Link to="/" className="pf-logo text-yellow-400 flex items-center gap-2">
            <span className="pf-logo-lock inline-flex items-center justify-center">
              <svg
                width="28"
                height="28"
                viewBox="0 0 28 28"
                xmlns="http://www.w3.org/2000/svg"
              >
                {/* Black background */}
                <rect width="28" height="28" fill="black" rx="6" />
                {/* Lock shackle */}
                <path
                  d="M9 11c0-3.3 2.1-5 5-5s5 1.7 5 5v2h-2v-2c0-2-.9-3-3-3s-3 1-3 3v2H9v-2z"
                  fill="#facc15"
                />
                {/* Anvil base */}
                <path
                  d="M6 17h16l-1.8 2.5c-.3.4-.9.7-1.4.7H9.2c-.5 0-1-.3-1.4-.7L6 17z"
                  fill="#facc15"
                />
                {/* Anvil stand */}
                <rect x="11" y="20" width="6" height="3" rx="1" fill="#facc15" />
              </svg>
            </span>
            <span className="pf-logo-text font-display text-xl sm:text-2xl tracking-[0.12em] uppercase">
              PickForge
            </span>
          </Link>

          <div className="flex items-center gap-2">{userBar}</div>
        </div>

        {/* Row 2: nav */}
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

          {userId && (
            <>
              <NavLink
                to="/stats"
                className={({ isActive }) =>
                  isActive ? "text-white" : "hover:text-white"
                }
              >
                Stats
              </NavLink>

              <NavLink
                to="/leagues"
                className={({ isActive }) =>
                  isActive ? "text-white" : "hover:text-white"
                }
              >
                Leagues
              </NavLink>

              <NavLink
                to="/feed"
                className={({ isActive }) =>
                  isActive ? "text-white" : "hover:text-white"
                }
              >
                Feed
              </NavLink>

              <NavLink
                to="/bets"
                className={({ isActive }) =>
                  isActive ? "text-white" : "hover:text-white"
                }
              >
                Bet Tracker
              </NavLink>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}