// src/pages/Leagues.tsx
import { useEffect, useState, FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

type LeagueRow = {
  league_id: string;
  role: string | null;
  // Supabase join can come back as an object OR an array (depending on config),
  // so keep this loose and normalize in mapLeagueRows.
  leagues: any;
};

type LeagueView = {
  id: string;
  name: string;
  invite_code: string;
  role: string;
  isOwner: boolean;
  contest_mode: string; // 'pickem' | 'mm' | 'both'
};

function randomCode(len = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

// Normalize raw league_member rows → clean LeagueView[]
function mapLeagueRows(rows: LeagueRow[], userId: string): LeagueView[] {
  return rows
    .map((r) => {
      let lg = r.leagues;

      if (!lg) return null;
      if (Array.isArray(lg)) {
        if (!lg.length) return null;
        lg = lg[0]; // take first if it somehow comes back as an array
      }

      return {
        id: lg.id as string,
        name: lg.name as string,
        invite_code: lg.invite_code as string,
        role: r.role ?? "member",
        isOwner: lg.created_by === userId,
        contest_mode: (lg.contest_mode as string) || "pickem",
      };
    })
    .filter((x): x is LeagueView => x !== null);
}

function renderContestModeLabel(mode: string) {
  switch (mode) {
    case "mm":
      return "Moneyline Mastery only";
    case "both":
      return "Pick'em + Moneyline Mastery";
    case "pickem":
    default:
      return "Pick'em only";
  }
}

export default function Leagues() {
  const nav = useNavigate();

  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);

  const [leagues, setLeagues] = useState<LeagueView[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createMode, setCreateMode] = useState<"pickem" | "mm" | "both">(
    "pickem"
  );
  const [createMsg, setCreateMsg] = useState<string | null>(null);

  const [joining, setJoining] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinMsg, setJoinMsg] = useState<string | null>(null);

  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  // 1) Get current user
  useEffect(() => {
    let mounted = true;

    async function loadSession() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!mounted) return;

      const user = session?.user ?? null;
      setUserId(user?.id ?? null);
      setEmail(user?.email ?? null);
    }

    loadSession();

    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      const user = session?.user ?? null;
      setUserId(user?.id ?? null);
      setEmail(user?.email ?? null);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // 2) Load leagues for this user
  useEffect(() => {
    if (!userId) {
      setLeagues([]);
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      setLoading(true);
      setErr(null);

      const { data, error } = await supabase
        .from("league_members")
        .select(
          `
          league_id,
          role,
          leagues (
            id,
            name,
            invite_code,
            created_by,
            contest_mode
          )
        `
        )
        .eq("user_id", userId)
        .order("joined_at", { ascending: true });

      if (cancelled) return;

      if (error) {
        console.error("[Leagues] load error:", error);
        setErr("Failed to load leagues.");
        setLeagues([]);
        setLoading(false);
        return;
      }

      const rows = (data ?? []) as LeagueRow[];
      const mapped = mapLeagueRows(rows, userId);

      setLeagues(mapped);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function handleCreateLeague(e: FormEvent) {
    e.preventDefault();
    if (!userId) return;
    if (!createName.trim()) {
      setCreateMsg("Enter a league name first.");
      return;
    }

    setCreating(true);
    setCreateMsg(null);

    try {
      const inviteCode = randomCode(6);

      const { data: league, error: leagueErr } = await supabase
        .from("leagues")
        .insert({
          name: createName.trim(),
          invite_code: inviteCode,
          created_by: userId,
          contest_mode: createMode,
        })
        .select("id, name, invite_code, created_by")
        .single();

      if (leagueErr || !league) {
        console.error("[Leagues] create league error:", leagueErr);
        setCreateMsg(leagueErr?.message ?? "Failed to create league.");
        return;
      }

      // auto-join as owner
      const { error: memberErr } = await supabase
        .from("league_members")
        .insert({
          league_id: league.id,
          user_id: userId,
          role: "owner",
        });

      if (memberErr) {
        console.error("[Leagues] add owner member error:", memberErr);
        setCreateMsg("League created, but failed to join as member.");
      } else {
        setCreateMsg(`League created! Invite code: ${league.invite_code}`);
      }

      setCreateName("");
      setCreateMode("pickem");

      // Reload list
      const { data: lmData } = await supabase
        .from("league_members")
        .select(
          `
          league_id,
          role,
          leagues (
            id,
            name,
            invite_code,
            created_by,
            contest_mode
          )
        `
        )
        .eq("user_id", userId);

      const rows = (lmData ?? []) as LeagueRow[];
      const mapped = mapLeagueRows(rows, userId);
      setLeagues(mapped);
    } finally {
      setCreating(false);
    }
  }

  async function handleJoinLeague(e: FormEvent) {
    e.preventDefault();
    if (!userId) return;

    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setJoinMsg("Enter an invite code first.");
      return;
    }

    setJoining(true);
    setJoinMsg(null);

    try {
      const { data: league, error: leagueErr } = await supabase
        .from("leagues")
        .select("id, name, invite_code, created_by")
        .eq("invite_code", code)
        .maybeSingle();

      if (leagueErr || !league) {
        setJoinMsg("No league found with that code.");
        return;
      }

      // insert membership (if not already a member)
      const { error: memberErr } = await supabase
        .from("league_members")
        .insert({
          league_id: league.id,
          user_id: userId,
          role: "member",
        });

      if (memberErr) {
        console.error("[Leagues] join member error:", memberErr);
        setJoinMsg(memberErr.message);
      } else {
        setJoinMsg(`Joined "${league.name}"!`);
      }

      setJoinCode("");

      // Reload leagues
      const { data: lmData } = await supabase
        .from("league_members")
        .select(
          `
          league_id,
          role,
          leagues (
            id,
            name,
            invite_code,
            created_by,
            contest_mode
          )
        `
        )
        .eq("user_id", userId);

      const rows = (lmData ?? []) as LeagueRow[];
      const mapped = mapLeagueRows(rows, userId);
      setLeagues(mapped);
    } finally {
      setJoining(false);
    }
  }

  function handleCopyInviteCode(code: string) {
    if (typeof window === "undefined") return;

    try {
      const text = code.toUpperCase();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      } else {
        const el = document.createElement("textarea");
        el.value = text;
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      }
      setCopiedCode(text);
      window.setTimeout(() => setCopiedCode(null), 2000);
    } catch (err) {
      console.error("[Leagues] failed to copy invite code", err);
    }
  }

  if (!userId) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-10 text-slate-200">
        <h1 className="text-2xl sm:text-3xl font-bold text-yellow-400 mb-3">
          Private Leagues
        </h1>
        <p className="text-sm text-slate-400 mb-4">
          Sign in to create or join a private PickForge league with your friends.
        </p>
        <button
          onClick={() => nav("/login")}
          className="px-4 py-2 rounded-xl bg-yellow-400 text-slate-900 font-semibold hover:bg-yellow-300"
        >
          Go to Login
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-10 text-slate-200">
      <header className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-yellow-400">
          Private Leagues
        </h1>
        <p className="text-xs sm:text-sm text-slate-400 mt-1">
          Create a league for your friends or join one with an invite code.
        </p>
        {email && (
          <p className="text-[11px] text-slate-500 mt-1">
            Signed in as <span className="text-slate-200">{email}</span>
          </p>
        )}
      </header>

      {/* Create league */}
      <section className="mb-6 bg-slate-900/70 border border-slate-700 rounded-2xl p-4">
        <h2 className="text-sm font-semibold text-slate-100 mb-2">
          Create a league
        </h2>
        <form
          onSubmit={handleCreateLeague}
          className="flex flex-col gap-2"
        >
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              className="flex-1 rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-sm focus:border-yellow-400"
              placeholder="League name (e.g. Sunday Sickos)"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
            />
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 rounded-xl bg-yellow-400 text-slate-900 font-semibold text-sm hover:bg-yellow-300 disabled:opacity-70"
            >
              {creating ? "Creating…" : "Create"}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-300 mt-1">
            <span className="uppercase tracking-[0.14em] text-slate-500">
              Contest type
            </span>
            <label className="inline-flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name="contest_mode"
                value="pickem"
                checked={createMode === "pickem"}
                onChange={() => setCreateMode("pickem")}
                className="h-3 w-3"
              />
              <span>Pick&apos;em only</span>
            </label>
            <label className="inline-flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name="contest_mode"
                value="mm"
                checked={createMode === "mm"}
                onChange={() => setCreateMode("mm")}
                className="h-3 w-3"
              />
              <span>Moneyline Mastery only</span>
            </label>
            <label className="inline-flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name="contest_mode"
                value="both"
                checked={createMode === "both"}
                onChange={() => setCreateMode("both")}
                className="h-3 w-3"
              />
              <span>Pick&apos;em + MM</span>
            </label>
          </div>
        </form>
      </section>

      {/* Join league */}
      <section className="mb-6 bg-slate-900/70 border border-slate-700 rounded-2xl p-4">
        <h2 className="text-sm font-semibold text-slate-100 mb-2">
          Join a league
        </h2>
        <form
          onSubmit={handleJoinLeague}
          className="flex flex-col sm:flex-row gap-2"
        >
          <input
            type="text"
            className="flex-1 rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-sm uppercase tracking-[0.15em] focus:border-yellow-400"
            placeholder="INVITE CODE"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          />
          <button
            type="submit"
            disabled={joining}
            className="px-4 py-2 rounded-xl bg-slate-800 border border-slate-600 text-slate-100 text-sm hover:bg-slate-700 disabled:opacity-70"
          >
            {joining ? "Joining…" : "Join"}
          </button>
        </form>
        {joinMsg && (
          <p className="text-[11px] text-slate-300 mt-2">{joinMsg}</p>
        )}
      </section>

      {/* My leagues */}
      <section className="bg-slate-900/70 border border-slate-700 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-slate-100">My leagues</h2>
          {loading && (
            <span className="text-[11px] text-slate-500">Loading…</span>
          )}
        </div>

        {err && <p className="text-xs text-rose-400 mb-1">{err}</p>}

        {!loading && !err && leagues.length === 0 && (
          <p className="text-xs text-slate-500">
            You’re not in any leagues yet. Create one above or join with a code.
          </p>
        )}

        {leagues.length > 0 && (
          <ul className="space-y-2 mt-1">
            {leagues.map((lg) => {
              const leaderboardLink =
                lg.contest_mode === "mm"
                  ? `/leaderboard?lid=${lg.id}&metric=mm&view=season`
                  : `/leaderboard?lid=${lg.id}`;

              return (
                <li
                  key={lg.id}
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between bg-slate-800/80 border border-slate-700 rounded-xl px-3 py-2 text-sm gap-2"
                >
                  <div>
                    <p className="font-semibold text-slate-100">{lg.name}</p>
                    <p className="text-[11px] text-slate-500">
                      Mode:{" "}
                      <span className="text-slate-300">
                        {renderContestModeLabel(lg.contest_mode)}
                      </span>
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Role:{" "}
                      <span className="text-slate-300">
                        {lg.isOwner ? "Owner" : lg.role}
                      </span>{" "}
                      • Invite code:{" "}
                      <button
                        type="button"
                        onClick={() => handleCopyInviteCode(lg.invite_code)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-900 border border-yellow-400/60 text-[10px] font-mono text-yellow-200 hover:bg-slate-800"
                      >
                        {lg.invite_code}
                        <span className="text-[9px] uppercase tracking-[0.16em]">
                          Copy
                        </span>
                      </button>
                      {copiedCode === lg.invite_code.toUpperCase() && (
                        <span className="ml-2 text-[10px] text-emerald-300">
                          Copied
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      to={leaderboardLink}
                      className="px-3 py-1.5 rounded-full text-[11px] bg-slate-900 border border-slate-600 hover:border-yellow-400 hover:text-yellow-300"
                    >
                      View leaderboard
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}