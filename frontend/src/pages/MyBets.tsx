// src/pages/MyBets.tsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import type { BetRow, BetStatus, BetVisibility } from "../types/bets";
import { calcToWin, calcResultAmount } from "../lib/betMath";
import { usePageSeo } from "../hooks/usePageSeo";

type NewBetForm = {
  sport: string;
  book_name: string;
  event_name: string;
  event_date: string; // yyyy-mm-dd or empty
  bet_type: string;
  selection: string;
  odds_american: string;
  stake: string;
  visibility: BetVisibility;
  notes: string;
  confidence: string; // 1–5 as a string for the form
};

type TimeFilter = "all" | "7d" | "30d" | "ytd";
type SortKey = "created" | "stake" | "result";
type SortDir = "asc" | "desc";

function getPrimaryDate(b: BetRow): Date | null {
  // Prefer event_date if present, otherwise created_at
  if (b.event_date) {
    const d = new Date(b.event_date);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (b.created_at) {
    const d = new Date(b.created_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function toDateKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function MyBets() {
  usePageSeo({
    title: "Bet Tracker — Log & Grade Your Sports Bets | PickForge",
    description:
      "Track every bet you place across NFL, NBA, NCAAF and more. Log odds, stakes and results, and see your net profit and ROI over time.",
  });

  const [userId, setUserId] = useState<string | null>(null);
  const [bets, setBets] = useState<BetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  // Private unit size for this user (used to normalize stakes into "units")
  // Stored in localStorage so it persists on this device.
  const [unitSize, setUnitSize] = useState<number>(() => {
    if (typeof window === "undefined") return 50;
    const stored = window.localStorage.getItem("pf_unit_size");
    const n = stored ? Number(stored) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 50;
  });
  // Persist unit size locally so it sticks between sessions on this device
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("pf_unit_size", String(unitSize));
  }, [unitSize]);

  const [form, setForm] = useState<NewBetForm>({
    sport: "nfl",
    book_name: "",
    event_name: "",
    event_date: "",
    bet_type: "spread",
    selection: "",
    odds_american: "",
    stake: "",
    visibility: "private",
    notes: "",
    confidence: "",
  });

  // Which bet (if any) we're editing
  const [editingBet, setEditingBet] = useState<BetRow | null>(null);

  // Filters + sorting
  const [filterSport, setFilterSport] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<BetStatus | "all">("all");
  const [filterTime, setFilterTime] = useState<TimeFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("created");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Calendar view state (for daily ROI)
  const [calendarMonth, setCalendarMonth] = useState<number>(() => {
    const now = new Date();
    return now.getMonth(); // 0-11
  });
  const [calendarYear, setCalendarYear] = useState<number>(() => {
    const now = new Date();
    return now.getFullYear();
  });
  // Selected calendar day in YYYY-MM-DD format (or null for no day filter)
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<string | null>(null);

  // 1) Load current user
  useEffect(() => {
    let cancelled = false;

    async function loadAuth() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (cancelled) return;

      const u = session?.user ?? null;
      setUserId(u?.id ?? null);
    }

    loadAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  // Helper to load bets for a given user
  async function loadBetsForUser(uId: string) {
    setLoading(true);
    setError(null);

    try {
      const { data, error } = await supabase
        .from("bets")
        .select("*")
        .eq("user_id", uId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setBets((data ?? []) as BetRow[]);
    } catch (e: any) {
      console.error("[MyBets] load error:", e);
      setError(e.message ?? "Failed to load bets");
    } finally {
      setLoading(false);
    }
  }
  // 2) Load bets for this user
  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      try {
        const { data, error } = await supabase
          .from("bets")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });

        if (error) throw error;
        if (!cancelled) setBets((data ?? []) as BetRow[]);
      } catch (e: any) {
        console.error("[MyBets] load error:", e);
        if (!cancelled) setError(e.message ?? "Failed to load bets");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);
  // Handler: Refresh outcomes from backend and reload bets
  async function handleRefreshOutcomes() {
    if (!userId) return;

    setRefreshing(true);
    setRefreshMsg(null);
    setError(null);

    try {
      const resp = await fetch("/api/bets/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, daysFrom: 7 }),
      });

      const json = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg = json?.detail || json?.error || "Refresh failed";
        throw new Error(msg);
      }

      const updated = typeof json?.updated === "number" ? json.updated : 0;
      const checked = typeof json?.checked === "number" ? json.checked : 0;
      setRefreshMsg(`Checked ${checked} open bets. Updated ${updated}.`);

      // Reload after settlement
      await loadBetsForUser(userId);
    } catch (e: any) {
      console.error("[MyBets] refresh outcomes error:", e);
      setError(e.message ?? "Failed to refresh outcomes");
    } finally {
      setRefreshing(false);
    }
  }

  // 3) Filter + sort
  const filteredAndSortedBets = useMemo(() => {
    if (!bets.length) return [] as BetRow[];

    let result = [...bets];

    // Filter by sport
    if (filterSport !== "all") {
      result = result.filter((b) => b.sport === filterSport);
    }

    // Filter by status
    if (filterStatus !== "all") {
      result = result.filter((b) => b.status === filterStatus);
    }

    // Filter by time window
    if (filterTime !== "all") {
      const now = new Date();
      let cutoff: Date | null = null;

      if (filterTime === "7d") {
        cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - 7);
      } else if (filterTime === "30d") {
        cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - 30);
      } else if (filterTime === "ytd") {
        cutoff = new Date(now.getFullYear(), 0, 1);
      }

      if (cutoff) {
        const cutoffMs = cutoff.getTime();
        result = result.filter((b) => {
          const d = getPrimaryDate(b);
          if (!d) return true; // keep if we do not know
          return d.getTime() >= cutoffMs;
        });
      }
    }

    // Sort
    result.sort((a, b) => {
      let cmp = 0;

      if (sortKey === "created") {
        const da = getPrimaryDate(a)?.getTime() ?? 0;
        const db = getPrimaryDate(b)?.getTime() ?? 0;
        cmp = da - db;
      } else if (sortKey === "stake") {
        cmp = a.stake - b.stake;
      } else if (sortKey === "result") {
        cmp = a.result_amount - b.result_amount;
      }

      return sortDir === "asc" ? cmp : -cmp;
    });

    return result;
  }, [bets, filterSport, filterStatus, filterTime, sortKey, sortDir]);

  // 4) Derived stats (based on visible bets, not all-time)
  const summary = useMemo(() => {
    if (!filteredAndSortedBets.length) {
      return {
        total: 0,
        wins: 0,
        losses: 0,
        pushes: 0,
        net: 0,
        staked: 0,
        roi: 0,
      };
    }

    let wins = 0;
    let losses = 0;
    let pushes = 0;
    let net = 0;
    let staked = 0;

    for (const b of filteredAndSortedBets) {
      staked += b.stake;
      net += b.result_amount;

      if (b.status === "won") wins++;
      else if (b.status === "lost") losses++;
      else if (b.status === "push") pushes++;
    }

    const total = wins + losses + pushes;
    const roi = staked > 0 ? (net / staked) * 100 : 0;

    return {
      total,
      wins,
      losses,
      pushes,
      net: +net.toFixed(2),
      staked: +staked.toFixed(2),
      roi: +roi.toFixed(2),
    };
  }, [filteredAndSortedBets]);

  // Daily aggregation for calendar (based on visible bets)
  const dailyStats = useMemo(() => {
    const map = new Map<
      string,
      { staked: number; net: number; total: number }
    >();

    for (const b of filteredAndSortedBets) {
      const d = getPrimaryDate(b);
      if (!d) continue;
      const key = toDateKey(d);
      if (!map.has(key)) {
        map.set(key, { staked: 0, net: 0, total: 0 });
      }
      const entry = map.get(key)!;
      entry.staked += b.stake;
      entry.net += b.result_amount;
      entry.total += 1;
    }

    return map;
  }, [filteredAndSortedBets]);

  // Bets for table:
  // - If a calendar day is selected, show all bets from that day.
  // - Otherwise, prefer all pending, else most recent 5 (from filtered/sorted).
  const betsForTable = useMemo(() => {
    if (!filteredAndSortedBets.length) return [] as BetRow[];

    if (selectedCalendarDate) {
      return filteredAndSortedBets.filter((b) => {
        const d = getPrimaryDate(b);
        if (!d) return false;
        return toDateKey(d) === selectedCalendarDate;
      });
    }

    // Prefer showing all pending bets
    const pending = filteredAndSortedBets.filter((b) => b.status === "pending");
    if (pending.length > 0) {
      return pending;
    }

    // If there are no pending bets, show the most recent 5 (already sorted)
    return filteredAndSortedBets.slice(0, 5);
  }, [filteredAndSortedBets, selectedCalendarDate]);

  // 4b) Graded bets + breakdown by sport (based on visible bets)
  const gradedBets = useMemo(
    () =>
      filteredAndSortedBets.filter(
        (b) => b.status === "won" || b.status === "lost" || b.status === "push"
      ),
    [filteredAndSortedBets]
  );

  const breakdownBySport = useMemo(() => {
    if (!gradedBets.length) return [] as {
      sport: string;
      total: number;
      wins: number;
      losses: number;
      pushes: number;
      net: number;
    }[];

    const sportMap = new Map<
      string,
      { sport: string; total: number; wins: number; losses: number; pushes: number; net: number }
    >();

    for (const b of gradedBets) {
      const key = (b.sport || "other").toUpperCase();
      if (!sportMap.has(key)) {
        sportMap.set(key, {
          sport: key,
          total: 0,
          wins: 0,
          losses: 0,
          pushes: 0,
          net: 0,
        });
      }

      const entry = sportMap.get(key)!;
      entry.total += 1;
      entry.net += b.result_amount;
      if (b.status === "won") entry.wins += 1;
      else if (b.status === "lost") entry.losses += 1;
      else if (b.status === "push") entry.pushes += 1;
    }

    return Array.from(sportMap.values()).sort((a, b) => b.total - a.total);
  }, [gradedBets]);

  const breakdownByBetType = useMemo(() => {
    if (!gradedBets.length)
      return [] as {
        bet_type: string;
        total: number;
        wins: number;
        losses: number;
        pushes: number;
        net: number;
      }[];

    const map = new Map<
      string,
      {
        bet_type: string;
        total: number;
        wins: number;
        losses: number;
        pushes: number;
        net: number;
      }
    >();

    for (const b of gradedBets) {
      const key = (b.bet_type || "other").toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          bet_type: key,
          total: 0,
          wins: 0,
          losses: 0,
          pushes: 0,
          net: 0,
        });
      }

      const entry = map.get(key)!;
      entry.total += 1;
      entry.net += b.result_amount;
      if (b.status === "won") entry.wins += 1;
      else if (b.status === "lost") entry.losses += 1;
      else if (b.status === "push") entry.pushes += 1;
    }

    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [gradedBets]);

  // 5) Form handlers
  function updateField<K extends keyof NewBetForm>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function resetForm() {
    setForm({
      sport: "nfl",
      book_name: "",
      event_name: "",
      event_date: "",
      bet_type: "spread",
      selection: "",
      odds_american: "",
      stake: "",
      visibility: "private",
      notes: "",
      confidence: "",
    });
    setEditingBet(null);
  }

  function startEdit(bet: BetRow) {
    setEditingBet(bet);
    setForm({
      sport: bet.sport || "other",
      book_name: bet.book_name || "",
      event_name: bet.event_name || "",
      event_date: bet.event_date ? bet.event_date.slice(0, 10) : "",
      bet_type: bet.bet_type || "other",
      selection: bet.selection || "",
      odds_american: String(bet.odds_american ?? ""),
      stake: String(bet.stake ?? ""),
      visibility: bet.visibility ?? "private",
      notes: (bet as any).notes ?? "",
      confidence:
        typeof (bet as any).confidence === "number" &&
        !Number.isNaN((bet as any).confidence)
          ? String((bet as any).confidence)
          : "",
    });
  }

  async function handleDeleteBet(bet: BetRow) {
    const ok = window.confirm("Delete this bet? This cannot be undone.");
    if (!ok) return;

    const previous = bets;
    setBets((prev) => prev.filter((b) => b.id !== bet.id));

    const { error } = await supabase.from("bets").delete().eq("id", bet.id);

    if (error) {
      console.error("[MyBets] delete error:", error);
      alert("Failed to delete bet. Please try again.");
      setBets(previous); // rollback
      return;
    }

    if (editingBet && editingBet.id === bet.id) {
      resetForm();
    }
  }

  async function handleAddBet(e: React.FormEvent) {
    e.preventDefault();
    if (!userId) return;

    const odds = Number(form.odds_american);
    const stake = Number(form.stake);
    const isEditing = !!editingBet;

    if (!form.event_name.trim()) {
      alert("Event name is required.");
      return;
    }
    if (!form.selection.trim()) {
      alert("Selection is required.");
      return;
    }
    if (!Number.isFinite(odds) || odds === 0) {
      alert("Enter valid American odds (e.g., -110 or +145).");
      return;
    }
    if (!Number.isFinite(stake) || stake <= 0) {
      alert("Stake must be > 0.");
      return;
    }

    const eventDateIso = form.event_date
      ? new Date(form.event_date + "T00:00:00").toISOString()
      : null;

    const confidenceNum = form.confidence ? Number(form.confidence) : null;
    const cleanConfidence =
      confidenceNum !== null && Number.isFinite(confidenceNum) && confidenceNum > 0
        ? confidenceNum
        : null;

    setSaving(true);
    setError(null);

    try {
      if (isEditing && editingBet) {
        const toWin = calcToWin(odds, stake);

        const { data, error } = await supabase
          .from("bets")
          .update({
            sport: form.sport || "other",
            book_name: form.book_name || null,
            event_name: form.event_name.trim(),
            event_date: eventDateIso,
            bet_type: form.bet_type || "other",
            selection: form.selection.trim(),
            odds_american: odds,
            stake,
            to_win: toWin,
            visibility: form.visibility ?? "private",
            notes: form.notes.trim() || null,
            confidence: cleanConfidence,
          })
          .eq("id", editingBet.id)
          .select("*")
          .single();

        if (error) {
          throw error;
        }

        setBets((prev) =>
          prev.map((b) => (b.id === editingBet.id ? (data as BetRow) : b))
        );
      } else {
        const toWin = calcToWin(odds, stake);
        const result_amount = 0;

        const { data, error } = await supabase
          .from("bets")
          .insert({
            user_id: userId,
            sport: form.sport || "other",
            book_name: form.book_name || null,
            event_name: form.event_name.trim(),
            event_date: eventDateIso,
            bet_type: form.bet_type || "other",
            selection: form.selection.trim(),
            odds_american: odds,
            stake,
            to_win: toWin,
            status: "pending",
            result_amount,
            visibility: form.visibility ?? "private",
            notes: form.notes.trim() || null,
            confidence: cleanConfidence,
          })
          .select("*")
          .single();

        if (error) {
          throw error;
        }

        setBets((prev) => [data as BetRow, ...prev]);
      }

      resetForm();
    } catch (e: any) {
      console.error("[MyBets] insert/update error:", e);
      setError(e.message ?? "Failed to save bet");
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(bet: BetRow, newStatus: BetStatus) {
    if (bet.status === newStatus) return;

    const newResult = calcResultAmount(newStatus, bet.stake, bet.to_win);

    // optimistic update
    setBets((prev) =>
      prev.map((b) =>
        b.id === bet.id
          ? { ...b, status: newStatus, result_amount: newResult }
          : b
      )
    );

    const { error } = await supabase
      .from("bets")
      .update({
        status: newStatus,
        result_amount: newResult,
      })
      .eq("id", bet.id);

    if (error) {
      console.error("[MyBets] update status error:", error);
      // minimal rollback: reload bets on failure
      const { data } = await supabase
        .from("bets")
        .select("*")
        .eq("user_id", bet.user_id)
        .order("created_at", { ascending: false });
      setBets((data ?? []) as BetRow[]);
    }
  }

  async function handleVisibilityChange(
    bet: BetRow,
    newVisibility: BetVisibility
  ) {
    if (bet.visibility === newVisibility) return;

    const previous = bets;
    setBets((prev) =>
      prev.map((b) =>
        b.id === bet.id ? { ...b, visibility: newVisibility } : b
      )
    );

    const { error } = await supabase
      .from("bets")
      .update({ visibility: newVisibility })
      .eq("id", bet.id);

    if (error) {
      console.error("[MyBets] update visibility error:", error);
      setBets(previous); // rollback
    }
  }

  // 6) UI

  if (!userId) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10 text-slate-200">
        <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400 mb-2">
          Bet Tracker
        </h1>
        <p className="text-sm text-slate-400">
          Sign in to track your bets and see your record.
        </p>
      </div>
    );
  }

  const visibleCount = filteredAndSortedBets.length;
  const totalCount = bets.length;
  const isEditing = !!editingBet;

  const selectedDateLabel = selectedCalendarDate
    ? new Date(selectedCalendarDate).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  const monthDate = new Date(calendarYear, calendarMonth, 1);
  const monthLabel = monthDate.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const startWeekday = monthDate.getDay(); // 0 (Sun) - 6 (Sat)

  function changeMonth(delta: number) {
    setCalendarMonth((prevMonth) => {
      let newMonth = prevMonth + delta;
      let newYear = calendarYear;

      if (newMonth < 0) {
        newMonth = 11;
        newYear = calendarYear - 1;
      } else if (newMonth > 11) {
        newMonth = 0;
        newYear = calendarYear + 1;
      }

      if (newYear !== calendarYear) {
        setCalendarYear(newYear);
      }

      return newMonth;
    });
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 text-slate-200">
      <header className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-yellow-400">
            Bet Tracker
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Log your bets across any sport and see your record and profit/loss.
          </p>
          {totalCount > 0 && (
            <p className="text-[11px] text-slate-500 mt-1">
              Showing {visibleCount} of {totalCount} bets
              {filterSport !== "all" ||
              filterStatus !== "all" ||
              filterTime !== "all"
                ? " (filtered)"
                : ""}
              .
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs sm:text-sm">
          <div className="bg-slate-900/80 border border-slate-700 rounded-xl px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">
              Bets
            </div>
            <div className="text-lg font-semibold">{summary.total}</div>
          </div>
          <div className="bg-slate-900/80 border border-slate-700 rounded-xl px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">
              Record
            </div>
            <div className="text-lg font-semibold">
              {summary.wins}-{summary.losses}
              {summary.pushes ? `-${summary.pushes}` : ""}
            </div>
          </div>
          <div className="bg-slate-900/80 border border-slate-700 rounded-xl px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">
              Net
            </div>
            <div
              className={
                "text-lg font-semibold " +
                (summary.net > 0
                  ? "text-emerald-400"
                  : summary.net < 0
                  ? "text-rose-400"
                  : "text-slate-100")
              }
            >
              {summary.net >= 0 ? "+" : ""}
              ${summary.net.toFixed(2)}
              {unitSize > 0 && (
                <span className="ml-1 text-[11px] text-slate-400">
                  ({(summary.net / unitSize).toFixed(2)}u)
                </span>
              )}
            </div>
          </div>
          <div className="bg-slate-900/80 border border-slate-700 rounded-xl px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">
              ROI
            </div>
            <div className="text-lg font-semibold">
              {summary.roi.toFixed(1)}%
            </div>
          </div>
        </div>
      </header>

      {/* Filters */}
      <section className="mb-4 bg-slate-950/80 border border-slate-800 rounded-2xl p-3 sm:p-4">
        <div className="flex flex-wrap gap-3 items-center text-xs sm:text-sm">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="filter-sport"
              className="text-[10px] uppercase tracking-wide text-slate-500"
            >
              Sport
            </label>
            <select
              id="filter-sport"
              aria-label="Filter bets by sport"
              value={filterSport}
              onChange={(e) => setFilterSport(e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs sm:text-sm"
            >
              <option value="all">All</option>
              <option value="nfl">NFL</option>
              <option value="ncaaf">NCAAF</option>
              <option value="nba">NBA</option>
              <option value="mlb">MLB</option>
              <option value="golf">Golf</option>
              <option value="soccer">Soccer</option>
              <option value="multi">Multi-sport</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="filter-status"
              className="text-[10px] uppercase tracking-wide text-slate-500"
            >
              Status
            </label>
            <select
              id="filter-status"
              aria-label="Filter bets by status"
              value={filterStatus}
              onChange={(e) =>
                setFilterStatus(e.target.value as BetStatus | "all")
              }
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs sm:text-sm"
            >
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
              <option value="push">Push</option>
              <option value="void">Void</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="filter-time"
              className="text-[10px] uppercase tracking-wide text-slate-500"
            >
              Time
            </label>
            <select
              id="filter-time"
              aria-label="Filter bets by time window"
              value={filterTime}
              onChange={(e) => setFilterTime(e.target.value as TimeFilter)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs sm:text-sm"
            >
              <option value="all">All time</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="ytd">Year to date</option>
            </select>
          </div>

          {/* Unit size slider */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor="unit-size"
              className="text-[10px] uppercase tracking-wide text-slate-500"
            >
              Unit size (private)
            </label>
            <div className="flex items-center gap-2">
              <input
                id="unit-size"
                type="range"
                min={5}
                max={500}
                step={5}
                value={unitSize}
                onChange={(e) => setUnitSize(Number(e.target.value))}
                className="w-32 sm:w-40"
              />
              <span className="text-[11px] text-slate-300 whitespace-nowrap">
                1u = ${unitSize.toFixed(0)}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-1 ml-auto mr-2">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">
              Sort
            </span>
            <div className="flex gap-2">
              <label className="sr-only" htmlFor="filter-sort-key">
                Sort bets by field
              </label>
              <select
                id="filter-sort-key"
                aria-label="Sort bets by field"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs sm:text-sm"
              >
                <option value="created">Date</option>
                <option value="stake">Stake</option>
                <option value="result">Result</option>
              </select>

              <label className="sr-only" htmlFor="filter-sort-dir">
                Sort direction
              </label>
              <select
                id="filter-sort-dir"
                aria-label="Sort direction"
                value={sortDir}
                onChange={(e) => setSortDir(e.target.value as SortDir)}
                className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs sm:text-sm"
              >
                <option value="desc">Desc</option>
                <option value="asc">Asc</option>
              </select>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">
              Live
            </span>
            <button
              type="button"
              onClick={handleRefreshOutcomes}
              disabled={refreshing}
              className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs sm:text-sm hover:bg-slate-800 disabled:opacity-60"
              title="Fetch recent scores via Odds API and settle pending bets"
            >
              {refreshing ? "Refreshing..." : "Refresh outcomes"}
            </button>
          </div>
        </div>
        {refreshMsg && (
          <p className="mt-2 text-[11px] text-slate-400">{refreshMsg}</p>
        )}
      </section>

      {/* Betting breakdown based on current filters */}
      <section className="mb-4 bg-slate-950/80 border border-slate-800 rounded-2xl p-3 sm:p-4">
      {/* Daily ROI calendar */}
      <section className="mb-6 bg-slate-950/80 border border-slate-800 rounded-2xl p-3 sm:p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-slate-100">
            Daily ROI (calendar view)
          </h2>
          <div className="flex items-center gap-2 text-[11px] text-slate-300">
            <button
              type="button"
              onClick={() => changeMonth(-1)}
              className="px-2 py-1 rounded-full bg-slate-900/80 border border-slate-700/80 hover:text-slate-100"
            >
              ◀
            </button>
            <span className="font-medium text-slate-100">{monthLabel}</span>
            <button
              type="button"
              onClick={() => changeMonth(1)}
              className="px-2 py-1 rounded-full bg-slate-900/80 border border-slate-700/80 hover:text-slate-100"
            >
              ▶
            </button>
          </div>
        </div>

        <p className="text-[11px] text-slate-500 mb-2">
          Each day shows ROI based on the bets in this view. Click a day to see all bets from that date. Click again to clear.
        </p>

        <div className="grid grid-cols-7 gap-1 text-[10px] sm:text-[11px] mb-2 text-slate-400">
          <div className="text-center">Sun</div>
          <div className="text-center">Mon</div>
          <div className="text-center">Tue</div>
          <div className="text-center">Wed</div>
          <div className="text-center">Thu</div>
          <div className="text-center">Fri</div>
          <div className="text-center">Sat</div>
        </div>

        <div className="grid grid-cols-7 gap-1 text-[11px]">
          {Array.from({ length: startWeekday + daysInMonth }).map((_, idx) => {
            if (idx < startWeekday) {
              return <div key={idx} className="h-10 sm:h-11" />;
            }

            const dayNum = idx - startWeekday + 1;
            const dateObj = new Date(calendarYear, calendarMonth, dayNum);
            const key = toDateKey(dateObj);
            const stats = dailyStats.get(key);
            const hasBets = !!stats;
            const roi =
              stats && stats.staked > 0 ? (stats.net / stats.staked) * 100 : 0;

            let bgClass =
              "bg-slate-900/70 border border-slate-800 text-slate-300";
            if (hasBets) {
              if (roi > 0.5) {
                bgClass =
                  "bg-emerald-500/15 border border-emerald-500/60 text-emerald-200";
              } else if (roi < -0.5) {
                bgClass =
                  "bg-rose-500/15 border border-rose-500/60 text-rose-200";
              } else {
                bgClass =
                  "bg-slate-700/70 border border-slate-600 text-slate-100";
              }
            }

            const isSelected = selectedCalendarDate === key;

            return (
              <button
                key={idx}
                type="button"
                onClick={() =>
                  setSelectedCalendarDate((prev) => (prev === key ? null : key))
                }
                className={
                  "h-10 sm:h-11 rounded-lg flex flex-col items-center justify-center px-0.5 text-[10px] sm:text-[11px] transition " +
                  bgClass +
                  (isSelected
                    ? " ring-2 ring-yellow-400 ring-offset-2 ring-offset-slate-950"
                    : "")
                }
              >
                <span className="font-semibold">{dayNum}</span>
                <span className="text-[9px] sm:text-[10px]">
                  {hasBets && stats
                    ? `${roi >= 0 ? "+" : ""}${roi.toFixed(0)}%`
                    : "—"}
                </span>
              </button>
            );
          })}
        </div>

        {selectedDateLabel && (
          <p className="mt-2 text-[11px] text-slate-400">
            Showing bets for{" "}
            <span className="font-semibold">{selectedDateLabel}</span> in the
            table below.
          </p>
        )}
      </section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-slate-100">
            Betting breakdown
          </h2>
          <p className="text-[10px] text-slate-500">
            Based on {filteredAndSortedBets.length} visible bet
            {filteredAndSortedBets.length === 1 ? "" : "s"} (
            {gradedBets.length} graded)
          </p>
        </div>

        {!gradedBets.length ? (
          <p className="text-xs text-slate-500">
            Once you have graded bets in this view, you&apos;ll see your
            breakdown by sport here.
          </p>
        ) : (
          <>
            {/* Quick summary using current filters */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3 text-xs">
              <div className="bg-slate-900/70 rounded-lg p-2 border border-slate-800">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">
                  Record (graded)
                </p>
                <p className="text-sm font-semibold text-slate-100">
                  {summary.wins}-{summary.losses}
                  {summary.pushes ? `-${summary.pushes}` : ""}{" "}
                  <span className="text-[11px] text-slate-400">
                    {summary.total > 0
                      ? `(${((summary.wins / summary.total) * 100).toFixed(1)}%)`
                      : ""}
                  </span>
                </p>
              </div>

              <div className="bg-slate-900/70 rounded-lg p-2 border border-slate-800">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">
                  Net (filtered)
                </p>
                <p className="text-sm font-semibold">
                  <span
                    className={
                      summary.net > 0
                        ? "text-emerald-400"
                        : summary.net < 0
                        ? "text-rose-400"
                        : "text-slate-100"
                    }
                  >
                    {summary.net >= 0 ? "+" : ""}
                    ${summary.net.toFixed(2)}
                  </span>
                  {unitSize > 0 && (
                    <span className="text-[11px] text-slate-400 ml-1">
                      ({(summary.net / unitSize).toFixed(2)}u)
                    </span>
                  )}
                </p>
              </div>

              <div className="bg-slate-900/70 rounded-lg p-2 border border-slate-800">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">
                  Total staked
                </p>
                <p className="text-sm font-semibold text-slate-100">
                  ${summary.staked.toFixed(2)}
                </p>
              </div>

              <div className="bg-slate-900/70 rounded-lg p-2 border border-slate-800">
                <p className="text-[10px] uppercase tracking-wide text-slate-500">
                  ROI
                </p>
                <p className="text-sm font-semibold text-slate-100">
                  {summary.roi.toFixed(1)}%
                </p>
              </div>
            </div>

            {!!breakdownBySport.length && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                  By sport
                </p>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  {breakdownBySport.map((s) => (
                    <div
                      key={s.sport}
                      className="px-2 py-1 rounded-full border border-slate-700 bg-slate-900/80"
                    >
                      <span className="font-semibold text-slate-100">
                        {s.sport}
                      </span>{" "}
                      {s.wins}-{s.losses}
                      {s.pushes ? `-${s.pushes}` : ""} ·{" "}
                      <span
                        className={
                          s.net > 0
                            ? "text-emerald-400"
                            : s.net < 0
                            ? "text-rose-400"
                            : "text-slate-200"
                        }
                      >
                        {s.net >= 0 ? "+" : ""}
                        ${s.net.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {!!breakdownByBetType.length && (
              <div className="mt-3">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                  By bet type
                </p>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  {breakdownByBetType.map((t) => (
                    <div
                      key={t.bet_type}
                      className="px-2 py-1 rounded-full border border-slate-700 bg-slate-900/80"
                    >
                      <span className="font-semibold text-slate-100">
                        {t.bet_type}
                      </span>{" "}
                      {t.wins}-{t.losses}
                      {t.pushes ? `-${t.pushes}` : ""} ·{" "}
                      <span
                        className={
                          t.net > 0
                            ? "text-emerald-400"
                            : t.net < 0
                            ? "text-rose-400"
                            : "text-slate-200"
                        }
                      >
                        {t.net >= 0 ? "+" : ""}
                        ${t.net.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* Form */}
      <section className="mb-8 bg-slate-950/80 border border-slate-800 rounded-2xl p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h2 className="text-sm font-semibold text-slate-100">
            {isEditing ? "Edit bet" : "Add a bet"}
          </h2>
          {isEditing && (
            <button
              type="button"
              onClick={resetForm}
              className="text-[11px] text-slate-400 hover:text-slate-200 underline underline-offset-2"
            >
              Cancel edit
            </button>
          )}
        </div>

        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          onSubmit={handleAddBet}
        >
          <div className="flex flex-col gap-1">
            <label
              htmlFor="bet-sport"
              className="text-[11px] uppercase tracking-wide text-slate-400"
            >
              Sport
            </label>
            <select
              id="bet-sport"
              name="sport"
              value={form.sport}
              onChange={(e) => updateField("sport", e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm"
            >
              <option value="nfl">NFL</option>
              <option value="ncaaf">NCAAF</option>
              <option value="nba">NBA</option>
              <option value="mlb">MLB</option>
              <option value="golf">Golf</option>
              <option value="soccer">Soccer</option>
              <option value="multi">Multi-sport</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="bet-book"
              className="text-[11px] uppercase tracking-wide text-slate-400"
            >
              Book
            </label>
            <input
              id="bet-book"
              name="book_name"
              type="text"
              value={form.book_name}
              onChange={(e) => updateField("book_name", e.target.value)}
              placeholder="Optional"
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="bet-event"
              className="text-[11px] uppercase tracking-wide text-slate-400"
            >
              Event
            </label>
            <input
              id="bet-event"
              name="event_name"
              type="text"
              value={form.event_name}
              onChange={(e) => updateField("event_name", e.target.value)}
              placeholder="Cowboys @ Eagles"
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm"
              required
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="bet-event-date"
              className="text-[11px] uppercase tracking-wide text-slate-400"
            >
              Event date
            </label>
            <input
              id="bet-event-date"
              name="event_date"
              type="date"
              value={form.event_date}
              onChange={(e) => updateField("event_date", e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="bet-type"
              className="text-[11px] uppercase tracking-wide text-slate-400"
            >
              Bet type
            </label>
            <select
              id="bet-type"
              name="bet_type"
              value={form.bet_type}
              onChange={(e) => updateField("bet_type", e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm"
            >
              <option value="spread">Spread</option>
              <option value="moneyline">Moneyline</option>
              <option value="total">Total</option>
              <option value="parlay">Parlay</option>
              <option value="player_prop_parlay">Player Prop Parlay</option>
              <option value="prop">Prop</option>
              <option value="live">Live</option>
              <option value="alt">Alt</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-1">
            <label
              htmlFor="bet-selection"
              className="text-[11px] uppercase tracking-wide text-slate-400"
            >
              Selection
            </label>
            <input
              id="bet-selection"
              name="selection"
              type="text"
              value={form.selection}
              onChange={(e) => updateField("selection", e.target.value)}
              placeholder="Cowboys -3.5, Kelce o67.5 rec, etc."
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm"
              required
            />
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <label
              htmlFor="bet-notes"
              className="text-[11px] uppercase tracking-wide text-slate-400"
            >
              Reason / Notes (optional)
            </label>
            <textarea
              id="bet-notes"
              name="notes"
              value={form.notes}
              onChange={(e) => updateField("notes", e.target.value)}
              placeholder="Why you like this side, key angles, etc."
              rows={2}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm resize-none"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="bet-odds"
              className="text-[11px] uppercase tracking-wide text-slate-400"
            >
              Odds (American)
            </label>
            <input
              id="bet-odds"
              name="odds_american"
              type="number"
              value={form.odds_american}
              onChange={(e) => updateField("odds_american", e.target.value)}
              placeholder="-110"
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm"
              required
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="bet-stake"
              className="text-[11px] uppercase tracking-wide text-slate-400"
            >
              Stake
            </label>
            <input
              id="bet-stake"
              name="stake"
              type="number"
              value={form.stake}
              onChange={(e) => updateField("stake", e.target.value)}
              placeholder="Unit size"
              step="0.01"
              min="0"
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm"
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="bet-confidence"
              className="text-[11px] uppercase tracking-wide text-slate-400"
            >
              Confidence
            </label>
            <select
              id="bet-confidence"
              name="confidence"
              value={form.confidence}
              onChange={(e) => updateField("confidence", e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm"
            >
              <option value="">—</option>
              <option value="1">1 / 5</option>
              <option value="2">2 / 5</option>
              <option value="3">3 / 5</option>
              <option value="4">4 / 5</option>
              <option value="5">5 / 5</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="bet-visibility"
              className="text-[11px] uppercase tracking-wide text-slate-400"
            >
              Share with
            </label>
            <select
              id="bet-visibility"
              name="visibility"
              value={form.visibility}
              onChange={(e) =>
                updateField("visibility", e.target.value as BetVisibility)
              }
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm"
            >
              <option value="private">Only me</option>
              <option value="followers">Followers</option>
              <option value="public">Everyone</option>
            </select>
          </div>

          <div className="flex items-end">
            <button
              type="submit"
              disabled={saving}
              className="w-full sm:w-auto bg-yellow-400 text-slate-900 font-semibold px-4 py-2 rounded-xl text-sm disabled:opacity-60"
            >
              {saving
                ? isEditing
                  ? "Saving..."
                  : "Saving..."
                : isEditing
                ? "Save changes"
                : "Add bet"}
            </button>
          </div>
        </form>

        {error && (
          <p className="mt-3 text-xs text-rose-400">{error}</p>
        )}
      </section>

      {/* Bets list */}
      <section>
        <h2 className="text-sm font-semibold text-slate-100 mb-3">
          {selectedDateLabel ? `Your bets — ${selectedDateLabel}` : "Your bets"}
        </h2>

        {loading ? (
          <p className="text-sm text-slate-400">Loading bets...</p>
        ) : !betsForTable.length ? (
          <p className="text-sm text-slate-400">
            No pending or recent bets match your filters. Try changing sport, status, or time window.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/80">
            <table className="min-w-full text-xs sm:text-sm">
              <thead className="bg-slate-900/80 text-slate-400 text-[11px] uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-left">Event</th>
                  <th className="px-3 py-2 text-left">Selection</th>
                  <th className="px-3 py-2 text-right">Odds</th>
                  <th className="px-3 py-2 text-right">Stake</th>
                  <th className="px-3 py-2 text-right">To win</th>
                  <th className="px-3 py-2 text-right">Status</th>
                  <th className="px-3 py-2 text-right">Result</th>
                  <th className="px-3 py-2 text-right">Visibility</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {betsForTable.map((b) => {
                  const dateLabel = b.event_date
                    ? new Date(b.event_date).toLocaleDateString()
                    : b.created_at
                    ? new Date(b.created_at).toLocaleDateString()
                    : "";

                  const isThisEditing =
                    editingBet && editingBet.id === b.id;

                  return (
                    <tr
                      key={b.id}
                      className={`border-t border-slate-800 hover:bg-slate-900/70 ${
                        isThisEditing ? "bg-slate-900/80" : ""
                      }`}
                    >
                      <td className="px-3 py-2 align-top">
                        <div className="font-medium text-slate-100">
                          {b.event_name}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {b.sport === "multi"
                            ? "Multi"
                            : b.sport
                            ? b.sport.toUpperCase()
                            : "OTHER"}
                          {dateLabel ? ` • ${dateLabel}` : ""}
                          {b.book_name ? ` • ${b.book_name}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="text-slate-200">{b.selection}</div>
                        <div className="text-[11px] text-slate-500">
                          {b.bet_type}
                          {typeof (b as any).confidence === "number" &&
                            !Number.isNaN((b as any).confidence) && (
                              <> • Confidence: {(b as any).confidence}/5</>
                            )}
                        </div>
                        {(b as any).notes && (
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            Reason: {(b as any).notes}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right align-top">
                        {b.odds_american > 0 ? "+" : ""}
                        {b.odds_american}
                      </td>
                      <td className="px-3 py-2 text-right align-top">
                        {b.stake.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right align-top">
                        {b.to_win.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right align-top">
                        <select
                          id={`bet-status-${b.id}`}
                          name="status"
                          aria-label={`Status for bet on ${b.event_name}`}
                          value={b.status}
                          onChange={(e) =>
                            handleStatusChange(
                              b,
                              e.target.value as BetStatus
                            )
                          }
                          className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-[11px]"
                        >
                          <option value="pending">Pending</option>
                          <option value="won">Won</option>
                          <option value="lost">Lost</option>
                          <option value="push">Push</option>
                          <option value="void">Void</option>
                        </select>
                      </td>
                      <td className="px-3 py-2 text-right align-top">
                        <span
                          className={
                            b.result_amount > 0
                              ? "text-emerald-400"
                              : b.result_amount < 0
                              ? "text-rose-400"
                              : "text-slate-200"
                          }
                        >
                          {b.result_amount >= 0 ? "+" : ""}
                          {b.result_amount.toFixed(2)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right align-top">
                        <select
                          aria-label={`Visibility for bet on ${b.event_name}`}
                          value={b.visibility ?? "private"}
                          onChange={(e) =>
                            handleVisibilityChange(
                              b,
                              e.target.value as BetVisibility
                            )
                          }
                          className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-[11px]"
                        >
                          <option value="private">Only me</option>
                          <option value="followers">Followers</option>
                          <option value="public">Everyone</option>
                        </select>
                      </td>
                      <td className="px-3 py-2 text-right align-top space-x-2 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => startEdit(b)}
                          className="inline-flex items-center px-2 py-1 rounded-full border border-slate-600 text-[11px] text-slate-200 hover:bg-slate-800"
                          title="Edit this bet"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteBet(b)}
                          className="inline-flex items-center px-2 py-1 rounded-full border border-rose-600/70 text-[11px] text-rose-300 hover:bg-rose-600/10"
                          title="Delete this bet"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}