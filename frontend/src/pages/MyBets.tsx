// src/pages/MyBets.tsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import type { BetRow, BetStatus } from "../types/bets";
import { calcToWin, calcResultAmount } from "../lib/betMath";

type NewBetForm = {
  sport: string;
  book_name: string;
  event_name: string;
  event_date: string; // yyyy-mm-dd or empty
  bet_type: string;
  selection: string;
  odds_american: string;
  stake: string;
};

export default function MyBets() {
  const [userId, setUserId] = useState<string | null>(null);
  const [bets, setBets] = useState<BetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<NewBetForm>({
    sport: "nfl",
    book_name: "",
    event_name: "",
    event_date: "",
    bet_type: "spread",
    selection: "",
    odds_american: "",
    stake: "",
  });

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

  // 2) Load bets for this user
  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    async function loadBets() {
      setLoading(true);
      setError(null);

      try {
        const { data, error } = await supabase
          .from("bets")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false });

        if (error) {
          throw error;
        }

        if (!cancelled) {
          setBets((data ?? []) as BetRow[]);
        }
      } catch (e: any) {
        console.error("[MyBets] load error:", e);
        if (!cancelled) setError(e.message ?? "Failed to load bets");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadBets();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // 3) Derived stats
  const summary = useMemo(() => {
    if (!bets.length) {
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

    for (const b of bets) {
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
  }, [bets]);

  // 4) Form handlers
  function updateField<K extends keyof NewBetForm>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleAddBet(e: React.FormEvent) {
    e.preventDefault();
    if (!userId) return;

    const odds = Number(form.odds_american);
    const stake = Number(form.stake);

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

    const toWin = calcToWin(odds, stake);
    const result_amount = 0;
    const eventDateIso = form.event_date
      ? new Date(form.event_date + "T00:00:00").toISOString()
      : null;

    setSaving(true);
    setError(null);

    try {
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
        })
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      setBets((prev) => [data as BetRow, ...prev]);
      setForm({
        sport: form.sport,
        book_name: form.book_name,
        event_name: "",
        event_date: form.event_date,
        bet_type: form.bet_type,
        selection: "",
        odds_american: "",
        stake: "",
      });
    } catch (e: any) {
      console.error("[MyBets] insert error:", e);
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
        b.id === bet.id ? { ...b, status: newStatus, result_amount: newResult } : b
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

  // 5) UI

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
              {summary.net.toFixed(2)}
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

      {/* Form */}
      <section className="mb-8 bg-slate-950/80 border border-slate-800 rounded-2xl p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-slate-100 mb-3">
          Add a bet
        </h2>

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
              htmlFor="bet-date"
              className="text-[11px] uppercase tracking-wide text-slate-400"
            >
              Event date
            </label>
            <input
              id="bet-date"
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
              value={form.bet_type}
              onChange={(e) => updateField("bet_type", e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm"
            >
              <option value="spread">Spread</option>
              <option value="moneyline">Moneyline</option>
              <option value="total">Total</option>
              <option value="parlay">Parlay</option>
              <option value="prop">Prop</option>
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
              type="text"
              value={form.selection}
              onChange={(e) => updateField("selection", e.target.value)}
              placeholder="Cowboys -3.5, Kelce o67.5 rec, etc."
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm"
              required
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

          <div className="flex items-end">
            <button
              type="submit"
              disabled={saving}
              className="w-full sm:w-auto bg-yellow-400 text-slate-900 font-semibold px-4 py-2 rounded-xl text-sm disabled:opacity-60"
            >
              {saving ? "Saving..." : "Add bet"}
            </button>
          </div>
        </form>

        {error && (
          <p className="mt-3 text-xs text-rose-400">
            {error}
          </p>
        )}
      </section>

      {/* Bets list */}
      <section>
        <h2 className="text-sm font-semibold text-slate-100 mb-3">
          Your bets
        </h2>

        {loading ? (
          <p className="text-sm text-slate-400">Loading bets...</p>
        ) : !bets.length ? (
          <p className="text-sm text-slate-400">
            No bets tracked yet. Add your first one above.
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
                </tr>
              </thead>
              <tbody>
                {bets.map((b) => {
                  const dateLabel = b.event_date
                    ? new Date(b.event_date).toLocaleDateString()
                    : "";

                  return (
                    <tr
                      key={b.id}
                      className="border-t border-slate-800 hover:bg-slate-900/70"
                    >
                      <td className="px-3 py-2 align-top">
                        <div className="font-medium text-slate-100">
                          {b.event_name}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {b.sport.toUpperCase()}
                          {dateLabel ? ` • ${dateLabel}` : ""}
                          {b.book_name ? ` • ${b.book_name}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="text-slate-200">{b.selection}</div>
                        <div className="text-[11px] text-slate-500">
                          {b.bet_type}
                        </div>
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
                          aria-label="Bet status"
                          value={b.status}
                          onChange={(e) =>
                            handleStatusChange(b, e.target.value as BetStatus)
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