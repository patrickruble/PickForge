// src/pages/TdBoard.tsx
// The Anytime TD board. Reads the snapshot td_publish.py writes to Supabase.
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { usePageSeo } from "../hooks/usePageSeo";
import { TeamTag } from "../lib/teams";
import "./td-board.css";

type Row = {
  season: number;
  week: number;
  player_id: string;
  player: string;
  team: string;
  pos: string;
  opp: string;
  matchup: string;
  day: string | null;
  kick: string | null;
  slate_order: number | null;
  p_anytime: number;
  fair_odds: number | null;
  best_price: number | null;
  mkt_fair: number | null;
  edge: number | null;
  ev: number | null;
  actual_td: number | null;
  graded: boolean | null;
};

type SortKey = "ev" | "edge" | "p_anytime";

const CARD_SIZE = 3; // plays on the weekly card
// Longshots dominate raw EV and are where model error is largest, so the card
// only takes players the model gives at least this chance.
const CARD_MIN_PROB = 0.2;

function currentSeason(d = new Date()) {
  return d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1; // Aug onward
}

const pct = (p: number | null) => (p == null ? "—" : `${(p * 100).toFixed(1)}%`);
const odds = (a: number | null) =>
  a == null ? "—" : a > 0 ? `+${Math.round(a)}` : `${Math.round(a)}`;
const signed = (x: number | null, digits = 1) =>
  x == null ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(digits)}`;

function payout(price: number) {
  return price > 0 ? price / 100 : 100 / -price; // units won per 1u staked
}

function topCard(rows: Row[]) {
  return rows
    .filter((r) => r.best_price != null && (r.ev ?? 0) > 0 && r.p_anytime >= CARD_MIN_PROB)
    .sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0))
    .slice(0, CARD_SIZE);
}

export default function TdBoard() {
  const season = currentSeason();
  const [params, setParams] = useSearchParams();
  const [weeks, setWeeks] = useState<number[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [graded, setGraded] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("ev");
  const [game, setGame] = useState("all");
  const [showAll, setShowAll] = useState(false);

  const week = Number(params.get("week")) || weeks[0] || null;

  usePageSeo({
    title: week ? `Anytime TD Board, Week ${week} — PickForge` : "Anytime TD Board — PickForge",
    description:
      "Model anytime-touchdown probabilities against the sportsbook, posted before kickoff and graded after.",
  });

  // Which weeks have been published, newest first; plus every graded priced row for the record.
  useEffect(() => {
    (async () => {
      const [w, g] = await Promise.all([
        supabase.from("td_board").select("week").eq("season", season).order("week", { ascending: false }).limit(10000),
        // Every priced row this season: the card is rebuilt per week from the
        // full board, then only its graded plays count toward the record.
        supabase
          .from("td_board")
          .select("week,player_id,player,team,p_anytime,best_price,ev,actual_td,graded")
          .eq("season", season)
          .not("best_price", "is", null)
          .limit(10000),
      ]);
      if (w.error) {
        setError(w.error.message);
        setLoading(false);
        return;
      }
      setWeeks([...new Set((w.data ?? []).map((r: { week: number }) => r.week))]);
      setGraded((g.data as Row[]) ?? []);
      if (!w.data?.length) setLoading(false);
    })();
  }, [season]);

  useEffect(() => {
    if (!week) return;
    setLoading(true);
    supabase
      .from("td_board")
      .select("*")
      .eq("season", season)
      .eq("week", week)
      .limit(2000)
      .then(({ data, error }) => {
        if (error) setError(error.message);
        setRows((data as Row[]) ?? []);
        setLoading(false);
      });
  }, [season, week]);

  const games = useMemo(() => {
    const order = new Map<string, number>();
    rows.forEach((r) => order.set(r.matchup, r.slate_order ?? 99));
    return [...order.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
  }, [rows]);

  const board = useMemo(() => {
    let r = showAll ? rows : rows.filter((x) => x.best_price != null);
    if (game !== "all") r = r.filter((x) => x.matchup === game);
    const key = showAll && sort !== "p_anytime" ? "p_anytime" : sort;
    return [...r].sort((a, b) => ((b[key] as number) ?? -9) - ((a[key] as number) ?? -9));
  }, [rows, showAll, game, sort]);

  const card = useMemo(() => topCard(rows), [rows]);
  const bestId = card[0]?.player_id;
  const isGraded = rows.some((r) => r.graded);

  // Season record of the weekly card, graded weeks only.
  const record = useMemo(() => {
    const byWeek = new Map<number, Row[]>();
    graded.forEach((r) => byWeek.set(r.week, [...(byWeek.get(r.week) ?? []), r]));
    let w = 0, l = 0, units = 0;
    byWeek.forEach((wk) =>
      topCard(wk).filter((r) => r.graded).forEach((r) => {
        if ((r.actual_td ?? 0) >= 1) { w++; units += payout(r.best_price!); }
        else { l++; units -= 1; }
      })
    );
    return { w, l, units, bets: w + l };
  }, [graded]);

  const priced = rows.filter((r) => r.best_price != null).length;

  return (
    <article className="tdb">
      <h1 className="tdb-h1">{week ? `Anytime TD board, Week ${week}` : "Anytime TD board"}</h1>
      <p className="tdb-standfirst">
        Anytime touchdown odds from our model, set against the sportsbook. Every play on the card
        is graded, win or lose.
      </p>

      {weeks.length > 1 && (
        <nav className="tdb-weeks" aria-label="Weeks">
          {weeks.map((w) => (
            <button
              key={w}
              type="button"
              aria-current={w === week ? "page" : undefined}
              onClick={() => setParams({ week: String(w) })}
            >
              Week {w}
            </button>
          ))}
        </nav>
      )}

      {error && <p className="tdb-empty">Couldn't load the board: {error}</p>}
      {!error && !loading && !weeks.length && (
        <p className="tdb-empty">
          No board published yet this season. It goes up Tuesday, before the week's first kickoff.
        </p>
      )}

      {week && !error && (
        <div className="tdb-grid">
          <aside className="tdb-side">
            <section aria-labelledby="card-h">
              <h2 id="card-h" className="tdb-h2">This week's card</h2>
              {card.length === 0 && <p className="tdb-small">No plays clear the bar yet: positive value and at least a 20% model chance.</p>}
              <ol className="tdb-card">
                {card.map((r) => {
                  const hit = (r.actual_td ?? 0) >= 1;
                  return (
                    <li key={r.player_id}>
                      <div>
                        <strong>{r.player}</strong>
                        <span className="tdb-small">
                          Anytime TD, {odds(r.best_price)}, 1 unit
                        </span>
                      </div>
                      {r.graded && (
                        <span className={`tdb-stamp ${hit ? "won" : "lost"}`}>
                          {hit ? "Cashed" : "Missed"}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>

            <section className="tdb-record" aria-labelledby="rec-h">
              <h2 id="rec-h">Season record</h2>
              {record.bets ? (
                <>
                  <p className="tdb-big">{record.w}–{record.l}</p>
                  <p>{signed(record.units, 2)} units on {record.bets} plays</p>
                </>
              ) : (
                <p>Starts once the first card is graded.</p>
              )}
            </section>
          </aside>
          <section aria-labelledby="board-h">
            <h2 id="board-h" className="tdb-h2">The board</h2>

            <div className="tdb-controls">
              <label>
                Game
                <select value={game} onChange={(e) => setGame(e.target.value)}>
                  <option value="all">All games</option>
                  {games.map((g) => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
              </label>
              <div className="tdb-seg" role="group" aria-label="Sort by">
                {(["ev", "edge", "p_anytime"] as SortKey[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={sort === k}
                    disabled={showAll && k !== "p_anytime"}
                    onClick={() => setSort(k)}
                  >
                    {k === "ev" ? "Value" : k === "edge" ? "Edge" : "Model"}
                  </button>
                ))}
              </div>
              <label className="tdb-check">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                />
                Include players without a book price ({rows.length - priced})
              </label>
            </div>

            <div className="tdb-scroll">
              <table className="tdb-table">
                <thead>
                  <tr>
                    <th scope="col">Player</th>
                    <th scope="col">Game</th>
                    <th scope="col" className="num">Model</th>
                    <th scope="col" className="num">Fair</th>
                    <th scope="col" className="num">Book</th>
                    <th scope="col" className="num">Book %</th>
                    <th scope="col" className="num">Edge</th>
                    <th scope="col" className="num">Value</th>
                    {isGraded && <th scope="col" className="num">TDs</th>}
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr><td colSpan={9} className="tdb-loading">Loading the board…</td></tr>
                  )}
                  {!loading && board.map((r) => {
                    const edge = r.edge == null ? null : r.edge * 100;
                    const best = r.player_id === bestId;
                    return (
                      <tr key={r.player_id} className={best ? "is-best" : undefined}>
                        <td>
                          <div className="tdb-player">
                            <TeamTag team={r.team} />
                            <span className="tdb-name">{r.player}</span>
                            <span className="tdb-pos">{r.pos}</span>
                            {best && <span className="tdb-flag">Best bet</span>}
                          </div>
                        </td>
                        <td className="tdb-game">{r.matchup}</td>
                        <td className="num">{pct(r.p_anytime)}</td>
                        <td className="num">{odds(r.fair_odds)}</td>
                        <td className="num">{odds(r.best_price)}</td>
                        <td className="num">{pct(r.mkt_fair)}</td>
                        <td className="num">
                          <span className="tdb-edge">
                            <span className="tdb-bar" aria-hidden="true">
                              <span
                                className={edge != null && edge > 0 ? "up" : "down"}
                                style={{ width: `${Math.min(100, Math.abs(edge ?? 0) * 8)}%` }}
                              />
                            </span>
                            <span className={edge != null && edge > 0 ? "pos" : "neg"}>{signed(edge)}</span>
                          </span>
                        </td>
                        <td className={`num ${(r.ev ?? 0) > 0 ? "pos" : "neg"}`}>
                          {r.ev == null ? "—" : `${signed(r.ev * 100, 0)}%`}
                        </td>
                        {isGraded && <td className="num">{r.actual_td ?? "—"}</td>}
                      </tr>
                    );
                  })}
                  {!loading && !board.length && (
                    <tr><td colSpan={9} className="tdb-loading">No priced players for this selection yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <p className="tdb-note">
              Model is our chance the player scores at least once. Fair is that chance as American
              odds. Book % is the sportsbook's price with the margin removed, game by game, so Edge
              compares players within the same game. Value is expected profit per dollar at the book
              price, assuming the model is right. Sort by Value to find bets; a big edge on a heavy
              favorite can still lose money.
            </p>
          </section>

        </div>
      )}
    </article>
  );
}
