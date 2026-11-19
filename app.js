"use strict";
/* PropBoard: player prop board with ESPN stats (NBA/WNBA), bet slip, live tracker and odds calculator.
   Everything is saved in this browser only (localStorage). */

const KEY = "propboard-v1";

/* ---------- ESPN ---------- */
const LEAGUES = { nba: { sport: "basketball", name: "NBA" }, wnba: { sport: "basketball", name: "WNBA" } };
const UID_LEAGUE = { "46": "nba", "59": "wnba" };
const num = v => { const x = parseFloat(String(v ?? "").split("-")[0]); return isFinite(x) ? x : null; };
const add = (...xs) => xs.some(x => x == null) ? null : xs.reduce((a, b) => a + b, 0);
// Stats that ESPN can fill in. Keys are ESPN box score labels.
const AUTO = {
  "PTS": r => num(r.PTS),
  "REB": r => num(r.REB),
  "AST": r => num(r.AST),
  "3PM": r => num(r["3PT"]),
  "PRA": r => add(num(r.PTS), num(r.REB), num(r.AST)),
  "P+R": r => add(num(r.PTS), num(r.REB)),
  "P+A": r => add(num(r.PTS), num(r.AST)),
  "R+A": r => add(num(r.REB), num(r.AST)),
  "STL": r => num(r.STL),
  "BLK": r => num(r.BLK),
  "TO":  r => num(r.TO),
};
const STATS = [...Object.keys(AUTO), "SOG", "Pass YDS", "Rush YDS", "Rec YDS", "Hits", "Other"];

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function espnSearch(q) {
  const j = await getJSON(`https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(q)}&limit=15&mode=prefix&type=player`);
  const items = j.items || (j.results || []).flatMap(r => r.contents || []);
  return items.map(it => {
    const uid = it.uid || "";
    const l = uid.match(/l:(\d+)/), a = uid.match(/a:(\d+)/);
    let league = String(it.league || it.defaultLeagueSlug || (l && UID_LEAGUE[l[1]]) || "").toLowerCase();
    if (!league && it.sport === "basketball") league = "nba";
    return {
      id: String(it.id || (a && a[1]) || ""),
      name: it.displayName || it.name || "",
      league,
      sub: it.subtitle || it.description || it.teamName || (LEAGUES[league] ? LEAGUES[league].name : ""),
    };
  }).filter(p => p.id && p.name && LEAGUES[p.league]);
}

const logCache = {};
async function espnGameLog(athleteId, league) {
  const k = league + ":" + athleteId;
  if (logCache[k]) return logCache[k];
  const L = LEAGUES[league];
  const base = `https://site.web.api.espn.com/apis/common/v3/sports/${L.sport}/${league}/athletes/${athleteId}/gamelog`;
  const parse = j => {
    const labels = j.labels || j.names || [];
    const meta = j.events || {};
    const rows = [];
    for (const st of j.seasonTypes || []) {
      if (/pre/i.test(st.displayName || "")) continue;
      for (const c of st.categories || []) for (const ev of c.events || []) {
        const m = meta[ev.eventId] || {};
        const row = {};
        labels.forEach((lab, i) => { row[lab] = (ev.stats || [])[i]; });
        rows.push({ date: m.gameDate || "", row });
      }
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return rows;
  };
  const j = await getJSON(base);
  let rows = parse(j);
  if (rows.length < 10) { // early in the season: add last season's games
    const yr = (j.requestedSeason && j.requestedSeason.year) || (j.season && j.season.year);
    if (yr) { try { rows = parse(await getJSON(`${base}?season=${yr - 1}`)).concat(rows); } catch (e) { /* keep what we have */ } }
  }
  logCache[k] = rows;
  return rows;
}
async function lastTen(athleteId, league, stat) {
  const f = AUTO[stat];
  if (!f) return null;
  const rows = await espnGameLog(athleteId, league);
  return rows.map(r => f(r.row)).filter(v => v != null).slice(-10);
}

/* ---------- State ---------- */
const EXAMPLES = [
  { player: "Example · Guard", team: "HOME", opp: "vs AWAY", stat: "PTS", line: 26.5, over: -115, under: -105, log: [22,31,28,19,30,27,33,24,29,31] },
  { player: "Example · Center", team: "HOME", opp: "vs AWAY", stat: "REB", line: 11.5, over: -120, under: 100, log: [13,9,12,14,10,15,11,12,13,9] },
  { player: "Example · Forward", team: "AWAY", opp: "@ HOME", stat: "PRA", line: 38.5, over: -110, under: -110, log: [35,41,37,44,33,39,36,42,40,35] },
];
let S = { props: [], slip: [], mode: "parlay", stake: 10, filter: "All", view: "board", open: null, lastSync: 0, started: false };
try { const raw = localStorage.getItem(KEY); if (raw) Object.assign(S, JSON.parse(raw)); } catch (e) {}
if (!S.started) { S.props = EXAMPLES.map((p, i) => ({ ...p, id: "ex" + i })); S.started = true; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

/* ---------- Helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtO = o => (o > 0 ? "+" : "") + Math.round(o);
const dec = o => (o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o));
const imp = o => 1 / dec(o);
const toAm = d => (d >= 2 ? (d - 1) * 100 : -100 / (d - 1));
const pct = x => (x * 100).toFixed(1) + "%";
const money = x => "$" + (Math.round(x * 100) / 100).toFixed(2);
const parseOdds = v => { const n = parseFloat(String(v).replace(/[^\d.+-]/g, "")); return isFinite(n) && Math.abs(n) >= 100 ? n : NaN; };
const hits = (p, n) => { const g = p.log.slice(-n); return { h: g.filter(v => v > p.line).length, n: g.length }; };
const avg = (p, n) => { const g = p.log.slice(-n); return g.length ? g.reduce((a, b) => a + b, 0) / g.length : 0; };
let tt; function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => (t.hidden = true), 1800); }

function chart(p, big) {
  const g = p.log.slice(-10);
  if (!g.length) return '<p class="note">No recent games yet.</p>';
  const W = 320, H = big ? 150 : 64, padB = big ? 18 : 4, padT = big ? 14 : 4;
  const max = Math.max(...g, p.line) * 1.12 || 1;
  const bw = W / g.length, y = v => H - padB - (v / max) * (H - padB - padT);
  let s = `<svg class="chart${big ? " big" : ""}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Last ${g.length} games vs line ${p.line}">`;
  g.forEach((v, i) => {
    const x = i * bw + bw * 0.18, w = bw * 0.64, top = y(v);
    s += `<rect x="${x}" y="${top}" width="${w}" height="${H - padB - top}" rx="3" fill="${v > p.line ? "var(--over)" : "var(--under)"}" opacity="${i === g.length - 1 ? 1 : 0.75}"/>`;
    if (big) s += `<text x="${x + w / 2}" y="${top - 3}" fill="var(--muted)" font-size="10" text-anchor="middle" font-family="JetBrains Mono,monospace">${v}</text>`;
  });
  s += `<line x1="0" x2="${W}" y1="${y(p.line)}" y2="${y(p.line)}" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="5 4"/>`;
  if (big) s += `<text x="${W - 2}" y="${H - 4}" fill="var(--muted)" font-size="10" text-anchor="end" font-family="Inter,sans-serif">oldest → latest · line ${p.line}</text>`;
  return s + "</svg>";
}

/* ---------- Board ---------- */
const inSlip = (id, side) => S.slip.some(l => l.id === id && (!side || l.side === side));
function renderChips() {
  const used = ["All", ...STATS.filter(s => S.props.some(p => p.stat === s))];
  $("#statChips").innerHTML = used.map(s => `<button class="chip" aria-pressed="${S.filter === s}" data-f="${esc(s)}">${esc(s)}</button>`).join("");
}
function renderBoard() {
  renderChips();
  const list = S.props.filter(p => S.filter === "All" || p.stat === S.filter);
  if (!list.length) { $("#board").innerHTML = '<div class="empty">No props here yet. Tap “Add a prop” to start.</div>'; return; }
  $("#board").innerHTML = list.map(p => {
    const h5 = hits(p, 5), h10 = hits(p, 10), a = avg(p, 10), open = S.open === p.id;
    const r = h10.n ? h10.h / h10.n : 0.5, cls = r >= 0.6 ? "hot" : r <= 0.4 ? "cold" : "";
    const tag = p.athleteId ? `<span class="badge espn">ESPN ${esc((LEAGUES[p.league] || {}).name || "")}</span>` : String(p.id).startsWith("ex") ? '<span class="badge">Example</span>' : "";
    return `<article class="card" data-id="${p.id}">
      <div class="prop-top">
        <div class="who"><b>${esc(p.player)}</b><small>${esc(p.team)} ${esc(p.opp)} ${tag}</small></div>
        <div class="statline"><div class="ln num">${p.line}</div><small>${esc(p.stat)}</small></div>
      </div>
      <div class="meta"><span>L5 <b class="${cls}">${h5.h}/${h5.n}</b></span><span>L10 <b class="${cls}">${h10.h}/${h10.n}</b></span><span>Avg <b>${a.toFixed(1)}</b></span><span>Edge <b class="${a > p.line ? "hot" : "cold"}">${a > p.line ? "+" : ""}${(a - p.line).toFixed(1)}</b></span></div>
      <button class="link" data-act="toggle" style="display:block;width:100%;padding:0;text-decoration:none" aria-expanded="${open}" aria-label="Show chart">${chart(p, open)}</button>
      <div class="pick">
        <button class="o" data-act="pick" data-side="over" aria-pressed="${inSlip(p.id, "over")}"><span>Over ${p.line}</span><span class="num">${fmtO(p.over)}</span></button>
        <button class="u" data-act="pick" data-side="under" aria-pressed="${inSlip(p.id, "under")}"><span>Under ${p.line}</span><span class="num">${fmtO(p.under)}</span></button>
      </div>
      <button class="link" data-act="edit">Edit</button>
    </article>`;
  }).join("");
}

async function syncStats(manual) {
  const linked = S.props.filter(p => p.athleteId && AUTO[p.stat]);
  if (!linked.length) { if (manual) toast("No ESPN players on your board yet"); return; }
  $("#syncNote").textContent = "Updating stats from ESPN…";
  Object.keys(logCache).forEach(k => delete logCache[k]);
  let ok = 0, fail = 0;
  for (const p of linked) {
    try { const l = await lastTen(p.athleteId, p.league, p.stat); if (l && l.length) { p.log = l; ok++; } } catch (e) { fail++; }
  }
  if (ok) S.lastSync = Date.now();
  save(); renderBoard(); renderSlip();
  $("#syncNote").textContent = fail && !ok ? "Couldn't reach ESPN. You can still type stats in." :
    `Updated ${new Date(S.lastSync).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${fail ? ` · ${fail} failed` : ""}`;
  if (manual) toast(fail && !ok ? "Couldn't reach ESPN" : "Stats updated");
}

/* ---------- Slip ---------- */
function legProb(l) {
  const p = S.props.find(x => x.id === l.id); if (!p) return null;
  const h = hits(p, 10); if (!h.n) return null;
  let r = h.h / h.n; if (l.side === "under") r = 1 - r;
  return Math.min(0.95, Math.max(0.05, r));
}
function renderSlip() {
  const c = $("#slipCount"); c.hidden = !S.slip.length; c.textContent = S.slip.length;
  if (!S.slip.length) { $("#slipCard").innerHTML = '<div class="empty">Your slip is empty.<br>Tap Over or Under on the Board to add a leg.</div>'; return; }
  const legs = S.slip.map((l, i) => `<div class="leg"><div style="min-width:0"><b>${esc(l.player)}</b><div class="note">${l.side === "over" ? "Over" : "Under"} ${l.line} ${esc(l.stat)}</div></div>
    <div class="row"><span class="num">${fmtO(l.odds)}</span><button class="x" data-rm="${i}" aria-label="Remove leg">✕</button></div></div>`).join("");
  const stake = +S.stake || 0;
  let sum;
  if (S.mode === "parlay") {
    const d = S.slip.reduce((a, l) => a * dec(l.odds), 1);
    const probs = S.slip.map(legProb), est = probs.every(x => x != null) ? probs.reduce((a, b) => a * b, 1) : null;
    sum = `<div><small>Parlay odds</small><b>${fmtO(toAm(d))}</b></div><div><small>Payout</small><b>${money(stake * d)}</b></div>
      <div><small>Book's implied</small><b>${pct(1 / d)}</b></div><div><small>L10 hit rate</small><b class="${est != null && est > 1 / d ? "hot" : "cold"}">${est == null ? "—" : pct(est)}</b></div>`;
  } else {
    const tot = S.slip.reduce((a, l) => a + stake * dec(l.odds), 0);
    sum = `<div><small>Total staked</small><b>${money(stake * S.slip.length)}</b></div><div><small>If all win</small><b>${money(tot)}</b></div>`;
  }
  $("#slipCard").innerHTML = `<div class="seg" role="group" aria-label="Bet type"><button data-mode="parlay" aria-pressed="${S.mode === "parlay"}">Parlay</button><button data-mode="singles" aria-pressed="${S.mode === "singles"}">Singles</button></div>
    <div style="margin-top:8px">${legs}</div>
    <div style="margin-top:10px"><label for="stake">${S.mode === "parlay" ? "Stake" : "Stake per bet"} $</label><input id="stake" class="num" inputmode="decimal" value="${S.stake}"></div>
    <div class="sum">${sum}</div>
    <p class="note" style="margin-top:10px">L10 hit rate multiplies each leg's last-10 record. Green means it beats the book's price. It's a rough guide, not a prediction.</p>
    <div class="grid2" style="margin-top:12px"><button class="btn ghost" id="clearSlip">Clear</button><button class="btn" id="toLive">Track live</button></div>`;
}

/* ---------- Live ---------- */
let liveTimer = null, games = [];
const summaryCache = {};
function renderGames() {
  $("#games").innerHTML = games.map(g => `<div class="game">${g.teams.map(t => `<div class="row"><b>${esc(t.abbr)}</b><span class="num">${esc(t.score)}</span></div>`).join("")}<small>${esc(g.status)}</small></div>`).join("");
}
function renderLive() {
  if (!S.slip.length) { $("#live").innerHTML = '<div class="empty">Add legs to your slip, then track them here during the game.</div>'; return; }
  $("#live").innerHTML = S.slip.map((l, i) => {
    const cur = l.cur || 0, need = l.line;
    let st, cls;
    if (l.side === "over") { st = cur > need ? "Hit" : `${Math.floor(need) + 1 - cur} to go`; cls = cur > need ? "hit" : ""; }
    else { st = cur > need ? "Lost" : `${(need - cur).toFixed(1)} of room`; cls = cur > need ? "miss" : ""; }
    if (l.final && !cls) { st = l.side === "under" ? "Hit" : "Missed"; cls = l.side === "under" ? "hit" : "miss"; }
    const w = Math.min(100, (cur / (need + 0.5)) * 100);
    const badgeStyle = cls === "hit" ? "color:var(--over);border-color:var(--over)" : cls === "miss" ? "color:var(--under);border-color:var(--under)" : "";
    return `<div class="card"><div class="row"><div style="min-width:0"><b>${esc(l.player)}</b><div class="note">${l.side === "over" ? "Over" : "Under"} ${l.line} ${esc(l.stat)}${l.gameStatus ? " · " + esc(l.gameStatus) : ""}</div></div><span class="badge" style="${badgeStyle}">${st}</span></div>
      <div class="bar"><i class="${cls}" style="width:${w}%"></i></div>
      <div class="row" style="margin-top:10px"><span class="note">${l.auto ? "From ESPN" : "Current"}</span><div class="stepper"><button data-dec="${i}" aria-label="Minus one">−</button><span class="num">${cur}</span><button data-inc="${i}" aria-label="Plus one">+</button></div></div></div>`;
  }).join("") + '<button class="btn ghost" id="resetLive">Reset all to 0</button>';
}
function boxRow(sum, athleteId) {
  for (const team of (sum.boxscore && sum.boxscore.players) || []) {
    for (const s of team.statistics || []) {
      const labels = s.labels || s.names || [];
      for (const a of s.athletes || []) {
        if (String(a.athlete && a.athlete.id) === String(athleteId)) {
          const row = {}; labels.forEach((lab, i) => { row[lab] = (a.stats || [])[i]; }); return row;
        }
      }
    }
  }
  return null;
}
async function liveTick() {
  const legs = S.slip.map(l => ({ l, p: S.props.find(p => p.id === l.id) })).filter(x => x.p && x.p.athleteId && AUTO[x.l.stat]);
  const leagues = [...new Set(legs.map(x => x.p.league))];
  if (!leagues.length) leagues.push("nba");
  const allGames = [];
  try {
    for (const lg of leagues) {
      const sb = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[lg].sport}/${lg}/scoreboard`);
      for (const ev of sb.events || []) {
        const comp = (ev.competitions || [])[0] || {};
        const state = (ev.status && ev.status.type && ev.status.type.state) || "pre";
        allGames.push({
          id: ev.id, league: lg, state,
          status: (ev.status && ev.status.type && ev.status.type.shortDetail) || "",
          teams: (comp.competitors || []).slice().sort((a, b) => (a.homeAway === "away" ? -1 : 1)).map(c => ({ abbr: (c.team && c.team.abbreviation) || "", score: state === "pre" ? "" : c.score || "0" })),
        });
      }
    }
    games = allGames; renderGames();
    const active = games.filter(g => g.state !== "pre");
    const found = {};
    for (const g of active) {
      if (!legs.length) break;
      let sum = summaryCache[g.id];
      if (!sum) {
        sum = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[g.league].sport}/${g.league}/summary?event=${g.id}`);
        if (g.state === "post") summaryCache[g.id] = sum;
      }
      for (const { l, p } of legs) {
        if (found[l.id + l.side]) continue;
        const row = boxRow(sum, p.athleteId);
        if (row) {
          const v = AUTO[l.stat](row);
          if (v != null) { l.cur = v; l.auto = true; l.gameStatus = g.status; l.final = g.state === "post"; found[l.id + l.side] = true; }
        }
      }
    }
    save(); renderLive();
    $("#liveNote").textContent = `Checked ESPN at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. ESPN players update every 30 seconds. For anyone else, tap + as the game goes.`;
  } catch (e) {
    $("#liveNote").textContent = "Couldn't reach ESPN right now. Tap + and − to track by hand.";
  }
}
function startLive() { stopLive(); liveTick(); liveTimer = setInterval(() => { if (!document.hidden) liveTick(); }, 30000); }
function stopLive() { if (liveTimer) clearInterval(liveTimer); liveTimer = null; }

/* ---------- Calculator ---------- */
function calc() {
  const o = parseOdds($("#cOdds").value);
  $("#cOddsOut").innerHTML = isNaN(o) ? "Enter odds like -110 or +150." : `Decimal <b>${dec(o).toFixed(3)}</b> · Implied <b>${pct(imp(o))}</b><br>$10 wins <b>${money(10 * (dec(o) - 1))}</b>`;
  const a = parseOdds($("#vOver").value), b = parseOdds($("#vUnder").value);
  if (isNaN(a) || isNaN(b)) $("#vOut").textContent = "Enter both sides, like -120 and -105.";
  else { const pa = imp(a), pb = imp(b), t = pa + pb; $("#vOut").innerHTML = `Fair Over <b>${pct(pa / t)}</b> (${fmtO(toAm(t / pa))}) · Fair Under <b>${pct(pb / t)}</b> (${fmtO(toAm(t / pb))})<br>Book's hold <b>${pct(t - 1)}</b>`; }
  const e = parseOdds($("#eOdds").value), p = parseFloat($("#eProb").value) / 100, st = parseFloat($("#eStake").value), bk = parseFloat($("#eBank").value);
  if (isNaN(e) || !(p > 0 && p < 1)) $("#eOut").textContent = "Enter odds and a win chance between 1 and 99.";
  else {
    const d = dec(e), ev = p * (d - 1) - (1 - p), k = Math.max(0, ((d - 1) * p - (1 - p)) / (d - 1));
    $("#eOut").innerHTML = `EV per $1 <b class="${ev > 0 ? "hot" : "cold"}">${ev >= 0 ? "+" : ""}${ev.toFixed(3)}</b>${isFinite(st) ? ` · On ${money(st)}: <b class="${ev > 0 ? "hot" : "cold"}">${ev >= 0 ? "+" : "−"}${money(Math.abs(ev * st))}</b>` : ""}<br>Break-even <b>${pct(1 / d)}</b> · Kelly <b>${pct(k)}</b>${isFinite(bk) ? ` (${money(k * bk)}; half Kelly ${money((k * bk) / 2)})` : ""}`;
  }
}

/* ---------- Navigation ---------- */
function show(v) {
  S.view = v; save();
  document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-selected", b.dataset.v === v));
  ["board", "slip", "live", "calc"].forEach(x => ($("#v-" + x).hidden = x !== v));
  $("#hdrSub").textContent = { board: "Player props", slip: "Your picks", live: "In-game", calc: "Tools" }[v];
  render(); window.scrollTo(0, 0);
  if (v === "live") startLive(); else stopLive();
}
function render() { renderBoard(); renderSlip(); renderLive(); calc(); }

document.querySelector("nav").addEventListener("click", e => { const b = e.target.closest("button"); if (b) show(b.dataset.v); });
$("#statChips").addEventListener("click", e => { const b = e.target.closest("[data-f]"); if (b) { S.filter = b.dataset.f; save(); renderBoard(); } });
$("#syncBtn").addEventListener("click", () => syncStats(true));
$("#board").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const id = b.closest("[data-id]").dataset.id, p = S.props.find(x => x.id === id);
  if (b.dataset.act === "toggle") { S.open = S.open === id ? null : id; save(); renderBoard(); }
  else if (b.dataset.act === "edit") openDlg(p);
  else {
    const side = b.dataset.side, i = S.slip.findIndex(l => l.id === id);
    if (i > -1 && S.slip[i].side === side) { S.slip.splice(i, 1); toast("Removed from slip"); }
    else {
      const leg = { id, player: p.player, stat: p.stat, line: p.line, side, odds: side === "over" ? p.over : p.under, cur: 0 };
      if (i > -1) S.slip[i] = leg; else S.slip.push(leg);
      toast(`Added ${side === "over" ? "Over" : "Under"} ${p.line}`);
    }
    save(); renderBoard(); renderSlip(); renderLive();
  }
});
$("#slipCard").addEventListener("click", e => {
  const rm = e.target.closest("[data-rm]"); if (rm) { S.slip.splice(+rm.dataset.rm, 1); save(); render(); return; }
  const m = e.target.closest("[data-mode]"); if (m) { S.mode = m.dataset.mode; save(); renderSlip(); return; }
  if (e.target.id === "clearSlip") { S.slip = []; save(); render(); toast("Slip cleared"); }
  if (e.target.id === "toLive") show("live");
});
$("#slipCard").addEventListener("change", e => { if (e.target.id === "stake") { S.stake = parseFloat(e.target.value) || 0; save(); renderSlip(); } });
$("#live").addEventListener("click", e => {
  const inc = e.target.closest("[data-inc]"), dc = e.target.closest("[data-dec]");
  if (inc) S.slip[+inc.dataset.inc].cur = (S.slip[+inc.dataset.inc].cur || 0) + 1;
  else if (dc) S.slip[+dc.dataset.dec].cur = Math.max(0, (S.slip[+dc.dataset.dec].cur || 0) - 1);
  else if (e.target.id === "resetLive") S.slip.forEach(l => { l.cur = 0; l.final = false; l.auto = false; l.gameStatus = ""; });
  else return;
  save(); renderLive();
});
["#cOdds", "#vOver", "#vUnder", "#eOdds", "#eProb", "#eStake", "#eBank"].forEach(s => $(s).addEventListener("input", calc));

/* ---------- Add / edit dialog ---------- */
const dlg = $("#propDlg");
let editing = null, link = null;
$("#fStat").innerHTML = STATS.map(s => `<option>${s}</option>`).join("");
function setLinkNote() {
  $("#linkNote").textContent = link ? `Linked to ESPN (${LEAGUES[link.league].name}).${AUTO[$("#fStat").value] ? "" : " This stat isn't filled in automatically, so type the games in."}` : "";
}
function openDlg(p) {
  editing = p || null;
  link = p && p.athleteId ? { athleteId: p.athleteId, league: p.league } : null;
  $("#dlgTitle").textContent = p ? "Edit prop" : "Add a prop";
  $("#dlgDelete").hidden = !p;
  $("#results").innerHTML = "";
  $("#fPlayer").value = p ? p.player : ""; $("#fTeam").value = p ? p.team : ""; $("#fOpp").value = p ? p.opp : "";
  $("#fStat").value = p ? p.stat : "PTS"; $("#fLine").value = p ? p.line : "";
  $("#fOver").value = p ? fmtO(p.over) : "-115"; $("#fUnder").value = p ? fmtO(p.under) : "-105";
  $("#fLog").value = p ? p.log.join(", ") : "";
  setLinkNote();
  dlg.showModal();
}
async function fillLog() {
  if (!link || !AUTO[$("#fStat").value]) { setLinkNote(); return; }
  $("#linkNote").textContent = "Getting last 10 games from ESPN…";
  try {
    const l = await lastTen(link.athleteId, link.league, $("#fStat").value);
    if (l && l.length) { $("#fLog").value = l.join(", "); $("#linkNote").textContent = `Linked to ESPN (${LEAGUES[link.league].name}). Last ${l.length} games filled in.`; }
    else $("#linkNote").textContent = "ESPN has no games for this player yet. Type them in if you have them.";
  } catch (e) { $("#linkNote").textContent = "Couldn't reach ESPN. You can type the games in."; }
}
async function doSearch() {
  const q = $("#fPlayer").value.trim();
  if (q.length < 2) { toast("Type at least 2 letters of the name"); return; }
  $("#results").innerHTML = '<p class="note">Searching ESPN…</p>';
  try {
    const res = await espnSearch(q);
    $("#results").innerHTML = res.length ? res.slice(0, 6).map((r, i) => `<button type="button" data-r="${i}">${esc(r.name)}<small>${esc(r.sub)} · ${LEAGUES[r.league].name}</small></button>`).join("")
      : '<p class="note">No NBA or WNBA players found by that name. Check the spelling, or fill the form in by hand.</p>';
    $("#results").onclick = e => {
      const b = e.target.closest("[data-r]"); if (!b) return;
      const r = res[+b.dataset.r];
      link = { athleteId: r.id, league: r.league };
      $("#fPlayer").value = r.name;
      $("#results").innerHTML = "";
      fillLog();
    };
  } catch (e) { $("#results").innerHTML = '<p class="note">Couldn\'t reach ESPN search. Fill the form in by hand for now.</p>'; }
}
$("#findBtn").addEventListener("click", doSearch);
$("#fPlayer").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doSearch(); } });
$("#fStat").addEventListener("change", fillLog);
$("#addPropBtn").addEventListener("click", () => openDlg(null));
$("#dlgCancel").addEventListener("click", () => dlg.close());
$("#dlgDelete").addEventListener("click", () => {
  if (!editing) return;
  S.props = S.props.filter(p => p.id !== editing.id); S.slip = S.slip.filter(l => l.id !== editing.id);
  save(); dlg.close(); render(); toast("Prop deleted");
});
$("#propForm").addEventListener("submit", e => {
  e.preventDefault();
  const line = parseFloat($("#fLine").value), ov = parseOdds($("#fOver").value), un = parseOdds($("#fUnder").value);
  if (!$("#fPlayer").value.trim() || isNaN(line)) { toast("Add a player and a line"); return; }
  if (isNaN(ov) || isNaN(un)) { toast("Odds look like -110 or +150"); return; }
  const log = $("#fLog").value.split(/[,\s]+/).map(Number).filter(n => isFinite(n) && n >= 0).slice(-20);
  const data = { player: $("#fPlayer").value.trim(), team: $("#fTeam").value.trim(), opp: $("#fOpp").value.trim(), stat: $("#fStat").value, line, over: ov, under: un, log,
    athleteId: link ? link.athleteId : null, league: link ? link.league : null };
  if (editing) {
    Object.assign(editing, data);
    S.slip.forEach(l => { if (l.id === editing.id) { l.player = data.player; l.stat = data.stat; l.line = line; l.odds = l.side === "over" ? ov : un; } });
  } else { S.props.unshift({ ...data, id: "p" + Date.now() }); S.filter = "All"; }
  save(); dlg.close(); render(); toast(editing ? "Prop updated" : "Prop added");
  if (!editing) window.scrollTo({ top: 0, behavior: "smooth" });
});

/* ---------- Start ---------- */
show(S.view || "board");
if (S.lastSync) $("#syncNote").textContent = `Updated ${new Date(S.lastSync).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
if (Date.now() - (S.lastSync || 0) > 3 * 3600 * 1000) syncStats(false);
