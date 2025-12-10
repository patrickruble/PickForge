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

          {displayName && (
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