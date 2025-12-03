// src/pages/Stats.tsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type BasicStats = {
  totalPicks: number;
  // placeholders for later
  wins: number;
  losses: number;
  pushes: number;
  winRate: number;
};

export default function Stats() {
  const [loading, setLoading] = useState(true);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [stats, setStats] = useState<BasicStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);
      setError(null);
      setNeedsLogin(false);

      // 1) Get current user
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError) {
        console.error("[Stats] getSession error:", sessionError);
      }

      const user = session?.user ?? null;

      if (!user) {
        if (!mounted) return;
        setNeedsLogin(true);
        setLoading(false);
        return;
      }

      // 2) Fetch this user's picks
      const { data, error: picksError } = await supabase
        .from("picks")
        .select("*", { count: "exact", head: false }) // we just care about count for now
        .eq("user_id", user.id);

      if (!mounted) return;

      if (picksError) {
        console.error("[Stats] picks error:", picksError);
        setError("Failed to load your picks. Please try again later.");
        setLoading(false);
        return;
      }

      const total = data?.length ?? 0;

      // TODO: when we store outcomes, compute real wins/losses here.
      const basic: BasicStats = {
        totalPicks: total,
        wins: 0,
        losses: 0,
        pushes: 0,
        winRate: 0,
      };

      setStats(basic);
      setLoading(false);
    }

    load();

    return () => {
      mounted = false;
    };
  }, []);

  // ---------- RENDER STATES ----------

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700">
          Loading your stats…
        </div>
      </div>
    );
  }

  if (needsLogin) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700 text-center">
          <p className="mb-2 font-semibold text-yellow-400">Stats</p>
          <p>You must be logged in to view your stats.</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-red-500/60 text-center">
          <p className="mb-2 font-semibold text-red-400">Error</p>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!stats) {
    // should basically never happen, but just in case
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-slate-300">
        <div className="bg-slate-900/70 px-6 py-4 rounded-xl border border-slate-700">
          Couldn’t load stats.
        </div>
      </div>
    );
  }

  // ---------- MAIN UI ----------

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
      <h1 className="text-3xl font-bold text-yellow-400 mb-6">Your Stats</h1>

      {/* Top summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 mb-10">
        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Total Picks
          </p>
          <p className="text-2xl mt-1 font-bold">{stats.totalPicks}</p>
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Win Rate
          </p>
          <p className="text-2xl mt-1 font-bold">{stats.winRate}%</p>
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Wins
          </p>
          <p className="text-2xl mt-1 font-bold">{stats.wins}</p>
        </div>

        <div className="bg-slate-900/70 p-4 rounded-xl border border-slate-700">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            Losses
          </p>
          <p className="text-2xl mt-1 font-bold">{stats.losses}</p>
        </div>
      </div>

      {/* Placeholder section for future charts / per-week breakdown */}
      <div className="bg-slate-900/70 rounded-xl border border-slate-700 p-6">
        <h2 className="text-lg font-semibold mb-2">
          Weekly breakdown (coming soon)
        </h2>
        <p className="text-sm text-slate-400">
          Once we start tracking outcomes per game, this section will show your
          record by week, per team, and per bet type.
        </p>
      </div>
    </div>
  );
}