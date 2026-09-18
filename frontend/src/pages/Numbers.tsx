// src/pages/Numbers.tsx
// The model's stat pages (team grades, goal line, MVP, ...), published by td_export.py.
import { useEffect, useMemo, useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { usePageSeo } from "../hooks/usePageSeo";
import { TeamTag } from "../lib/teams";
import "./numbers.css";

type Fmt = "text" | "team" | "int" | "num1" | "num2" | "epa" | "signed1" | "pct";
type Col = { key: string; label: string; fmt: Fmt; rank?: "high" | "low" };
type Section = { title: string; note: string | null; columns: Col[]; rows: Record<string, unknown>[] };
type Page = { slug: string; title: string; dek: string | null; position: number; updated_at: string; sections: Section[] };

function currentSeason(d = new Date()) {
  return d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
}

function fmt(v: unknown, f: Fmt): string {
  if (v == null || v === "") return "—";
  if (typeof v !== "number") return String(v);
  switch (f) {
    case "int": return Math.round(v).toLocaleString();
    case "num1": return v.toFixed(1);
    case "num2": return v.toFixed(2);
    case "epa": return `${v > 0 ? "+" : ""}${v.toFixed(3)}`;
    case "signed1": return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
    case "pct": return `${(v * 100).toFixed(1)}%`;
    default: return String(v);
  }
}

// League-rank shading: 0 = worst, 1 = best, per column.
function rankMap(rows: Record<string, unknown>[], col: Col): Map<number, number> {
  const vals = rows
    .map((r, i) => [i, r[col.key]] as const)
    .filter((x): x is readonly [number, number] => typeof x[1] === "number");
  const sorted = [...vals].sort((a, b) => (col.rank === "high" ? a[1] - b[1] : b[1] - a[1]));
  const m = new Map<number, number>();
  sorted.forEach(([i], k) => m.set(i, sorted.length > 1 ? k / (sorted.length - 1) : 0.5));
  return m;
}
function shade(p: number | undefined) {
  if (p == null) return undefined;
  if (p >= 0.8) return "r5";
  if (p >= 0.6) return "r4";
  if (p <= 0.2) return "r1";
  if (p <= 0.4) return "r2";
  return undefined;
}

function StatTable({ s }: { s: Section }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

  const ranks = useMemo(() => {
    const m: Record<string, Map<number, number>> = {};
    s.columns.forEach((c) => { if (c.rank) m[c.key] = rankMap(s.rows, c); });
    return m;
  }, [s]);

  const order = useMemo(() => {
    const idx = s.rows.map((_, i) => i);
    if (!sort) return idx;
    return idx.sort((a, b) => {
      const x = s.rows[a][sort.key], y = s.rows[b][sort.key];
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
  }, [s, sort]);

  const click = (c: Col) =>
    setSort((cur) =>
      cur?.key === c.key ? { key: c.key, dir: cur.dir === 1 ? -1 : 1 }
        : { key: c.key, dir: c.fmt === "text" || c.fmt === "team" || c.rank === "low" ? 1 : -1 });

  return (
    <div className="nb-scroll">
      <table className="nb-table">
        <thead>
          <tr>
            <th scope="col" className="nb-rk">#</th>
            {s.columns.map((c) => {
              const on = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={c.fmt === "text" || c.fmt === "team" ? undefined : "num"}
                  aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}
                >
                  <button type="button" onClick={() => click(c)}>
                    {c.label}
                    <span className="nb-arrow" aria-hidden="true">{on ? (sort!.dir === 1 ? "▲" : "▼") : ""}</span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {order.map((i, n) => (
            <tr key={i}>
              <td className="nb-rk">{n + 1}</td>
              {s.columns.map((c) => {
                const v = s.rows[i][c.key];
                if (c.fmt === "team") return <td key={c.key}>{v ? <TeamTag team={String(v)} /> : "—"}</td>;
                if (c.fmt === "text") return <td key={c.key} className="nb-text">{fmt(v, c.fmt)}</td>;
                return (
                  <td key={c.key} className={`num ${shade(ranks[c.key]?.get(i)) ?? ""}`}>
                    {fmt(v, c.fmt)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Numbers() {
  const season = currentSeason();
  const { slug } = useParams();
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("model_pages")
      .select("slug,title,dek,position,updated_at,sections")
      .eq("season", season)
      .order("position")
      .then(({ data, error }) => {
        if (error) setError(error.message);
        setPages((data as Page[]) ?? []);
        setLoading(false);
      });
  }, [season]);

  const page = pages.find((p) => p.slug === slug) ?? pages[0];

  usePageSeo({
    title: page ? `${page.title} — PickForge` : "The numbers — PickForge",
    description: page?.dek ?? "Team grades, goal-line usage, the MVP race and more, from the PickForge model.",
  });

  const updated = page
    ? new Date(page.updated_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";

  return (
    <article className="nb">
      {pages.length > 0 && (
        <nav className="nb-tabs" aria-label="Stat pages">
          {pages.map((p) => (
            <NavLink
              key={p.slug}
              to={`/numbers/${p.slug}`}
              className={() => (p.slug === page?.slug ? "active" : undefined)}
            >
              {p.title}
            </NavLink>
          ))}
        </nav>
      )}

      {loading && <p className="nb-empty">Loading…</p>}
      {error && <p className="nb-empty">Couldn't load the numbers: {error}</p>}
      {!loading && !error && !pages.length && (
        <p className="nb-empty">No stat pages published for {season} yet.</p>
      )}

      {page && (
        <>
          <h1 className="nb-title">{page.title}</h1>
          {page.dek && <p className="nb-dek">{page.dek}</p>}
          <p className="nb-stamp">{season} season to date. Updated {updated}. Click a column to sort.</p>

          {page.sections.map((s) => (
            <section key={s.title} className="nb-section" aria-labelledby={`s-${s.title}`}>
              <h2 id={`s-${s.title}`}>{s.title}</h2>
              {s.note && <p className="nb-note">{s.note}</p>}
              <StatTable s={s} />
            </section>
          ))}
        </>
      )}
    </article>
  );
}
