// src/components/Header.tsx
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { getNflWeekNumber } from "../hooks/useRemotePicks";
import "./header.css";

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

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const week = getNflWeekNumber(new Date());

  const links: { to: string; label: string; authed?: boolean }[] = [
    { to: "/", label: "Weekly Picks" },
    { to: "/td", label: "TD Board" },
    { to: "/leaderboard", label: "Leaderboard" },
    { to: "/mypicks", label: "My Picks" },
    { to: "/stats", label: "Stats", authed: true },
    { to: "/leagues", label: "Leagues", authed: true },
    { to: "/feed", label: "Feed", authed: true },
    { to: "/bets", label: "Bet Tracker", authed: true },
  ];

  return (
    <header className="pf-mast">
      <div className="pf-mast-inner">
        <p className="pf-dateline">
          <span>{today}</span>
          <span>NFL Week {week}</span>
          <span className="pf-dateline-tag">Free picks, graded in public</span>
        </p>

        <div className="pf-mast-row">
          <Link to="/" className="pf-wordmark" aria-label="PickForge home">
            <span>Pick</span>
            <span className="pf-wordmark-red">Forge</span>
          </Link>

          <div className="pf-userbar">
            {displayName && userId ? (
              <>
                <Link
                  to={profileSlug ? `/u/${profileSlug}` : "/leaderboard"}
                  className="pf-user"
                  title="View profile"
                >
                  <span className="pf-avatar">
                    {avatarUrl ? (
                      <img src={avatarUrl} alt="" />
                    ) : (
                      (displayName.replace("@", "")[0] ?? "?").toUpperCase()
                    )}
                  </span>
                  <span className="pf-user-name">{displayName}</span>
                </Link>
                <button type="button" onClick={handleLogout} className="pf-btn pf-btn-ghost">
                  Log out
                </button>
              </>
            ) : (
              <Link to="/login" className="pf-btn">
                Log in
              </Link>
            )}
          </div>
        </div>

        <nav className="pf-nav" aria-label="Sections">
          {links
            .filter((l) => !l.authed || userId)
            .map((l) => (
              <NavLink key={l.to} to={l.to} end={l.to === "/"}>
                {l.label}
              </NavLink>
            ))}
        </nav>
      </div>
    </header>
  );
}
