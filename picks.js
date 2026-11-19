"use strict";
/* Picks tab: pulls player prop lines from many sportsbooks and pick'em apps (The Odds API),
   removes the vig to estimate each side's real chance, adds ESPN last-10 hit rates,
   and builds the best 2-5 leg slips. Uses globals from app.js. */

const ODDS = "https://api.the-odds-api.com/v4";
const LINES_KEY = "propboard-lines";
const SPORTS = {
  basketball_nba: { name: "NBA", espn: "nba", markets: {
    player_points: "PTS", player_rebounds: "REB", player_assists: "AST", player_threes: "3PM",
    player_points_rebounds_assists: "PRA", player_points_rebounds: "P+R", player_points_assists: "P+A",
    player_rebounds_assists: "R+A", player_steals: "STL", player_blocks: "BLK" } },
  basketball_wnba: { name: "WNBA", espn: "wnba", markets: {
    player_points: "PTS", player_rebounds: "REB", player_assists: "AST", player_threes: "3PM",
    player_points_rebounds_assists: "PRA" } },
  americanfootball_nfl: { name: "NFL", espn: null, markets: {
    player_pass_yds: "Pass YDS", player_rush_yds: "Rush YDS", player_reception_yds: "Rec YDS",
    player_receptions: "Receptions", player_pass_tds: "Pass TDs", player_pass_completions: "Completions" } },
};
const DEFAULT_MARKETS = { basketball_nba: ["player_points", "player_rebounds", "player_assists", "player_points_rebounds_assists"],
  basketball_wnba: ["player_points", "player_rebounds", "player_assists"],
  americanfootball_nfl: ["player_pass_yds", "player_rush_yds", "player_reception_yds", "player_receptions"] };
const DFS_BOOKS = ["prizepicks", "underdog", "pick6", "betr_us_dfs", "sleeper"];
const isDfs = k => DFS_BOOKS.includes(k) || /dfs|pick/i.test(k);

S.picks = Object.assign({ sport: "basketball_nba", markets: null, dfs: true, books: true, legs: 3, mode: "pickem",
  payouts: { 2: 3, 3: 5, 4: 10, 5: 20 }, games: null }, S.picks || {});
if (!S.picks.markets) S.picks.markets = DEFAULT_MARKETS[S.picks.sport].slice();
let L = null; // loaded lines
try { L = JSON.parse(localStorage.getItem(LINES_KEY) || "null"); } catch (e) {}
let events = [];
const idCache = (() => { try { return JSON.parse(localStorage.getItem("propboard-ids") || "{}"); } catch (e) { return {}; } })();
const saveIds = () => { try { localStorage.setItem("propboard-ids", JSON.stringify(idCache)); } catch (e) {} };

/* ---------- Math ---------- */
function normCdf(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
function normInv(p) { p = Math.min(0.999, Math.max(0.001, p)); let lo = -6, hi = 6; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (normCdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; }
const spread = line => Math.max(1.2, 0.3 * line);
// Chance of going over `to`, given a fair over-chance `pOver` at line `from`.
function shiftOver(pOver, from, to) { const sd = spread(from); const mu = from + sd * normInv(pOver); return 1 - normCdf((to - mu) / sd); }

/* ---------- Load from The Odds API ---------- */
function regions() { return [S.picks.books ? "us" : null, S.picks.dfs ? "us_dfs" : null].filter(Boolean); }
function estCredits(n) { return S.picks.markets.length * regions().length * n; }
async function oddsGet(path, params) {
  const q = new URLSearchParams({ apiKey: S.oddsKey, ...params });
  const r = await fetch(`${ODDS}${path}?${q}`);
  const rem = r.headers.get("x-requests-remaining");
  if (rem != null) S.picks.remaining = rem;
  if (r.status === 401) throw new Error("That API key wasn't accepted. Check it in Settings.");
  if (r.status === 429) throw new Error("Out of free credits for this month, or too many requests at once.");
  if (!r.ok) throw new Error("The odds service answered with error " + r.status + ".");
  return r.json();
}
async function loadGames() {
  const all = await oddsGet(`/sports/${S.picks.sport}/events`, {});
  const now = Date.now();
  events = all.filter(e => { const t = Date.parse(e.commence_time); return t > now - 5 * 60e3 && t < now + 36 * 3600e3; })
    .sort((a, b) => a.commence_time < b.commence_time ? -1 : 1);
  S.picks.games = events.map(e => e.id);
  save();
}
async function loadLines() {
  const chosen = events.filter(e => S.picks.games.includes(e.id));
  const rows = {};
  let failed = 0;
  for (const ev of chosen) {
    let data;
    try { data = await oddsGet(`/sports/${S.picks.sport}/events/${ev.id}/odds`, { regions: regions().join(","), markets: S.picks.markets.join(","), oddsFormat: "american" }); }
    catch (e) { if (/key|credits/i.test(e.message)) throw e; failed++; continue; }
    const game = `${short(data.away_team)} @ ${short(data.home_team)}`;
    for (const bk of data.bookmakers || []) for (const mk of bk.markets || []) for (const o of mk.outcomes || []) {
      if (o.point == null || !o.description) continue;
      const k = [ev.id, mk.key, o.description, o.point].join("|");
      const row = rows[k] || (rows[k] = { k, eventId: ev.id, game, market: mk.key, player: o.description, line: o.point, books: {} });
      const b = row.books[bk.key] || (row.books[bk.key] = { title: bk.title, dfs: isDfs(bk.key) });
      const side = /^over$/i.test(o.name) ? "over" : /^under$/i.test(o.name) ? "under" : null;
      if (side) b[side] = o.price;
    }
  }
  L = { sport: S.picks.sport, at: Date.now(), rows: Object.values(rows), failed };
  price(L);
  try { localStorage.setItem(LINES_KEY, JSON.stringify(L)); } catch (e) {}
  save();
}
function short(team) { const w = String(team || "").split(" "); return w[w.length - 1]; }

/* Fair chances: remove each sportsbook's vig, average them; shift to other lines if needed. */
function price(L) {
  const byPM = {};
  for (const r of L.rows) {
    const fair = [];
    for (const b of Object.values(r.books)) if (!b.dfs && b.over != null && b.under != null) { const po = imp(b.over), pu = imp(b.under); fair.push(po / (po + pu)); }
    r.nBooks = fair.length;
    r.fairOver = fair.length ? fair.reduce((a, c) => a + c, 0) / fair.length : null;
    (byPM[r.eventId + "|" + r.market + "|" + r.player] ||= []).push(r);
  }
  for (const group of Object.values(byPM)) {
    const ref = group.filter(r => r.fairOver != null).sort((a, b) => b.nBooks - a.nBooks)[0];
    for (const r of group) if (r.fairOver == null && ref) { r.fairOver = shiftOver(ref.fairOver, ref.line, r.line); r.adjusted = ref.line; r.nBooks = ref.nBooks; }
  }
}

/* ---------- Candidates and slips ---------- */
function candidates() {
  if (!L) return [];
  const out = [];
  for (const r of L.rows) {
    if (r.fairOver == null) continue;
    for (const side of ["over", "under"]) {
      const p = side === "over" ? r.fairOver : 1 - r.fairOver;
      let best = null;
      for (const [key, b] of Object.entries(r.books)) if (!b.dfs && b[side] != null && (!best || b[side] > best.odds)) best = { key, title: b.title, odds: b[side] };
      const dfs = Object.entries(r.books).filter(([, b]) => b.dfs && (b[side] != null || (b.over == null && b.under == null))).map(([, b]) => b.title);
      const hr = r.l10 ? (side === "over" ? r.l10.over : r.l10.n - r.l10.over) / r.l10.n : null;
      const pm = hr != null && r.l10.n >= 5 ? 0.8 * p + 0.2 * Math.min(0.9, Math.max(0.1, hr)) : p;
      out.push({ r, side, p, pm, hr, best, dfs, id: r.k + "|" + side });
    }
  }
  return out.sort((a, b) => b.pm - a.pm);
}
function pickLegs(list, n) {
  const legs = [], players = new Set(), perGame = {};
  for (const c of list) {
    if (legs.length >= n) break;
    if (players.has(c.r.player) || (perGame[c.r.eventId] || 0) >= 2) continue;
    legs.push(c); players.add(c.r.player); perGame[c.r.eventId] = (perGame[c.r.eventId] || 0) + 1;
  }
  return legs.length === n ? legs : null;
}
function buildSlip() {
  const n = S.picks.legs, all = candidates();
  if (S.picks.mode === "pickem") {
    const hasDfs = all.some(c => c.dfs.length);
    const pool = hasDfs ? all.filter(c => c.dfs.length) : all;
    const legs = pickLegs(pool, n); if (!legs) return null;
    const hit = legs.reduce((a, c) => a * c.pm, 1), mult = +S.picks.payouts[n] || 0;
    return { legs, hit, mult, ev: hit * mult - 1, where: hasDfs ? [...new Set(legs.flatMap(c => c.dfs))].join(" / ") : null, hasDfs };
  }
  // Sportsbook parlay: must be placed at one book, so try each book and keep the best value.
  const books = {};
  for (const c of all) for (const [key, b] of Object.entries(c.r.books)) if (!b.dfs && b[c.side] != null) (books[key] ||= { title: b.title, list: [] }).list.push({ ...c, odds: b[c.side] });
  let best = null;
  for (const bk of Object.values(books)) {
    const legs = pickLegs(bk.list.sort((a, b) => b.pm - a.pm), n); if (!legs) continue;
    const hit = legs.reduce((a, c) => a * c.pm, 1), d = legs.reduce((a, c) => a * dec(c.odds), 1), ev = hit * d - 1;
    if (!best || hit > best.hit + 0.005 || (Math.abs(hit - best.hit) <= 0.005 && ev > best.ev)) best = { legs, hit, d, ev, where: bk.title };
  }
  return best;
}

/* ESPN last-10 for the top candidates (NBA/WNBA only). */
async function addHitRates() {
  const sp = SPORTS[L.sport]; if (!sp.espn) return;
  const top = []; const seen = new Set();
  for (const c of candidates()) { if (!seen.has(c.r.k)) { seen.add(c.r.k); top.push(c.r); } if (top.length >= 30) break; }
  for (const r of top) {
    const stat = sp.markets[r.market]; if (!AUTO[stat]) continue;
    try {
      let id = idCache[sp.espn + ":" + r.player];
      if (!id) { const res = await espnSearch(r.player); const m = res.find(x => x.league === sp.espn); if (!m) continue; id = idCache[sp.espn + ":" + r.player] = m.id; saveIds(); }
      r.athleteId = id;
      const games = await lastTen(id, sp.espn, stat);
      if (games && games.length) r.l10 = { n: games.length, over: games.filter(v => v > r.line).length, games };
    } catch (e) { /* ESPN unreachable: skip */ }
  }
  try { localStorage.setItem(LINES_KEY, JSON.stringify(L)); } catch (e) {}
}

/* ---------- Render ---------- */
const mName = m => (SPORTS[(L && L.sport) || S.picks.sport].markets[m]) || m;
const legText = c => `${c.side === "over" ? "Over" : "Under"} ${c.r.line} ${mName(c.r.market)}`;
function renderPicks() {
  const el = $("#picksView");
  if (!S.oddsKey) { el.innerHTML = setupHTML(); return; }
  const sp = SPORTS[S.picks.sport];
  const gameList = events.length ? `<div class="stack" style="gap:6px;margin-top:10px">${events.map(e => `<label style="display:flex;gap:10px;align-items:center;color:var(--fg);font-size:14px;margin:0"><input type="checkbox" data-game="${e.id}" ${S.picks.games.includes(e.id) ? "checked" : ""} style="width:20px;height:20px;flex:none"> ${esc(short(e.away_team))} @ ${esc(short(e.home_team))} <span class="note">${new Date(e.commence_time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></label>`).join("")}</div>
     <button class="btn" id="loadLines" style="margin-top:12px">Load lines · about ${estCredits(S.picks.games.length)} credits</button>` : "";
  const fresh = L && L.sport === S.picks.sport;
  el.innerHTML = `
  <div class="card">
    <div class="grid2">
      <div><label for="pSport">Sport</label><select id="pSport">${Object.entries(SPORTS).map(([k, v]) => `<option value="${k}" ${k === S.picks.sport ? "selected" : ""}>${v.name}</option>`).join("")}</select></div>
      <div><label>&nbsp;</label><button class="btn ghost" id="getGames">${events.length ? "Refresh games" : "Get today's games"}</button></div>
    </div>
    <div class="chips" style="margin:12px 0 0;flex-wrap:wrap">${Object.entries(sp.markets).map(([k, v]) => `<button class="chip" data-mk="${k}" aria-pressed="${S.picks.markets.includes(k)}">${v}</button>`).join("")}</div>
    <div class="chips" style="margin:6px 0 0"><button class="chip" id="tBooks" aria-pressed="${S.picks.books}">Sportsbooks</button><button class="chip" id="tDfs" aria-pressed="${S.picks.dfs}">PrizePicks / Underdog</button></div>
    ${gameList}
    <p class="note" id="picksMsg" style="margin:10px 0 0">${fresh ? `Lines from ${new Date(L.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${L.failed ? ` · ${L.failed} games failed` : ""}.` : "Tap Get today's games, pick the games, then Load lines."}${S.picks.remaining != null ? ` ${S.picks.remaining} credits left this month.` : ""}</p>
  </div>
  ${fresh ? slipHTML() + topHTML() : ""}
  <details class="card"><summary style="font-weight:600">Settings</summary>
    <div class="stack" style="margin-top:10px">
      <div><label for="pKey">Odds API key</label><input id="pKey" type="password" value="${esc(S.oddsKey)}" autocomplete="off"></div>
      <div><label>Pick'em payouts (power play)</label><div class="grid2">${[2, 3, 4, 5].map(n => `<div><label for="pay${n}">${n} picks ×</label><input id="pay${n}" class="num" inputmode="decimal" value="${S.picks.payouts[n]}"></div>`).join("")}</div></div>
      <p class="note">Payouts change between apps and promos. Set them to what your app shows.</p>
    </div>
  </details>`;
}
function setupHTML() {
  return `<div class="card stack">
    <b style="font-size:17px">Connect live lines</b>
    <p class="note" style="font-size:14px;color:var(--fg)">PropBoard gets lines from DraftKings, FanDuel, BetMGM, Caesars, PrizePicks, Underdog and more through a service called The Odds API. You need your own free key to use it.</p>
    <ol class="note" style="font-size:14px;color:var(--fg);padding-left:20px;margin:0;line-height:1.7">
      <li>Open <a href="https://the-odds-api.com/#get-access" target="_blank" rel="noopener" style="color:var(--accent)">the-odds-api.com</a> and choose the free plan (500 credits a month).</li>
      <li>They email you a key. Copy it.</li>
      <li>Paste it below and tap Save.</li>
    </ol>
    <div><label for="pKeyNew">API key</label><input id="pKeyNew" autocomplete="off" placeholder="Paste your key"></div>
    <button class="btn" id="saveKey">Save key</button>
    <p class="note">Your key stays on this phone.</p>
  </div>`;
}
function slipHTML() {
  const s = buildSlip(), n = S.picks.legs, pk = S.picks.mode === "pickem";
  const head = `<div class="card">
    <div class="row"><h2 style="margin:0">Best ${n}-pick</h2><span class="badge">${pk ? "Pick'em" : "Parlay"}</span></div>
    <div class="seg" style="margin-top:10px" role="group" aria-label="Number of legs">${[2, 3, 4, 5].map(k => `<button data-legs="${k}" aria-pressed="${k === n}">${k} legs</button>`).join("")}</div>
    <div class="seg" style="margin-top:8px" role="group" aria-label="Slip type"><button data-pmode="pickem" aria-pressed="${pk}">PrizePicks style</button><button data-pmode="book" aria-pressed="${!pk}">Sportsbook parlay</button></div>`;
  if (!s) return head + `<p class="note" style="margin-top:12px">Not enough different players to build ${n} legs. Load more games or more stat types.</p></div>`;
  const be = pk ? Math.pow(1 / (s.mult || 1), 1 / n) : null;
  const legs = s.legs.map(c => `<div class="leg"><div style="min-width:0"><b>${esc(c.r.player)}</b><div class="note">${legText(c)} · ${esc(c.r.game)}</div>
      <div class="note">Fair chance <b class="hot">${pct(c.pm)}</b>${c.hr != null ? ` · L10 ${c.r.l10.games.filter(v => (c.side === "over" ? v > c.r.line : v < c.r.line)).length}/${c.r.l10.n}` : ""}${c.r.adjusted != null ? ` · from books' ${c.r.adjusted} line` : ""}</div></div>
      <span class="num">${pk ? "" : fmtO(c.odds)}</span></div>`).join("");
  const sum = pk
    ? `<div><small>All hit chance</small><b>${pct(s.hit)}</b></div><div><small>Payout</small><b>${s.mult}×</b></div><div><small>Value per $1</small><b class="${s.ev > 0 ? "hot" : "cold"}">${s.ev >= 0 ? "+" : ""}${s.ev.toFixed(2)}</b></div><div><small>Each leg needs</small><b>${pct(be)}</b></div>`
    : `<div><small>All hit chance</small><b>${pct(s.hit)}</b></div><div><small>Odds at ${esc(s.where)}</small><b>${fmtO(toAm(s.d))}</b></div><div><small>Value per $1</small><b class="${s.ev > 0 ? "hot" : "cold"}">${s.ev >= 0 ? "+" : ""}${s.ev.toFixed(2)}</b></div><div><small>Book's implied</small><b>${pct(1 / s.d)}</b></div>`;
  const where = pk ? (s.hasDfs ? `Lines found on ${esc(s.where)}.` : "No PrizePicks or Underdog lines came back, so these use sportsbook lines. Check the line in your app matches before you play it.") : `Place this at ${esc(s.where)}.`;
  return head + `<div style="margin-top:8px">${legs}</div><div class="sum">${sum}</div>
    <p class="note" style="margin-top:10px">${where} Green value means the slip pays more than its chance of hitting. Players are all different and no more than 2 come from the same game.</p>
    <button class="btn" id="slipIt" style="margin-top:10px">Add these ${n} to my slip</button></div>`;
}
function topHTML() {
  const list = candidates().slice(0, 25);
  if (!list.length) return '<div class="card"><p class="note">No lines with both sides came back. Try more games or stat types.</p></div>';
  return `<div class="card"><h2 style="margin:0 0 6px">Top single picks</h2>${list.map((c, i) => `<div class="leg"><div style="min-width:0"><b>${esc(c.r.player)}</b>
    <div class="note">${legText(c)} · ${esc(c.r.game)}</div>
    <div class="note">Fair <b class="hot">${pct(c.pm)}</b> · ${c.r.nBooks} books${c.best ? ` · best ${fmtO(c.best.odds)} ${esc(c.best.title)}` : ""}${c.dfs.length ? ` · ${esc(c.dfs.join(", "))}` : ""}${c.hr != null ? ` · L10 ${Math.round(c.hr * c.r.l10.n)}/${c.r.l10.n}` : ""}</div></div>
    <button class="x" data-top="${i}" aria-label="Add to slip">+</button></div>`).join("")}</div>`;
}

/* ---------- Add to slip ---------- */
function addToSlip(c, odds) {
  const sp = SPORTS[L.sport];
  let p = S.props.find(x => x.key === c.r.k);
  if (!p) {
    p = { id: "o" + Date.now() + Math.random().toString(36).slice(2, 6), key: c.r.k, player: c.r.player, team: "", opp: c.r.game, stat: sp.markets[c.r.market] || c.r.market, line: c.r.line,
      over: (c.best && c.side === "over" ? c.best.odds : null) ?? Object.values(c.r.books).find(b => b.over != null)?.over ?? -110,
      under: (c.best && c.side === "under" ? c.best.odds : null) ?? Object.values(c.r.books).find(b => b.under != null)?.under ?? -110,
      log: c.r.l10 ? c.r.l10.games : [], athleteId: c.r.athleteId || null, league: c.r.athleteId ? sp.espn : null };
    S.props.unshift(p);
  }
  const leg = { id: p.id, player: p.player, stat: p.stat, line: p.line, side: c.side, odds: odds ?? (c.side === "over" ? p.over : p.under), cur: 0 };
  const i = S.slip.findIndex(l => l.id === p.id);
  if (i > -1) S.slip[i] = leg; else S.slip.push(leg);
}

/* ---------- Events ---------- */
async function run(btn, label, fn) {
  const msg = $("#picksMsg"); if (btn) { btn.disabled = true; btn.textContent = label; }
  try { await fn(); } catch (e) { renderPicks(); const m = $("#picksMsg"); if (m) m.textContent = e.message && !/fetch/i.test(e.message) ? e.message : "Couldn't reach the odds service. Check your connection and try again."; return; }
  renderPicks();
}
$("#picksView").addEventListener("click", e => {
  const t = e.target;
  if (t.id === "saveKey") { const k = $("#pKeyNew").value.trim(); if (!k) { toast("Paste your key first"); return; } S.oddsKey = k; save(); renderPicks(); toast("Key saved"); return; }
  if (t.id === "getGames") return run(t, "Getting games…", loadGames);
  if (t.id === "loadLines") { if (!S.picks.games.length) { toast("Pick at least one game"); return; } if (!S.picks.markets.length) { toast("Pick at least one stat"); return; } if (!regions().length) { toast("Turn on sportsbooks or PrizePicks"); return; }
    return run(t, "Loading lines…", async () => { await loadLines(); renderPicks(); const m = $("#picksMsg"); if (m) m.textContent = "Adding ESPN hit rates…"; await addHitRates(); }); }
  const mk = t.closest("[data-mk]"); if (mk) { const k = mk.dataset.mk; S.picks.markets = S.picks.markets.includes(k) ? S.picks.markets.filter(x => x !== k) : [...S.picks.markets, k]; save(); renderPicks(); return; }
  if (t.id === "tBooks") { S.picks.books = !S.picks.books; save(); renderPicks(); return; }
  if (t.id === "tDfs") { S.picks.dfs = !S.picks.dfs; save(); renderPicks(); return; }
  const lg = t.closest("[data-legs]"); if (lg) { S.picks.legs = +lg.dataset.legs; save(); renderPicks(); return; }
  const pm = t.closest("[data-pmode]"); if (pm) { S.picks.mode = pm.dataset.pmode; save(); renderPicks(); return; }
  if (t.id === "slipIt") { const s = buildSlip(); if (!s) return; S.slip = []; s.legs.forEach(c => addToSlip(c, c.odds)); if (S.picks.mode === "book") S.mode = "parlay"; save(); render(); toast(`Added ${s.legs.length} legs to your slip`); return; }
  const tp = t.closest("[data-top]"); if (tp) { const c = candidates()[+tp.dataset.top]; addToSlip(c); save(); render(); toast("Added to slip"); }
});
$("#picksView").addEventListener("change", e => {
  const t = e.target;
  if (t.id === "pSport") { S.picks.sport = t.value; S.picks.markets = DEFAULT_MARKETS[t.value].slice(); events = []; S.picks.games = []; save(); renderPicks(); }
  else if (t.dataset.game) { S.picks.games = t.checked ? [...S.picks.games, t.dataset.game] : S.picks.games.filter(x => x !== t.dataset.game); save(); renderPicks(); }
  else if (t.id === "pKey") { S.oddsKey = t.value.trim(); save(); renderPicks(); }
  else if (/^pay\d$/.test(t.id)) { const v = parseFloat(t.value); if (v > 0) { S.picks.payouts[t.id.slice(3)] = v; save(); renderPicks(); } }
});
S.picks.games = S.picks.games || [];
renderPicks();
