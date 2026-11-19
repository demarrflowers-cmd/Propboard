"use strict";
/* Picks tab: an edge finder for player props.
   Pulls lines from sharp and major sportsbooks plus pick'em apps (The Odds API), removes the vig
   (sharper books count more), and compares that fair chance with what a pick'em slip needs to break even.
   Then it checks every combination to find the best 2-5 pick slips. Uses globals from app.js. */

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
// Up to 10 named books cost the same as one region, so we ask for these by name.
const SHARP_BOOKS = ["pinnacle", "fanduel", "draftkings", "betmgm", "williamhill_us", "betrivers", "betonlineag", "bovada"];
const PICKEM_BOOKS = ["prizepicks", "underdog"];
// The odds service still calls Caesars by its old name, William Hill.
const BOOK_NAMES = { williamhill_us: "Caesars", fanduel: "FanDuel", draftkings: "DraftKings", betmgm: "BetMGM", betrivers: "BetRivers",
  pinnacle: "Pinnacle", betonlineag: "BetOnline", bovada: "Bovada", prizepicks: "PrizePicks", underdog: "Underdog" };
const PARLAY_BOOKS = ["williamhill_us", "fanduel", "draftkings", "betmgm", "betrivers"];
const bookName = (k, t) => BOOK_NAMES[k] || t || k;
const WEIGHT = { pinnacle: 3, betonlineag: 1.5, fanduel: 1.5, draftkings: 1.2 };
const isDfs = k => PICKEM_BOOKS.includes(k) || /dfs|pick6|sleeper|betr/i.test(k);

S.picks = Object.assign({ sport: "basketball_nba", markets: null, dfs: true, books: true, legs: 3, mode: "pickem",
  payouts: { 2: 3, 3: 5, 4: 10, 5: 20 }, flex: { 3: [2.25, 1.25], 4: [5, 1.5], 5: [10, 2, 0.4] },
  games: [], app: "all", minBooks: 2, mine: [], book: "best" }, S.picks || {});
if (!S.picks.markets) S.picks.markets = DEFAULT_MARKETS[S.picks.sport].slice();
if (!S.picks.flex) S.picks.flex = { 3: [2.25, 1.25], 4: [5, 1.5], 5: [10, 2, 0.4] };
if (!S.picks.mine) S.picks.mine = [];
let L = null;
try { L = JSON.parse(localStorage.getItem(LINES_KEY) || "null"); } catch (e) {}
let events = [];
const idCache = (() => { try { return JSON.parse(localStorage.getItem("propboard-ids") || "{}"); } catch (e) { return {}; } })();
const saveIds = () => { try { localStorage.setItem("propboard-ids", JSON.stringify(idCache)); } catch (e) {} };
const saveLines = () => { try { localStorage.setItem(LINES_KEY, JSON.stringify(L)); } catch (e) {} };

/* ---------- Math ---------- */
function normCdf(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
function normInv(p) { p = Math.min(0.999, Math.max(0.001, p)); let lo = -6, hi = 6; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (normCdf(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; }
const spread = line => Math.max(1.2, 0.3 * line);
function shiftOver(pOver, from, to) { const sd = spread(from); const mu = from + sd * normInv(pOver); return 1 - normCdf((to - mu) / sd); }
// Chance of exactly k hits out of legs with chances ps.
function hitDist(ps) { let d = [1]; for (const p of ps) { const n = new Array(d.length + 1).fill(0); d.forEach((v, k) => { n[k] += v * (1 - p); n[k + 1] += v * p; }); d = n; } return d; }
const powerMult = n => +S.picks.payouts[n] || 0;
const breakEven = n => powerMult(n) ? Math.pow(1 / powerMult(n), 1 / n) : 0.5;
function slipEV(ps) {
  const n = ps.length, dist = hitDist(ps), hit = dist[n];
  const power = hit * powerMult(n) - 1;
  const fl = S.picks.flex[n];
  const flex = fl ? fl.reduce((a, m, i) => a + (dist[n - i] || 0) * m, 0) - 1 : null;
  return { hit, power, flex, best: flex != null && flex > power ? "Flex" : "Power", ev: Math.max(power, flex ?? -1) };
}

/* ---------- Load from The Odds API ---------- */
function bookList() { return [...(S.picks.books ? SHARP_BOOKS : []), ...(S.picks.dfs ? PICKEM_BOOKS : [])]; }
function estCredits(n) { return S.picks.markets.length * Math.ceil(bookList().length / 10) * n; }
async function oddsGet(path, params) {
  const q = new URLSearchParams({ apiKey: S.oddsKey, ...params });
  const r = await fetch(`${ODDS}${path}?${q}`);
  const rem = r.headers.get("x-requests-remaining");
  if (rem != null) S.picks.remaining = rem;
  if (r.status === 401) throw new Error("That API key wasn't accepted. Check it in Settings.");
  if (r.status === 429) throw new Error("Out of free credits for this month, or too many requests at once.");
  if (!r.ok) { const e = new Error("The odds service answered with error " + r.status + "."); e.status = r.status; throw e; }
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
async function eventOdds(id) {
  const base = { markets: S.picks.markets.join(","), oddsFormat: "american" };
  try { return await oddsGet(`/sports/${S.picks.sport}/events/${id}/odds`, { ...base, bookmakers: bookList().join(",") }); }
  catch (e) { // If the service rejects a book name, fall back to whole regions.
    if (e.status !== 422 && e.status !== 400) throw e;
    const regions = [S.picks.books ? "us,eu" : null, S.picks.dfs ? "us_dfs" : null].filter(Boolean).join(",");
    return oddsGet(`/sports/${S.picks.sport}/events/${id}/odds`, { ...base, regions });
  }
}
async function loadLines() {
  const chosen = events.filter(e => S.picks.games.includes(e.id));
  const rows = {};
  let failed = 0;
  for (const ev of chosen) {
    let data;
    try { data = await eventOdds(ev.id); }
    catch (e) { if (/key|credits/i.test(e.message)) throw e; failed++; continue; }
    const game = `${short(data.away_team)} @ ${short(data.home_team)}`;
    for (const bk of data.bookmakers || []) for (const mk of bk.markets || []) for (const o of mk.outcomes || []) {
      if (o.point == null || !o.description) continue;
      const k = [ev.id, mk.key, o.description, o.point].join("|");
      const row = rows[k] || (rows[k] = { k, eventId: ev.id, game, market: mk.key, player: o.description, line: o.point, books: {} });
      const b = row.books[bk.key] || (row.books[bk.key] = { title: bookName(bk.key, bk.title), dfs: isDfs(bk.key) });
      const side = /^over$/i.test(o.name) ? "over" : /^under$/i.test(o.name) ? "under" : null;
      if (side) b[side] = o.price;
    }
  }
  L = { sport: S.picks.sport, at: Date.now(), rows: Object.values(rows), failed };
  price(L);
  S.picks.mine = [];
  saveLines(); save();
}
function short(team) { const w = String(team || "").split(" "); return w[w.length - 1]; }

/* Fair chances: remove each book's vig, then average with sharper books counting more. */
function price(L) {
  const byPM = {};
  for (const r of L.rows) {
    let sw = 0, sp = 0, n = 0;
    r.sharp = null;
    for (const [key, b] of Object.entries(r.books)) if (!b.dfs && b.over != null && b.under != null) {
      const po = imp(b.over), pu = imp(b.under), f = po / (po + pu), w = WEIGHT[key] || 1;
      sw += w; sp += w * f; n++;
      if (key === "pinnacle") r.sharp = f;
    }
    r.nBooks = n;
    r.fairOver = n ? sp / sw : null;
    r.adjusted = null;
    (byPM[r.eventId + "|" + r.market + "|" + r.player] ||= []).push(r);
  }
  for (const group of Object.values(byPM)) {
    const ref = group.filter(r => r.fairOver != null).sort((a, b) => b.nBooks - a.nBooks)[0];
    for (const r of group) {
      r.bookLine = ref ? ref.line : null;
      if (r.fairOver == null && ref) { r.fairOver = shiftOver(ref.fairOver, ref.line, r.line); r.adjusted = ref.line; r.nBooks = ref.nBooks; }
    }
  }
}

/* ---------- Candidates ---------- */
function candidates() {
  if (!L) return [];
  const out = [];
  for (const r of L.rows) {
    if (r.fairOver == null) continue;
    for (const side of ["over", "under"]) {
      const p = side === "over" ? r.fairOver : 1 - r.fairOver;
      let best = null;
      for (const [key, b] of Object.entries(r.books)) if (!b.dfs && b[side] != null && (!best || b[side] > best.odds)) best = { key, title: b.title, odds: b[side] };
      const apps = Object.entries(r.books).filter(([, b]) => b.dfs && (b[side] != null || (b.over == null && b.under == null))).map(([k, b]) => ({ key: k, title: b.title }));
      const hr = r.l10 ? (side === "over" ? r.l10.over : r.l10.n - r.l10.over - (r.l10.push || 0)) / r.l10.n : null;
      const pm = hr != null && r.l10.n >= 5 ? 0.85 * p + 0.15 * Math.min(0.9, Math.max(0.1, hr)) : p;
      out.push({ r, side, p, pm, hr, best, apps, bookEV: best ? pm * dec(best.odds) - 1 : null, id: r.k + "|" + side });
    }
  }
  return out.sort((a, b) => b.pm - a.pm);
}
function pickemPool() {
  return candidates().filter(c => c.apps.length && c.pm > 0.5 && c.r.nBooks >= S.picks.minBooks &&
    (S.picks.app === "all" || c.apps.some(a => a.key === S.picks.app)));
}

/* Price a leg at the chosen sportsbook, or at the best price anywhere. */
function withBook(c) {
  if (S.picks.book === "best") return c.best ? c : null;
  const b = c.r.books[S.picks.book];
  if (!b || b[c.side] == null) return null;
  const odds = b[c.side];
  return { ...c, best: { key: S.picks.book, title: b.title, odds }, bookEV: c.pm * dec(odds) - 1 };
}
function bookChips() {
  const opts = [["best", "Best price"], ...PARLAY_BOOKS.map(k => [k, BOOK_NAMES[k]])];
  return `<div class="chips" style="margin:10px 0 0" role="group" aria-label="Sportsbook">${opts.map(([k, t]) => `<button class="chip" data-book="${k}" aria-pressed="${S.picks.book === k}">${t}</button>`).join("")}</div>`;
}

/* Check every combination of the strongest legs and keep the best few. */
function combos(pool, n, scoreFn, keep) {
  const top = [];
  const legs = [];
  const players = new Set(), perGame = {};
  function walk(start) {
    if (legs.length === n) {
      const s = scoreFn(legs);
      if (s == null) return;
      if (top.length < keep || s.ev > top[top.length - 1].ev) {
        top.push({ ...s, legs: legs.slice() }); top.sort((a, b) => b.ev - a.ev); if (top.length > keep) top.pop();
      }
      return;
    }
    for (let i = start; i < pool.length; i++) {
      const c = pool[i];
      if (players.has(c.r.player) || (perGame[c.r.eventId] || 0) >= 2) continue;
      legs.push(c); players.add(c.r.player); perGame[c.r.eventId] = (perGame[c.r.eventId] || 0) + 1;
      walk(i + 1);
      legs.pop(); players.delete(c.r.player); perGame[c.r.eventId]--;
    }
  }
  walk(0);
  return top;
}
const POOL_SIZE = { 2: 40, 3: 30, 4: 22, 5: 18 };
function bestSlips() {
  const n = S.picks.legs;
  if (S.picks.mode === "pickem") {
    const pool = pickemPool().slice(0, POOL_SIZE[n]);
    return combos(pool, n, legs => { const e = slipEV(legs.map(c => c.pm)); return { ...e, where: [...new Set(legs.flatMap(c => c.apps.map(a => a.title)))].join(" / ") }; }, 3);
  }
  const byBook = {};
  for (const c of candidates()) for (const [key, b] of Object.entries(c.r.books))
    if (!b.dfs && b[c.side] != null && c.r.nBooks >= S.picks.minBooks && (S.picks.book === "best" || S.picks.book === key)) (byBook[key] ||= { title: b.title, list: [] }).list.push({ ...c, odds: b[c.side] });
  let all = [];
  for (const bk of Object.values(byBook)) {
    const pool = bk.list.map(c => ({ ...c, ev1: c.pm * dec(c.odds) - 1 })).sort((a, b) => b.ev1 - a.ev1).slice(0, POOL_SIZE[n]);
    all = all.concat(combos(pool, n, legs => {
      const hit = legs.reduce((a, c) => a * c.pm, 1), d = legs.reduce((a, c) => a * dec(c.odds), 1);
      return { hit, d, ev: hit * d - 1, where: bk.title };
    }, 3));
  }
  return all.sort((a, b) => b.ev - a.ev).slice(0, 3);
}

/* ESPN last-10 for the strongest legs (NBA/WNBA only). */
async function addHitRates() {
  const sp = SPORTS[L.sport]; if (!sp.espn) return;
  const rows = []; const seen = new Set();
  for (const c of [...pickemPool(), ...candidates()]) { if (!seen.has(c.r.k)) { seen.add(c.r.k); rows.push(c.r); } if (rows.length >= 30) break; }
  for (const r of rows) {
    const stat = sp.markets[r.market]; if (!AUTO[stat]) continue;
    try {
      let id = idCache[sp.espn + ":" + r.player];
      if (!id) { const res = await espnSearch(r.player); const m = res.find(x => x.league === sp.espn); if (!m) continue; id = idCache[sp.espn + ":" + r.player] = m.id; saveIds(); }
      r.athleteId = id;
      const games = await lastTen(id, sp.espn, stat);
      if (games && games.length) r.l10 = { n: games.length, over: games.filter(v => v > r.line).length, push: games.filter(v => v === r.line).length, games };
    } catch (e) { /* ESPN unreachable: skip */ }
  }
  saveLines();
}

/* ---------- Render ---------- */
const mName = m => (SPORTS[(L && L.sport) || S.picks.sport].markets[m]) || m;
const legText = c => `${c.side === "over" ? "Over" : "Under"} ${c.r.line} ${mName(c.r.market)}`;
const sgn = (x, d = 1) => (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(d) + "%";
function gapText(c) {
  if (c.r.bookLine == null || c.r.bookLine === c.r.line) return "";
  const diff = c.r.bookLine - c.r.line, good = c.side === "over" ? diff > 0 : diff < 0;
  return ` · <span class="${good ? "hot" : "cold"}">books ${c.r.bookLine}</span>`;
}
function l10Text(c) {
  if (!c.r.l10) return "";
  const g = c.r.l10.games, h = g.filter(v => (c.side === "over" ? v > c.r.line : v < c.r.line)).length;
  return ` · L10 ${h}/${g.length}`;
}
function renderPicks() {
  const el = $("#picksView");
  if (!el) return;
  if (!S.oddsKey) { el.innerHTML = setupHTML(); return; }
  const fresh = L && L.sport === S.picks.sport;
  el.innerHTML = controlsHTML(fresh) + (fresh ? bestHTML() + mineHTML() + edgeHTML() : "") + settingsHTML();
}
function controlsHTML(fresh) {
  const sp = SPORTS[S.picks.sport];
  const gameList = events.length ? `<div class="stack" style="gap:6px;margin-top:10px">${events.map(e => `<label style="display:flex;gap:10px;align-items:center;color:var(--fg);font-size:14px;margin:0"><input type="checkbox" data-game="${e.id}" ${S.picks.games.includes(e.id) ? "checked" : ""} style="width:20px;height:20px;flex:none"> ${esc(short(e.away_team))} @ ${esc(short(e.home_team))} <span class="note">${new Date(e.commence_time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></label>`).join("")}</div>
     <button class="btn" id="loadLines" style="margin-top:12px">Load lines · about ${estCredits(S.picks.games.length)} credits</button>` : "";
  return `<div class="card">
    <div class="grid2">
      <div><label for="pSport">Sport</label><select id="pSport">${Object.entries(SPORTS).map(([k, v]) => `<option value="${k}" ${k === S.picks.sport ? "selected" : ""}>${v.name}</option>`).join("")}</select></div>
      <div><label>&nbsp;</label><button class="btn ghost" id="getGames">${events.length ? "Refresh games" : "Get today's games"}</button></div>
    </div>
    <div class="chips" style="margin:12px 0 0;flex-wrap:wrap">${Object.entries(sp.markets).map(([k, v]) => `<button class="chip" data-mk="${k}" aria-pressed="${S.picks.markets.includes(k)}">${v}</button>`).join("")}</div>
    <div class="chips" style="margin:6px 0 0"><button class="chip" id="tBooks" aria-pressed="${S.picks.books}">Sportsbooks + Pinnacle</button><button class="chip" id="tDfs" aria-pressed="${S.picks.dfs}">PrizePicks / Underdog</button></div>
    ${gameList}
    <p class="note" id="picksMsg" style="margin:10px 0 0">${fresh ? `Lines from ${new Date(L.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${L.failed ? ` · ${L.failed} games failed` : ""}. Lines move, so reload before you play.` : "Tap Get today's games, pick the games, then Load lines."}${S.picks.remaining != null ? ` ${S.picks.remaining} credits left this month.` : ""}</p>
  </div>`;
}
function slipBlock(s, i, pk, n) {
  const legs = s.legs.map(c => `<div class="leg"><div style="min-width:0"><b>${esc(c.r.player)}</b><div class="note">${legText(c)} · ${esc(c.r.game)}${pk ? gapText(c) : ""}</div>
      <div class="note">Win <b class="hot">${pct(c.pm)}</b>${pk ? ` · edge <b class="${c.pm - breakEven(n) > 0 ? "hot" : "cold"}">${sgn(c.pm - breakEven(n))}</b>` : ""}${l10Text(c)} · ${c.r.nBooks} books</div></div>
      <span class="num">${pk ? "" : fmtO(c.odds)}</span></div>`).join("");
  const sum = pk
    ? `<div><small>All ${n} hit</small><b>${pct(s.hit)}</b></div><div><small>Play as</small><b>${s.best}</b></div>
       <div><small>Power ${powerMult(n)}× edge</small><b class="${s.power > 0 ? "hot" : "cold"}">${sgn(s.power)}</b></div><div><small>Flex edge</small><b class="${s.flex > 0 ? "hot" : "cold"}">${s.flex == null ? "—" : sgn(s.flex)}</b></div>`
    : `<div><small>All ${n} hit</small><b>${pct(s.hit)}</b></div><div><small>Odds at ${esc(s.where)}</small><b>${fmtO(toAm(s.d))}</b></div>
       <div><small>Edge</small><b class="${s.ev > 0 ? "hot" : "cold"}">${sgn(s.ev)}</b></div><div><small>Book's implied</small><b>${pct(1 / s.d)}</b></div>`;
  const title = i === 0 ? "" : `<div class="row" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)"><b>Option ${i + 1}</b><span class="note">${pk ? esc(s.where) : esc(s.where)}</span></div>`;
  return `${title}<div style="margin-top:6px">${legs}</div><div class="sum">${sum}</div>
    <button class="btn ${i ? "ghost" : ""}" data-slipit="${i}" style="margin-top:10px">Add option ${i + 1} to my slip</button>`;
}
function bestHTML() {
  const n = S.picks.legs, pk = S.picks.mode === "pickem", slips = bestSlips();
  window._slips = slips;
  const head = `<div class="card">
    <div class="row"><h2 style="margin:0">Best ${n}-pick</h2><span class="badge">${pk ? "Pick'em" : "Parlay"}</span></div>
    <div class="seg" style="margin-top:10px" role="group" aria-label="Number of picks">${[2, 3, 4, 5].map(k => `<button data-legs="${k}" aria-pressed="${k === n}">${k} picks</button>`).join("")}</div>
    <div class="seg" style="margin-top:8px" role="group" aria-label="Slip type"><button data-pmode="pickem" aria-pressed="${pk}">PrizePicks / Underdog</button><button data-pmode="book" aria-pressed="${!pk}">Sportsbook parlay</button></div>
    ${pk ? "" : bookChips()}
    ${pk ? `<p class="note" style="margin:10px 0 0">A ${n}-pick Power at ${powerMult(n)}× needs each leg to win <b>${pct(breakEven(n))}</b> to break even. Edge is how far a leg beats that.</p>` : ""}`;
  if (!slips.length) {
    const why = pk && L.rows.every(r => !Object.values(r.books).some(b => b.dfs)) ? "No PrizePicks or Underdog lines came back for these games. Turn on PrizePicks / Underdog and load again, or switch to Sportsbook parlay." : `Not enough strong legs from different players to build ${n} picks. Load more games or stat types, or lower “Books needed” in Settings.`;
    return head + `<p class="note" style="margin-top:12px">${why}</p></div>`;
  }
  return head + slips.map((s, i) => slipBlock(s, i, pk, n)).join("") +
    `<p class="note" style="margin-top:12px">Checked every mix of the ${POOL_SIZE[n]} strongest legs. Each slip uses different players, with no more than 2 from one game. Win chances treat legs as separate, but teammates can rise and fall together.</p></div>`;
}
function mineHTML() {
  const all = candidates(), mine = S.picks.mine.map(id => all.find(c => c.id === id)).filter(Boolean);
  if (!mine.length) return "";
  const n = mine.length, e = n >= 2 && n <= 5 ? slipEV(mine.map(c => c.pm)) : null;
  return `<div class="card"><div class="row"><h2 style="margin:0">Your picks</h2><button class="small-btn" id="clearMine">Clear</button></div>
    ${mine.map(c => `<div class="leg"><div style="min-width:0"><b>${esc(c.r.player)}</b><div class="note">${legText(c)} · win ${pct(c.pm)}</div></div><button class="x" data-unmine="${esc(c.id)}" aria-label="Remove">✕</button></div>`).join("")}
    ${e ? `<div class="sum"><div><small>All ${n} hit</small><b>${pct(e.hit)}</b></div><div><small>Play as</small><b>${e.best}</b></div><div><small>Power edge</small><b class="${e.power > 0 ? "hot" : "cold"}">${sgn(e.power)}</b></div><div><small>Flex edge</small><b class="${e.flex > 0 ? "hot" : "cold"}">${e.flex == null ? "—" : sgn(e.flex)}</b></div></div>
      <button class="btn" id="mineToSlip" style="margin-top:10px">Add to my slip</button>` : `<p class="note">${n < 2 ? "Add at least 2 picks." : "Pick'em slips go up to 5 picks."}</p>`}</div>`;
}
function edgeHTML() {
  const pk = S.picks.mode === "pickem", n = S.picks.legs, be = breakEven(n);
  let list, rows;
  if (pk) {
    list = pickemPool().map(c => ({ c, edge: c.pm - be })).sort((a, b) => b.edge - a.edge).slice(0, 40);
    rows = list.map(({ c, edge }) => `<div class="leg"><div style="min-width:0;flex:1"><b>${esc(c.r.player)}</b>
      <div class="note">${legText(c)} · ${esc(c.apps.map(a => a.title).join(", "))}${gapText(c)}</div>
      <div class="meter" aria-hidden="true"><i style="width:${(c.pm * 100).toFixed(1)}%" class="${edge > 0 ? "" : "neg"}"></i><b style="left:${(be * 100).toFixed(1)}%"></b></div>
      <div class="note">Win <b>${pct(c.pm)}</b> · edge <b class="${edge > 0 ? "hot" : "cold"}">${sgn(edge)}</b>${c.r.sharp != null ? ` · Pinnacle ${pct(c.side === "over" ? c.r.sharp : 1 - c.r.sharp)}` : ""}${l10Text(c)} · ${c.r.nBooks} books</div></div>
      <button class="x" data-mine="${esc(c.id)}" aria-pressed="${S.picks.mine.includes(c.id)}" aria-label="Add to your picks">${S.picks.mine.includes(c.id) ? "✓" : "+"}</button></div>`);
  } else {
    list = candidates().map(c => withBook(c)).filter(c => c && c.r.nBooks >= S.picks.minBooks).sort((a, b) => b.bookEV - a.bookEV).slice(0, 40);
    rows = list.map(c => `<div class="leg"><div style="min-width:0"><b>${esc(c.r.player)}</b><div class="note">${legText(c)} · ${esc(c.r.game)}</div>
      <div class="note">Win <b>${pct(c.pm)}</b> · ${S.picks.book === "best" ? "best " : ""}<b>${fmtO(c.best.odds)}</b> ${esc(c.best.title)} · edge <b class="${c.bookEV > 0 ? "hot" : "cold"}">${sgn(c.bookEV)}</b>${l10Text(c)}</div></div>
      <button class="x" data-top="${esc(c.id)}" aria-label="Add to slip">+</button></div>`);
  }
  const apps = pk ? `<div class="chips" style="margin:8px 0 4px">${[["all", "All apps"], ["prizepicks", "PrizePicks"], ["underdog", "Underdog"]].map(([k, t]) => `<button class="chip" data-app="${k}" aria-pressed="${S.picks.app === k}">${t}</button>`).join("")}</div>` : "";
  return `<div class="card"><h2 style="margin:0">Edge finder</h2>
    <p class="note" style="margin:4px 0 0">${pk ? `Every pick'em line, ranked by how far its win chance beats the ${pct(be)} a ${n}-pick needs. The yellow tick is break-even. Tap + to build your own slip.` : S.picks.book === "best" ? "Single bets ranked by edge at the best price across all books. Green means it pays more than its fair chance." : `Single bets at ${BOOK_NAMES[S.picks.book]}, ranked by edge. Green means it pays more than its fair chance.`}</p>
    ${apps}${rows.length ? rows.join("") : '<p class="note" style="margin-top:10px">Nothing with an edge right now. Try more games or stat types.</p>'}</div>`;
}
function settingsHTML() {
  return `<details class="card"><summary style="font-weight:600">Settings</summary>
    <div class="stack" style="margin-top:10px">
      <div><label for="pKey">Odds API key</label><input id="pKey" type="password" value="${esc(S.oddsKey || "")}" autocomplete="off"></div>
      <div><label for="pMinBooks">Books needed to trust a line</label><select id="pMinBooks">${[1, 2, 3, 4].map(k => `<option ${k === S.picks.minBooks ? "selected" : ""}>${k}</option>`).join("")}</select></div>
      <div><label>Power payouts</label><div class="grid2">${[2, 3, 4, 5].map(n => `<div><label for="pay${n}">${n} picks ×</label><input id="pay${n}" class="num" inputmode="decimal" value="${S.picks.payouts[n]}"></div>`).join("")}</div></div>
      <div><label>Flex payouts (all hit, then one miss, two misses)</label><div class="grid2">${[3, 4, 5].map(n => `<div><label for="flex${n}">${n} picks</label><input id="flex${n}" class="num" value="${(S.picks.flex[n] || []).join(", ")}"></div>`).join("")}</div></div>
      <p class="note">Payouts change between apps and promos. Set them to what your app shows.</p>
    </div>
  </details>`;
}
function setupHTML() {
  return `<div class="card stack">
    <b style="font-size:17px">Connect live lines</b>
    <p class="note" style="font-size:14px;color:var(--fg)">PropBoard compares PrizePicks and Underdog lines with Pinnacle, FanDuel, DraftKings, BetMGM, Caesars and more through a service called The Odds API. You need your own free key.</p>
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

/* ---------- Add to slip ---------- */
function addToSlip(c, odds) {
  const sp = SPORTS[L.sport];
  let p = S.props.find(x => x.key === c.r.k);
  const anyOdds = side => Object.values(c.r.books).find(b => !b.dfs && b[side] != null)?.[side];
  if (!p) {
    p = { id: "o" + Date.now() + Math.random().toString(36).slice(2, 6), key: c.r.k, player: c.r.player, team: "", opp: c.r.game, stat: sp.markets[c.r.market] || c.r.market, line: c.r.line,
      over: anyOdds("over") ?? -110, under: anyOdds("under") ?? -110,
      log: c.r.l10 ? c.r.l10.games : [], athleteId: c.r.athleteId || null, league: c.r.athleteId ? sp.espn : null };
    S.props.unshift(p);
  }
  const leg = { id: p.id, player: p.player, stat: p.stat, line: p.line, side: c.side, odds: odds ?? (c.side === "over" ? p.over : p.under), cur: 0 };
  const i = S.slip.findIndex(l => l.id === p.id);
  if (i > -1) S.slip[i] = leg; else S.slip.push(leg);
}

/* ---------- Events ---------- */
async function run(btn, label, fn) {
  if (btn) { btn.disabled = true; btn.textContent = label; }
  try { await fn(); } catch (e) { renderPicks(); const m = $("#picksMsg"); if (m) m.textContent = e.message && !/fetch|load failed/i.test(e.message) ? e.message : "Couldn't reach the odds service. Check your connection and try again."; return; }
  renderPicks();
}
$("#picksView").addEventListener("click", e => {
  const t = e.target;
  if (t.id === "saveKey") { const k = $("#pKeyNew").value.trim(); if (!k) { toast("Paste your key first"); return; } S.oddsKey = k; save(); renderPicks(); toast("Key saved"); return; }
  if (t.id === "getGames") return run(t, "Getting games…", loadGames);
  if (t.id === "loadLines") {
    if (!S.picks.games.length) { toast("Pick at least one game"); return; }
    if (!S.picks.markets.length) { toast("Pick at least one stat"); return; }
    if (!bookList().length) { toast("Turn on sportsbooks or PrizePicks"); return; }
    return run(t, "Loading lines…", async () => { await loadLines(); renderPicks(); const m = $("#picksMsg"); if (m) m.textContent = "Adding ESPN hit rates…"; await addHitRates(); });
  }
  const mk = t.closest("[data-mk]"); if (mk) { const k = mk.dataset.mk; S.picks.markets = S.picks.markets.includes(k) ? S.picks.markets.filter(x => x !== k) : [...S.picks.markets, k]; save(); renderPicks(); return; }
  if (t.id === "tBooks") { S.picks.books = !S.picks.books; save(); renderPicks(); return; }
  if (t.id === "tDfs") { S.picks.dfs = !S.picks.dfs; save(); renderPicks(); return; }
  const lg = t.closest("[data-legs]"); if (lg) { S.picks.legs = +lg.dataset.legs; save(); renderPicks(); return; }
  const pm = t.closest("[data-pmode]"); if (pm) { S.picks.mode = pm.dataset.pmode; save(); renderPicks(); return; }
  const bkc = t.closest("[data-book]"); if (bkc) { S.picks.book = bkc.dataset.book; save(); renderPicks(); return; }
  const ap = t.closest("[data-app]"); if (ap) { S.picks.app = ap.dataset.app; save(); renderPicks(); return; }
  const si = t.closest("[data-slipit]"); if (si) {
    const s = (window._slips || [])[+si.dataset.slipit]; if (!s) return;
    S.slip = []; s.legs.forEach(c => addToSlip(c, c.odds)); S.mode = "parlay"; save(); render(); toast(`Added ${s.legs.length} picks to your slip`); return;
  }
  const mi = t.closest("[data-mine]"); if (mi) {
    const id = mi.dataset.mine;
    if (S.picks.mine.includes(id)) S.picks.mine = S.picks.mine.filter(x => x !== id);
    else {
      const all = candidates(), c = all.find(x => x.id === id);
      const clash = S.picks.mine.map(x => all.find(y => y.id === x)).find(y => y && y.r.player === c.r.player);
      if (clash) S.picks.mine = S.picks.mine.filter(x => x !== clash.id);
      if (S.picks.mine.length >= 5) { toast("Pick'em slips go up to 5 picks"); return; }
      S.picks.mine.push(id);
    }
    save(); renderPicks(); return;
  }
  const um = t.closest("[data-unmine]"); if (um) { S.picks.mine = S.picks.mine.filter(x => x !== um.dataset.unmine); save(); renderPicks(); return; }
  if (t.id === "clearMine") { S.picks.mine = []; save(); renderPicks(); return; }
  if (t.id === "mineToSlip") { const all = candidates(); S.slip = []; S.picks.mine.forEach(id => { const c = all.find(x => x.id === id); if (c) addToSlip(c); }); save(); render(); toast("Added to your slip"); return; }
  const tp = t.closest("[data-top]"); if (tp) { const c = withBook(candidates().find(x => x.id === tp.dataset.top) || {}); if (c) { addToSlip(c, c.best && c.best.odds); save(); render(); toast("Added to slip"); } }
});
$("#picksView").addEventListener("change", e => {
  const t = e.target;
  if (t.id === "pSport") { S.picks.sport = t.value; S.picks.markets = DEFAULT_MARKETS[t.value].slice(); events = []; S.picks.games = []; save(); renderPicks(); }
  else if (t.dataset.game) { S.picks.games = t.checked ? [...S.picks.games, t.dataset.game] : S.picks.games.filter(x => x !== t.dataset.game); save(); renderPicks(); }
  else if (t.id === "pKey") { S.oddsKey = t.value.trim(); save(); renderPicks(); }
  else if (t.id === "pMinBooks") { S.picks.minBooks = +t.value; save(); renderPicks(); }
  else if (/^pay\d$/.test(t.id)) { const v = parseFloat(t.value); if (v > 0) { S.picks.payouts[t.id.slice(3)] = v; save(); renderPicks(); } }
  else if (/^flex\d$/.test(t.id)) { const v = t.value.split(/[,\s]+/).map(Number).filter(x => isFinite(x) && x >= 0); if (v.length) { S.picks.flex[t.id.slice(4)] = v; save(); renderPicks(); } }
});
if (L) { L.rows.forEach(r => Object.entries(r.books).forEach(([k, b]) => { b.title = bookName(k, b.title); })); price(L); }
renderPicks();
