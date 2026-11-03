// Daily dashboard feed for the Prazdroj Search Monitor (POS Media). Node 22, no dependencies.
// Runs after a full tracker run. Reads history/*.csv + config, writes out/part_9NN_dash.csv (every run in the window is aggregated):
// one JSON array per line, first cell = table id. The dashboard reads these e-mails via MS365.
import fs from 'node:fs';
import zlib from 'node:zlib';

const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG || 'config/prazdroj.json', 'utf8'));
const own = new Set(cfg.ownBrands.map(b => b.toLowerCase()));
const isOwn = b => own.has(String(b || '').toLowerCase());
const controls = new Set((cfg.controls?.pids || []).map(String));

function parse(t) {
  const rows = []; let r = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { r.push(f); f = ''; }
    else if (c === '\n') { r.push(f); rows.push(r); r = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || r.length) { r.push(f); rows.push(r); }
  const [h, ...d] = rows;
  // older rows may lack columns added later (ad1_hold, ad4_hold): keep them, missing cells = ''
  return d.filter(x => x.length >= 10).map(x => Object.fromEntries(h.map((k, i) => [k, x[i] ?? ''])));
}
const read = f => fs.existsSync(f) ? parse(fs.readFileSync(f, 'utf8')) : [];
const kwEvery = read(`history/${cfg.client}_keywords.csv`);
const posEvery = read(`history/${cfg.client}_positions.csv`);
const kwAll = kwEvery.filter(r => r.mode === 'full');
if (!kwAll.length) { console.log('dash: no full runs yet'); process.exit(0); }

// every full run is its own point (date + time), compared with the full run before it
const runId = r => `${r.date} ${r.time}`;
const runs = [...new Set(kwAll.map(runId))].sort();
const D = runs.at(-1), P = runs.length > 1 ? runs.at(-2) : null, PP = runs.length > 2 ? runs.at(-3) : null;
const kwOn = id => kwAll.filter(r => runId(r) === id);
const posOn = id => posEvery.filter(r => r.mode === 'full' && runId(r) === id);
const num = x => (x === '' || x == null ? null : Number(x));
const r3 = x => x == null ? null : Math.round(x * 1000) / 1000;
const avg = a => { const b = a.filter(x => x != null); return b.length ? b.reduce((s, v) => s + v, 0) / b.length : null; };
const median = a => { const b = a.filter(x => x != null).sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : null; };
const brandRx = /birell|kozel|pilsner|urquell|radegast|gambrinus|frisco|elektr|proud|primus|excelent|klasik|peroni/i;
const segOf = r => brandRx.test(r.keyword) ? 'brand' : r.key === '1' ? 'key' : 'generic';
const org = r => num(r.prazdroj_sos_org_top20);
const conquestOf = rows => rows.filter(r => segOf(r) === 'brand').flatMap(r =>
  [['1', r.ad1_brand, r.ad1_promo], ['4', r.ad4_brand, r.ad4_promo]].filter(([, b]) => b && !isOwn(b)).map(([s, b, p]) => [r.keyword, s, b, p]));

const skuStats = id => {
  const s = {};
  for (const r of posOn(id)) {
    const x = s[r.pid] ??= { seen: 0, found: 0, pos: [], top10: 0 };
    x.seen++; if (r.kw_status !== 'not linked') x.found++;
    const o = num(r.org_pos); if (o != null) { x.pos.push(o); if (o <= 10) x.top10++; }
  }
  return s;
};


// ── window: every run is used. Before a go-live date is logged = all runs so far; after it = all runs since go-live
//    (mixing pre and post would hide the effect – the before/after section compares the two periods).
const G = (cfg.golive || []).map(g => g.date).sort()[0] || null;
const inPeriod = id => !G || runs.every(r => r.slice(0, 10) < G) ? true : id.slice(0, 10) >= G;
const WF = runs.filter(inPeriod);                                         // full runs in the window
const WA = [...new Set(kwEvery.map(runId))].sort().filter(inPeriod);     // all runs (full + 13:07/17:07 checks)
const N = WF.length;
const r1 = x => x == null ? null : Math.round(x * 10) / 10;
const mode = a => { const c = {}; a.filter(Boolean).forEach(x => c[x] = (c[x] || 0) + 1); return Object.entries(c).sort((x, y) => y[1] - x[1])[0] || [null, 0]; };
const discOfPromo = p => { if (!p) return ''; const m = [...String(p).matchAll(/-(\d+)%/g)].map(x => Number(x[1])); return m.length && Math.max(...m) > 0 ? String(Math.max(...m)) : 'y'; };
const byKw = {};                                    // keyword -> rows over all runs in the window (any mode)
for (const r of kwEvery) if (WA.includes(runId(r))) (byKw[r.keyword] ??= []).push(r);
const fullOf = rows => rows.filter(r => r.mode === 'full');

const out = [], zl = [];                            // zl = rows sent gzip+base64 (large tables)
// tr – one row per full run, all runs (trend; tiles average them in the page)
for (const d of runs) {
  const rows = kwOn(d).filter(r => num(r.total_hits) > 0);
  const seg = k => r3(avg(rows.filter(r => segOf(r) === k).map(org)));
  const a1 = rows.filter(r => r.ad1_brand), a4 = rows.filter(r => r.ad4_brand);
  const st = controls.size ? skuStats(d) : {};
  const grp = inCtl => r3(avg(Object.entries(st).filter(([pid]) => controls.has(pid) === inCtl).map(([, x]) => median(x.pos))));
  zl.push(['tr', d.slice(0, 10), d.slice(11), rows.length, seg('key'), seg('generic'), seg('brand'),
    rows.filter(r => segOf(r) === 'generic' && org(r) === 0).length,
    a1.filter(r => isOwn(r.ad1_brand)).length, a1.length, a4.filter(r => isOwn(r.ad4_brand)).length, a4.length,
    a1.filter(r => r.ad1_promo).length + a4.filter(r => r.ad4_promo).length, conquestOf(rows).length,
    controls.size ? grp(true) : null, controls.size ? grp(false) : null]);
}
// kt – key terms aggregated over every run in the window (full + 13:07/17:07 checks), plus the latest values
const latest = kwOn(D).filter(r => num(r.total_hits) > 0);
const latestBy = Object.fromEntries(latest.map(r => [r.keyword, r]));
for (const r of latest.filter(r => r.key === '1')) {
  const all = (byKw[r.keyword] || []).filter(x => num(x.total_hits) > 0), n = all.length;
  const slot = s => { const [b, k] = mode(all.map(x => x[`ad${s}_brand`])); const pr = b ? all.filter(x => x[`ad${s}_brand`] === b && x[`ad${s}_promo`]).length : 0;
    return [b || '', b && pr * 2 >= k ? '*' : '', b ? `${k}/${n}` : '']; };
  const bc = {};
  fullOf(all).forEach(x => (x.brands_top20 || '').split(' | ').forEach(y => { const m = y.match(/^(.*):(\d+)$/); if (m) bc[m[1]] = (bc[m[1]] || 0) + Number(m[2]); }));
  const nf = Math.max(1, fullOf(all).length);
  const top3 = Object.entries(bc).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([b, c]) => `${b}:${r1(c / nf)}`).join(' | ');
  out.push(['kt', D, r.keyword, num(r.total_hits), r3(avg(all.map(org))), median(all.map(x => num(x.prazdroj_best_org_pos))),
    ...slot(1), ...slot(4), top3, r.prazdroj_positions, org(r), num(r.prazdroj_best_org_pos), n]);
}
// kh – key-term history, every run in the window
for (const id of WA) for (const r of kwEvery.filter(r => runId(r) === id && r.key === '1'))
  zl.push(['kh', id, r.keyword, org(r), num(r.prazdroj_best_org_pos), r.ad1_brand, r.ad1_hold || '', r.ad4_brand, r.ad4_hold || '']);
// kr – ranking trend for key terms: best organic position per brand in every run of the window.
//      From brand_best (all brands, recorded since 3 Nov); older runs: Prazdroj brands only, from the positions history.
const brandOfPid = Object.fromEntries(cfg.skuList.map(([p, b]) => [String(p), b]));
for (const id of WA) {
  const posRun = {};
  for (const r of posEvery) if (runId(r) === id && r.org_pos !== '') {
    const o = num(r.org_pos), k = r.keyword, b = r.brand || brandOfPid[r.pid] || '';
    if (!b) continue;
    const m = posRun[k] ??= {}; if (m[b] == null || o < m[b]) m[b] = o;
  }
  for (const r of kwEvery.filter(x => runId(x) === id && x.key === '1')) {
    const bb = r.brand_best ? r.brand_best : Object.entries(posRun[r.keyword] || {}).map(([b, o]) => `${b}:${o}`).join('|');
    if (bb) zl.push(['kr', id, r.keyword, bb, r.brand_best ? 1 : 0]);
  }
}
// ad – sponsored slots by brand: average number of keywords per full run
const ab = {};
for (const d of WF) for (const r of kwOn(d)) for (const [s, b, p] of [[1, r.ad1_brand, r.ad1_promo], [4, r.ad4_brand, r.ad4_promo]]) if (b) {
  ab[b] ??= [0, 0, 0]; ab[b][s === 1 ? 0 : 1]++; if (p) ab[b][2]++;
}
Object.entries(ab).sort((a, b) => (b[1][0] + b[1][1]) - (a[1][0] + a[1][1])).slice(0, 25)
  .forEach(([b, [s1, s4, pr]]) => out.push(['ad', D, b, r1(s1 / N), r1(s4 / N), r1(pr / N), isOwn(b) ? 1 : 0]));
// br – brand presence on non-brand searches: averages per full run
const bp = {};
let nbRows = 0;
for (const d of WF) { const nb = kwOn(d).filter(r => num(r.total_hits) > 0 && segOf(r) !== 'brand'); nbRows += nb.length;
  for (const r of nb) for (const x of (r.brands_top20 || '').split(' | ')) { const m = x.match(/^(.*):(\d+)$/); if (!m) continue; bp[m[1]] ??= [0, 0]; bp[m[1]][0]++; bp[m[1]][1] += Number(m[2]); } }
Object.entries(bp).filter(([b]) => b !== 'bez značky').sort((a, b) => b[1][1] - a[1][1])
  .filter(([b], i) => i < 25 || isOwn(b))
  .forEach(([b, [kw, places]]) => out.push(['br', D, b, isOwn(b) ? 1 : 0, r1(kw / N), r3(places / Math.max(1, nbRows)), r1((ab[b]?.[0] || 0) / N), r1((ab[b]?.[1] || 0) / N)]));
// cq – competitor ads on Prazdroj brand searches, every full run: how many runs each (keyword, slot, brand) was seen
const cqc = {};
for (const d of WF) for (const [k, s, b, p] of conquestOf(kwOn(d))) { const key = [k, s, b].join('|'); (cqc[key] ??= { k, s, b, n: 0, p: '' }).n++; if (p) cqc[key].p = p; }
Object.values(cqc).sort((a, b) => b.n - a.n).slice(0, 60).forEach(x => out.push(['cq', D, x.k, x.s, x.b, x.p, `${x.n}/${N}`]));
// sk – SKUs, simple view: keywords in the backend vs new suggested keywords, and on how many of each the SKU is in the
//      organic top 20 (average over all full runs, whole numbers); typical organic position on its assigned keywords
const nCur = {}, nNew = {};
cfg.keywords.forEach(([k, g, c, p]) => { c.forEach(i => { const q = String(cfg.skuList[i][0]); nCur[q] = (nCur[q] || 0) + 1; });
  p.forEach(i => { const q = String(cfg.skuList[i][0]); nNew[q] = (nNew[q] || 0) + 1; }); });
const skTop = id => {               // pid -> [backend kw in top 20, new kw in top 20, organic positions on assigned kw]
  const s = {};
  for (const r of posOn(id)) {
    if (r.kw_status === 'not linked') continue;
    const x = s[r.pid] ??= [0, 0, []], o = num(r.org_pos);
    if (o == null) continue;
    x[2].push(o);
    if (o <= 20) x[r.kw_status === 'current' ? 0 : 1]++;
  }
  return s;
};
const tW = WF.map(skTop), sD = skuStats(D);
for (const pid of cfg.skuList.map(([p]) => String(p))) {
  const xs = tW.map(s => s[pid] || [0, 0, []]);
  const rd = x => x == null ? null : Math.round(x);
  out.push(['sk', D, pid, nCur[pid] || 0, rd(avg(xs.map(x => x[0]))), nNew[pid] || 0, rd(avg(xs.map(x => x[1]))),
    median(xs.flatMap(x => x[2])), controls.has(pid) ? 1 : 0]);
}
// gp – current backend keywords where no linked SKU showed in ANY full run of the window
const foundEver = {};
for (const d of WF) for (const r of kwOn(d)) if (num(r.linked_found) > 0) foundEver[r.keyword] = true;
latest.filter(r => /(^|\+)c(\+|$)/.test(r.groups) && num(r.linked_skus) > 0 && !foundEver[r.keyword])
  .slice(0, 60).forEach(r => out.push(['gp', D, r.keyword, num(r.linked_skus), num(r.total_hits), (r.brands_top20 || '').split(' | ')[0] || '', N]));
// ba – before / after go-live per SKU: before = average of ALL full runs before the first go-live date, after = average of ALL runs since
const preRuns = runs.filter(id => !G || id.slice(0, 10) < G), postRuns = G ? runs.filter(id => id.slice(0, 10) >= G) : [];
const assigned = {};
cfg.keywords.forEach(([k, g, c, p]) => {
  c.forEach(i => { const pid = String(cfg.skuList[i][0]); (assigned[pid] ??= { cur: 0, neu: 0 }).cur++; });
  p.forEach(i => { const pid = String(cfg.skuList[i][0]); (assigned[pid] ??= { cur: 0, neu: 0 }).neu++; });
});
const baStats = id => {
  const s = {};
  for (const r of posOn(id)) {
    if (r.kw_status === 'not linked') continue;
    const x = s[r.pid] ??= { neu: new Set(), cur: new Set(), pos: [] };
    (r.kw_status === 'current' ? x.cur : x.neu).add(r.keyword);
    const o = num(r.org_pos); if (o != null) x.pos.push(o);
  }
  return s;
};
const preS = preRuns.map(baStats), postS = postRuns.map(baStats);
for (const pid of cfg.skuList.map(([p]) => String(p))) {
  const a = assigned[pid] || { cur: 0, neu: 0 };
  const agg = S => S.length ? [r1(avg(S.map(s => s[pid]?.neu.size || 0))), median(S.flatMap(s => s[pid]?.pos || [])), r1(avg(S.map(s => s[pid]?.cur.size || 0)))] : [null, null, null];
  const [bNew, bMed, bCur] = agg(preS), [pNew, pMed, pCur] = agg(postS);
  out.push(['ba', D, pid, a.neu, bNew, pNew, bMed, pMed, a.cur, bCur, pCur]);
}
out.push(['bag', D, G || '', preRuns.length, postRuns.length]);
for (const g of cfg.golive || []) out.push(['gl', g.date, (g.keywords || []).length, (g.pids || []).length, g.note || '']);
out.push(['cfg', D, controls.size, (cfg.golive || []).length, cfg.baselineUntil || '', N, WF[0] || '', WA.length]);

// kq / pq / qs – every query aggregated over all full runs in the window
const idxOf = Object.fromEntries(cfg.skuList.map(([pid], i) => [String(pid), i]));
const liveOn = new Map();
for (const g of cfg.golive || []) for (const p of g.pids || []) for (const k of g.keywords || []) liveOn.set(`${p}|${k.toLowerCase()}`, g.date);
const posW = {};
for (const d of WF) for (const r of posOn(d)) ((posW[r.keyword] ??= {})[r.pid] ??= []).push(r);
const kwCfg = Object.fromEntries(cfg.keywords.map(([k, g, c, p, key]) => [k, { c, p, key }]));
const shown = new Set();
let slots = 0, slotsDisc = 0;
const ownDisc = [], ownFull = [];
for (const r of latest) {
  const c = kwCfg[r.keyword]; if (!c) continue;
  const all = fullOf(byKw[r.keyword] || []).filter(x => num(x.total_hits) > 0);
  const plan = c.p.map(i => { const d = liveOn.get(`${cfg.skuList[i][0]}|${r.keyword.toLowerCase()}`); return d ? `${i}@${d}` : String(i); });
  // own SKUs: median organic position over the runs it was found, runs found, runs discounted, latest discount
  const pos = Object.entries(posW[r.keyword] || {}).filter(([pid]) => idxOf[pid] != null).map(([pid, rs]) => {
    const found = rs.filter(x => x.org_pos !== '');
    found.forEach(x => (discOfPromo(x.promo) ? ownDisc : ownFull).push(num(x.org_pos)));
    if (!found.length) return null;
    const last = rs.find(x => runId(x) === D);
    return `${idxOf[pid]}:${median(found.map(x => num(x.org_pos)))}:${found.filter(x => discOfPromo(x.promo)).length}:${found.length}:${last ? discOfPromo(last.promo) : ''}`;
  }).filter(Boolean).join(' ');
  // what Rohlík shows: products in the top 5 most often across runs that recorded it
  const withTop = all.filter(x => x.top5), nt = withTop.length, tc = {};
  withTop.forEach(x => x.top5.split(' ').filter(Boolean).forEach((y, k) => {
    const [pid, a, d] = y.split(':'); const t = tc[pid] ??= { n: 0, pos: 0, ad: 0, dn: 0, dmax: 0 };
    t.n++; t.pos += k + 1; if (a === 'a') t.ad++; slots++;
    if (d) { t.dn++; slotsDisc++; t.dmax = Math.max(t.dmax, d === 'y' ? 0 : Number(d)); }
  }));
  const top = Object.entries(tc).sort((a, b) => b[1].n - a[1].n || a[1].pos / a[1].n - b[1].pos / b[1].n).slice(0, 5)
    .sort((a, b) => a[1].pos / a[1].n - b[1].pos / b[1].n);
  top.forEach(([pid]) => { if (idxOf[pid] == null) shown.add(pid); });
  const topStr = top.map(([pid, t]) => `${pid}:${t.ad * 2 > t.n ? 'a' : 'o'}:${t.dn ? (t.dmax || 'y') : ''}:${t.n}:${r1(t.pos / t.n)}:${t.dn}`).join(' ');
  zl.push(['kq', D, r.keyword, c.key ? 1 : 0, c.c.join(' '), plan.join(' '), r3(avg(all.map(org))), median(all.map(x => num(x.prazdroj_best_org_pos))),
    pos, topStr, r1(avg(withTop.map(x => num(x.promo_top20)))), num(r.total_hits), all.length, nt, r.groups || '']);
}
const PROD = `history/${cfg.client}_products.json`;
const prod = fs.existsSync(PROD) ? JSON.parse(fs.readFileSync(PROD, 'utf8')) : {};
for (const pid of shown) zl.push(['pq', D, pid, prod[pid]?.[0] || '', (prod[pid]?.[1] || '').slice(0, 40)]);
// sq – SKU view: every keyword assigned to each SKU (backend or suggested) with its organic position in the last 14 full runs
//      (empty = not in top 100) and a reference position: median before go-live, or median of the first 3 runs if no go-live yet
const SQ = runs.slice(-14);
zl.push(['sqr', D, SQ.join('|'), G || '']);
// a SKU shown as a sponsored product is not listed organically at the same time (Rohlík de-duplicates):
// record it as "a<position incl. ads>" so it is not mistaken for a lost keyword
const posByRun = SQ.map(id => { const m = {}; for (const r of posOn(id)) {
  if (r.org_pos !== '') m[r.pid + '|' + r.keyword] = num(r.org_pos);
  else if (r.sponsored === '1' && r.pos_incl_ads !== '') m[r.pid + '|' + r.keyword] = 'a' + num(r.pos_incl_ads);
} return m; });
const preMed = {};
if (G) { for (const id of preRuns) for (const r of posOn(id)) if (r.org_pos !== '') (preMed[r.pid + '|' + r.keyword] ??= []).push(num(r.org_pos)); }
const firstRuns = runs.slice(0, 3).map(id => { const m = {}; for (const r of posOn(id)) if (r.org_pos !== '') m[r.pid + '|' + r.keyword] = num(r.org_pos); return m; });
for (const [k, g, c, p] of cfg.keywords) for (const [list, role] of [[c, 'c'], [p, 'p']]) for (const i of list) {
  const pid = String(cfg.skuList[i][0]), key = pid + '|' + k;
  const ser = posByRun.map(m => m[key] ?? '').join(',');
  const ref = G ? median(preMed[key] || []) : median(firstRuns.map(m => m[key]).filter(x => x != null));
  zl.push(['sq', D, i, k, role, ser, ref]);
}
const mD = median(ownDisc), mF = median(ownFull);
out.push(['qs', D, slots, slotsDisc, mD, mF, ownDisc.length, ownFull.length]);

// ins – notes: the latest full run against the average of ALL earlier runs in the window
const ins = [];
const pct = x => Math.round(x * 100) + ' %';
const prior = WF.filter(id => id < D), NP = prior.length;
if (NP) {
  const kRows = latest.filter(r => r.key === '1');
  const moves = kRows.map(r => {
    const before = (byKw[r.keyword] || []).filter(x => runId(x) < D && num(x.total_hits) > 0).map(org);
    const b = avg(before); return [r.keyword, b == null || org(r) == null ? null : org(r) - b, before.length, num(r.total_hits)];
  }).filter(([, d, n]) => d != null && n >= 2 && Math.abs(d) >= 0.1).sort((a, b) => b[3] - a[3]);
  moves.slice(0, 3).forEach(([k, d, n]) => ins.push(['ins', D, d > 0 ? 'up' : 'down',
    `„${k}“: share of search ${pct(org(latestBy[k]))}, o ${Math.round(Math.abs(d) * 100)} b. ${d > 0 ? 'nad' : 'pod'} průměrem.`]));
  const adCh = [];
  for (const r of kRows) for (const s of ['1', '4']) {
    const b = r[`ad${s}_brand`], hold = r[`ad${s}_hold`];
    const firm = !hold || /^(\d+)\/\1$/.test(hold) || Number(hold.split('/')[0]) >= 2;
    if (!b || isOwn(b) || !firm) continue;
    const before = (byKw[r.keyword] || []).filter(x => runId(x) < D), had = before.filter(x => x[`ad${s}_brand`] === b).length;
    if (before.length >= 2 && had * 3 <= before.length) adCh.push([num(r.total_hits), ['ins', D, 'watch',
      `„${r.keyword}“: ${b} má nově sponzorovanou pozici ${s}${r[`ad${s}_promo`] ? ' (se slevou)' : ''}; předtím jen ${had}× z ${before.length} měření.`]]);
  }
  adCh.sort((a, b) => b[0] - a[0]).slice(0, 3).forEach(([, x]) => ins.push(x));
  const avgSeen = pid => avg(prior.map(id => skuStats(id)[pid]?.seen || 0));
  const seenAvg = Object.fromEntries(cfg.skuList.map(([p]) => [String(p), avgSeen(String(p))]));
  cfg.skuList.map(([pid, br]) => [String(pid), br]).map(([pid, br]) => [pid, br, (sD[pid]?.seen || 0) - seenAvg[pid]])
    .filter(x => x[2] <= -3).sort((a, b) => a[2] - b[2]).slice(0, 2)
    .forEach(([pid, br, d]) => ins.push(['ins', D, 'down', `${br} SKU ${pid} se zobrazuje na ${sD[pid]?.seen || 0} dotazech, o ${Math.round(-d)} méně než průměr.`]));
  const seenCq = new Set(prior.flatMap(id => conquestOf(kwOn(id)).map(x => x.slice(0, 3).join('|'))));
  conquestOf(latest).filter(x => !seenCq.has(x.slice(0, 3).join('|'))).slice(0, 2).forEach(([k, s, b, p]) =>
    ins.push(['ins', D, 'watch', `Nový conquesting: ${b} na sponzorované pozici ${s} u „${k}“${p ? ' (se slevou)' : ''}.`]));
}
out.filter(x => x[0] === 'kt' && x[4] != null && x[3] >= 20).sort((a, b) => a[4] - b[4]).slice(0, 2)
  .forEach(x => ins.push(['ins', D, 'gap', `Nejslabší z top 22 dotazů: „${x[2]}“ – share of search ${pct(x[4])}.`]));
const trW = zl.filter(x => x[0] === 'tr' && WF.includes(`${x[1]} ${x[2]}`));
if (trW.length) { const s = i => trW.reduce((a, x) => a + (x[i] || 0), 0);
  ins.push(['ins', D, 'info', `Sponzorované pozice: Prazdroj má pozici 1 průměrně na ${Math.round(s(8) / trW.length)} z ${Math.round(s(9) / trW.length)} dotazů a pozici 4 na ${Math.round(s(10) / trW.length)} z ${Math.round(s(11) / trW.length)}. ${Math.round(s(12) / Math.max(1, s(9) + s(11)) * 100)} % sponzorovaných produktů je ve slevě.`]); }
if (slots && ownDisc.length >= 5 && ownFull.length >= 5) ins.push(['ins', D, 'info',
  `Slevy: ${Math.round(slotsDisc / slots * 100)} % produktů v top 5 je ve slevě. Medián organické pozice SKU Prazdroje: ve slevě ${mD}, bez slevy ${mF}.`]);
out.push(...ins.slice(0, 12));

// write parts: ≤ 9,000 chars each; small tables as JSON lines, large ones gzip+base64 in "~NNNN" lines
const lines = out.map(x => JSON.stringify(x));
if (zl.length) {
  const b64 = zlib.gzipSync(zl.map(x => JSON.stringify(x)).join('\n'), { level: 9 }).toString('base64');
  for (let i = 0, n = 0; i < b64.length; i += 120, n++) lines.push(`~${String(n).padStart(4, '0')} ${b64.slice(i, i + 120)}`);
}
const parts = []; let cur = [];
for (const l of lines) { if (cur.join('\n').length + l.length > 9000) { parts.push(cur); cur = []; } cur.push(l); }
if (cur.length) parts.push(cur);
fs.mkdirSync('out', { recursive: true });
parts.forEach((p, i) => fs.writeFileSync(`out/part_${900 + i}_dash.csv`,
  `# ${cfg.client} ${D} mode=full dash ${i + 1}/${parts.length} (dash)\n\`\`\`\n${p.join('\n')}\n\`\`\`\n# end\n`));
console.log(`dash: ${D}, window ${N} full / ${WA.length} all runs: ${lines.length} lines, ${parts.length} part(s)`);
