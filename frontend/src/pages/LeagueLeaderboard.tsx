// src/pages/LeagueLeaderboard.tsx
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAllUserStats } from "../hooks/useAllUserStats";

type League = {
  id: string;
  name: string;
  invite_code: string;
  created_by: string | null;
};

type LeagueMemberRow = {
  user_id: string;
  role: string | null;
  joined_at: string | null;
};

type ProfileRow = {
  id: string;
  username: string | null;
  avatar_url: string | null;
};

type MemberView = {
  user_id: string;
  role: string;
  joined_at: string | null;
  username: string | null;
  avatar_url: string | null;
};

function formatStreak(type: "W" | "L" | null, len: number) {
  if (!type || len === 0) return "—";
  return `${type}${len}`;
}

export default function LeagueLeaderboard() {
  const { leagueId } = useParams<{ leagueId: string }>();
  const nav = useNavigate();

  const {
    statsByUser,
    loading: statsLoading,
    error: statsError,
  } = useAllUserStats();

  const [meId, setMeId] = useState<string | null>(null);

  const [league, setLeague] = useState<League | null>(null);
  const [members, setMembers] = useState<MemberView[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // who am I?
  useEffect(() => {
    let mounted = true;
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!mounted) return;
      setMeId(session?.user?.id ?? null);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // load league + member list
  useEffect(() => {
    if (!leagueId) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setErr(null);

      // Load league (RLS should restrict to members)
      const { data: lg, error: lgErr } = await supabase
        .from("leagues")
        .select("id, name, invite_code, created_by")
        .eq("id", leagueId)
        .maybeSingle();

      if (cancelled) return;

      if (lgErr || !lg) {
        console.error("[LeagueLeaderboard] league error:", lgErr);
        setErr("Unable to load this league. You may not be a member.");
        setLeague(null);
        setMembers([]);
        setLoading(false);
        return;
      }

      setLeague(lg as League);

      // Load membership rows
      const { data: rows, error: memErr } = await supabase
        .from("league_members")
        .select("user_id, role, joined_at")
        .eq("league_id", leagueId);

      if (cancelled) return;

      if (memErr) {
        console.error("[LeagueLeaderboard] members error:", memErr);
        setErr("Failed to load league members.");
        setMembers([]);
        setLoading(false);
        return;
      }

      const membersRaw = (rows ?? []) as LeagueMemberRow[];
      if (membersRaw.length === 0) {
        setMembers([]);
        setLoading(false);
        return;
      }

      // Load profiles for those members
      const ids = Array.from(new Set(membersRaw.map((m) => m.user_id)));
      let profiles: ProfileRow[] = [];
      if (ids.length > 0) {
        const { data: profData, error: profErr } = await supabase
          .from("profiles")
          .select("id, username, avatar_url")
          .in("id", ids);

        if (!cancelled && !profErr && profData) {
          profiles = profData as ProfileRow[];
        } else if (profErr) {
          console.error("[LeagueLeaderboard] profiles error:", profErr);
        }
      }

      const profileMap = new Map<string, ProfileRow>();
      for (const p of profiles) {
        profileMap.set(p.id, p);
      }

      const mapped: MemberView[] = membersRaw.map((m) => {
        const p = profileMap.get(m.user_id) ?? null;
        return {
          user_id: m.user_id,
          role: m.role ?? "member",
          joined_at: m.joined_at,
          username: p?.username ?? null,
          avatar_url: p?.avatar_url ?? null,
        };
      });

      setMembers(mapped);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [leagueId]);

  // combine member list + stats into leaderboard rows
  const rows = useMemo(() => {
    if (!members.length) return [];

    const out = members.map((m) => {
      const s = statsByUser[m.user_id];
      const totalPicks = s?.totalPicks ?? 0;
      const wins = s?.wins ?? 0;
      const losses = s?.losses ?? 0;
      const pushes = s?.pushes ?? 0;
      const winRate = totalPicks > 0 ? Number(s!.winRate.toFixed(1)) : 0.0;
      const streakType = s?.currentStreakType ?? null;
      const streakLen = s?.currentStreakLen ?? 0;

      return {
        ...m,
        totalPicks,
        wins,
        losses,
        pushes,
        winRate,
        streakType,
        streakLen,
      };
    });

    // Sort: players with picks first, then by winRate desc, then wins desc
    out.sort((a, b) => {
      if (a.totalPicks === 0 && b.totalPicks > 0) return 1;
      if (b.totalPicks === 0 && a.totalPicks > 0) return -1;

      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (b.wins !== a.wins) return b.wins - a.wins;

      const nameA = a.username ?? "";
      const nameB = b.username ?? "";
      return nameA.localeCompare(nameB);
    });

    return out;
  }, [members, statsByUser]);

  const myRowIndex = useMemo(() => {
    if (!meId) return -1;
    return rows.findIndex((r) => r.user_id === meId);
  }, [rows, meId]);

  // ---------- loading / error ----------

  if (!leagueId) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
        <p className="text-sm text-slate-400">
          No league selected. Go back to{" "}
          <Link to="/leagues" className="text-yellow-400 underline">
            Private Leagues
          </Link>
          .
        </p>
      </div>
    );
  }

  if (loading || statsLoading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
        <h1 className="text-2xl sm:text-3xl font-bold text-yellow-400 mb-2">
          League Leaderboard
        </h1>
        <p className="text-sm text-slate-400 mb-4">
          Loading league and member stats…
        </p>
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-12 rounded-xl bg-slate-900/80 border border-slate-800 animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  if (err || statsError) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
        <h1 className="text-2xl sm:text-3xl font-bold text-yellow-400 mb-2">
          League Leaderboard
        </h1>
        <p className="text-sm text-rose-400 mb-4">
          {err ?? statsError ?? "Something went wrong."}
        </p>
        <button
          onClick={() => nav("/leagues")}
          className="px-4 py-2 rounded-xl bg-slate-800 border border-slate-600 text-sm hover:bg-slate-700"
        >
          ← Back to Private Leagues
        </button>
      </div>
    );
  }

  if (!league) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
        <p className="text-sm text-slate-400">
          League not found. You may not be a member.
        </p>
        <button
          onClick={() => nav("/leagues")}
          className="mt-3 px-4 py-2 rounded-xl bg-slate-800 border border-slate-600 text-sm hover:bg-slate-700"
        >
          ← Back to Private Leagues
        </button>
      </div>
    );
  }

  // ---------- main UI ----------

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
      <header className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-yellow-400">
          {league.name}
        </h1>
        <p className="text-xs sm:text-sm text-slate-400 mt-1">
          Private league leaderboard — using current season stats.
        </p>
        <p className="text-[11px] text-slate-500 mt-1">
          Invite code:{" "}
          <span className="font-mono text-yellow-300">
            {league.invite_code}
          </span>
        </p>
        <button
          onClick={() => nav("/leagues")}
          className="mt-3 inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-slate-900/80 border border-slate-700/80 text-slate-300 hover:text-slate-100 text-xs"
        >
          ← Back to my leagues
        </button>
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">
          No members with graded picks yet. Once people have picks on the
          season, they will appear here.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/80">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/80 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left w-12">#</th>
                <th className="px-3 py-2 text-left">Player</th>
                <th className="px-3 py-2 text-right">Record</th>
                <th className="px-3 py-2 text-right">Win %</th>
                <th className="px-3 py-2 text-right">Picks</th>
                <th className="px-3 py-2 text-right hidden sm:table-cell">
                  Streak
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const isMe = meId && r.user_id === meId;

                const hasUsername =
                  r.username && r.username.trim().length > 0;
                const displayName = hasUsername
                  ? r.username!.trim()
                  : `user_${r.user_id.slice(0, 6)}`;
                const profileSlug = hasUsername
                  ? r.username!.trim()
                  : r.user_id;
                const handle = `@${displayName
                  .toLowerCase()
                  .replace(/\s+/g, "")}`;

                const record =
                  r.totalPicks > 0
                    ? `${r.wins}-${r.losses}${
                        r.pushes ? `-${r.pushes}` : ""
                      }`
                    : "0-0";
                const winPct =
                  r.totalPicks > 0 ? `${r.winRate.toFixed(1)}%` : "—";
                const streakLabel =
                  r.totalPicks > 0
                    ? formatStreak(r.streakType, r.streakLen)
                    : "—";

                return (
                  <tr
                    key={r.user_id}
                    className={
                      "border-t border-slate-800/80 " +
                      (isMe ? "bg-yellow-400/5" : "hover:bg-slate-900/60")
                    }
                  >
                    <td className="px-3 py-2 text-left text-xs text-slate-400">
                      {idx + 1}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full overflow-hidden bg-slate-700 flex items-center justify-center text-[11px] font-semibold">
                          {r.avatar_url ? (
                            <img
                              src={r.avatar_url}
                              alt={displayName}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            displayName[0]?.toUpperCase()
                          )}
                        </div>
                        <div className="flex flex-col">
                          <Link
                            to={`/u/${profileSlug}`}
                            className="text-slate-100 hover:text-yellow-300 text-sm"
                          >
                            {displayName}
                          </Link>
                          <span className="text-[10px] text-slate-500">
                            {handle} ·{" "}
                            <span className="capitalize">{r.role}</span>
                            {isMe ? " • You" : ""}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-slate-100">
                      {record}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-100">
                      {winPct}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-100">
                      {r.totalPicks}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300 hidden sm:table-cell">
                      {streakLabel}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {myRowIndex >= 0 && (
        <p className="mt-3 text-[11px] text-slate-500">
          You are currently{" "}
          <span className="text-yellow-300 font-semibold">
            #{myRowIndex + 1}
          </span>{" "}
          in this league.
        </p>
      )}
    </div>
  );
}