// src/components/Header.tsx
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

type ProfileRow = { username: string | null };

export default function Header() {
  const [email, setEmail] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!mounted) return;

      const u = session?.user ?? null;
      setEmail(u?.email ?? null);

      if (u?.id) {
        const { data } = await supabase
          .from("profiles")
          .select("username")
          .eq("id", u.id)
          .maybeSingle();

        if (!mounted) return;
        setUsername((data as ProfileRow | null)?.username ?? null);
      } else {
        setUsername(null);
      }
    };

    load();
    const { data: sub } = supabase.auth.onAuthStateChange(() => load());
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const displayName = useMemo(() => {
    if (username && username.trim()) return `@${username.trim()}`;
    if (email) return email.split("@")[0]; // email handle
    return null;
  }, [username, email]);

  return (
    <header className="border-b border-white/5 bg-slate-900">
      <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
        <Link to="/" className="text-xl font-bold text-yellow-400">
          PickForge
        </Link>

        <nav className="text-sm text-slate-200 flex items-center gap-5">
          <NavLink to="/" className={({isActive}) => isActive ? "text-white" : "hover:text-white"}>
            Weekly Picks
          </NavLink>
          <NavLink to="/mypicks" className={({isActive}) => isActive ? "text-white" : "hover:text-white"}>
            My Picks
          </NavLink>
          <NavLink to="/leaderboard" className={({isActive}) => isActive ? "text-white" : "hover:text-white"}>
            Leaderboard
          </NavLink>

          {displayName ? (
            <>
              <Link
                to="/username"
                className="text-xs px-2 py-1 rounded bg-slate-800 border border-slate-700 hover:bg-slate-700"
                title="Profile / username"
              >
                {displayName}
              </Link>
              <button
                onClick={async () => {
                  await supabase.auth.signOut();
                  navigate("/");
                }}
                className="bg-yellow-400 text-black px-3 py-1 rounded-xl"
              >
                Logout
              </button>
            </>
          ) : (
            <Link
              to="/login"
              className="bg-yellow-400 text-black px-3 py-1 rounded-xl"
              title="Sign in"
            >
              Login
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}