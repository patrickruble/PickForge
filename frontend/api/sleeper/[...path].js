module.exports = async function handler(req, res) {
  const path = Array.isArray(req.query.path) ? req.query.path : [];
  const base = "https://api.sleeper.app/v1";
  const url = `${base}/${path.join("/")}`;

  try {
    const r = await fetch(url);
    const text = await r.text();

    res.setHeader("Content-Type", r.headers.get("content-type") || "application/json");
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.statusCode = r.status;
    res.end(text);
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Sleeper fetch failed" }));
  }
};