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
const latest = kwOn(D).filter(r => num(r.total_hits) > 0);
const latestBy = Object.fromEntries(latest.map(r => [r.keyword, r]));
// sponsored slot over every run of the window (full + 13:07/17:07 checks): brand seen there most often, '*' if mostly discounted, "k/n"
const slotOf = (all, s) => { const [b, k] = mode(all.map(x => x[`ad${s}_brand`])); const pr = b ? all.filter(x => x[`ad${s}_brand`] === b && x[`ad${s}_promo`]).length : 0;
  return [b || '', b && pr * 2 >= k ? '*' : '', b ? `${k}/${all.length}` : '']; };
// kr – brand ranking per query: best organic position per brand in each run (rows grouped by query so gzip packs them well).
//      Queries measured 3x a day: the last 45 runs; the rest: the last 14 full runs.
//      From brand_best (all brands, recorded since 3 Nov); older runs: Prazdroj brands only, from the positions history.
const brandOfPid = Object.fromEntries(cfg.skuList.map(([p, b]) => [String(p), b]));
const krRuns = new Set(WF.slice(-14)), krAll = new Set(WA.slice(-45));     // last 14 full runs; 3x-a-day queries: last 45 runs
const posRunBy = {};
for (const r of posEvery) if (r.org_pos !== '' && WA.includes(runId(r))) {
  const o = num(r.org_pos), b = r.brand || brandOfPid[r.pid] || ''; if (!b) continue;
  const m = (posRunBy[runId(r)] ??= {})[r.keyword] ??= {}; if (m[b] == null || o < m[b]) m[b] = o;
}
const krRows = {};
for (const r of kwEvery) {
  const id = runId(r); if (!(r.key === '1' ? krAll.has(id) : r.mode === 'full' && krRuns.has(id))) continue;
  const list = r.brand_best ? r.brand_best.split('|').filter(Boolean) : Object.entries(posRunBy[id]?.[r.keyword] || {}).sort((a, b) => a[1] - b[1]).map(([b, o]) => `${b}:${o}`);
  const keep = list;
  if (keep.length) (krRows[r.keyword] ??= []).push([id, keep]);
}
// compact: krr = list of runs once; kr = one row per query: brands, then per run "runIndex:pos,pos,…" (aligned with the brands, '' = not in top 50)
const krIds = [...new Set(Object.values(krRows).flatMap(rs => rs.map(x => x[0])))].sort(), krIx = Object.fromEntries(krIds.map((id, i) => [id, i]));
zl.push(['krr', D, krIds.join('|')]);
for (const [k, rs] of Object.entries(krRows)) {
  // keep the brands the chart draws: up to 4 Prazdroj + 4 competitors with the best average position
  const acc = {}; rs.forEach(([, l]) => l.forEach(x => { const i = x.lastIndexOf(':'), b = x.slice(0, i); (acc[b] ??= []).push(Number(x.slice(i + 1))); }));
  const byAvg = Object.keys(acc).filter(b => b !== 'bez značky').sort((a, b) => avg(acc[a]) - avg(acc[b]));
  const brands = [...byAvg.filter(isOwn).slice(0, 4), ...byAvg.filter(b => !isOwn(b)).slice(0, 4)];
  const ser = rs.map(([id, l]) => { const m = Object.fromEntries(l.map(x => [x.slice(0, x.lastIndexOf(':')), x.slice(x.lastIndexOf(':') + 1)]));
    return krIx[id] + ':' + brands.map(b => m[b] ?? '').join(',').replace(/,+$/, ''); });
  zl.push(['kr', D, k, brands.map(b => b.replace(/[|;:,]/g, ' ')).join('|'), ser.join(';')]);
}
// am / ap – ad monitoring over every full run of the window: which brands buy sponsored #1 / #4, on which searches, with which product.
//   am (per brand): avg number of generic searches with #1 and #4 per run, Prazdroj brand searches where it had a slot (count),
//                   average discount of the advertised products (%, no discount = 0), its most advertised product
//   ap (per brand, gzip): every search × slot it held: product shown there most often, runs seen / runs measured, max discount
const amB = {}, apK = {}, nKw = {};
for (const d of WF) for (const r of kwOn(d)) {
  nKw[r.keyword] = (nKw[r.keyword] || 0) + 1;
  for (const s of [1, 4]) {
    const b = r[`ad${s}_brand`]; if (!b) continue;
    const seg = segOf(r) === 'brand' ? 'b' : 'g', pid = r[`ad${s}_pid`], disc = discOfPromo(r[`ad${s}_promo`]);
    const x = amB[b] ??= { g1: 0, g4: 0, bq: new Set(), n: 0, disc: 0, prod: {} };
    if (seg === 'g') x[s === 1 ? 'g1' : 'g4']++; else if (!isOwn(b)) x.bq.add(r.keyword);
    x.n++; x.disc += disc && disc !== 'y' ? Number(disc) : 0;   // average discount: slots without a discount count as 0
    const pr = x.prod[pid] ??= { n: 0, name: r[`ad${s}_name`] || '' }; pr.n++;
    const k = `${b}|${r.keyword}|${s}`, y = apK[k] ??= { b, kw: r.keyword, seg, s, n: 0, dmax: 0, dn: 0, prod: {} };
    y.n++; if (disc) { y.dn++; y.dmax = Math.max(y.dmax, disc === 'y' ? 0 : Number(disc)); }
    (y.prod[pid] ??= { n: 0, name: r[`ad${s}_name`] || '' }).n++;
  }
}
const topProd = o => Object.values(o).sort((a, b) => b.n - a.n)[0] || { name: '' };
const amTop = Object.entries(amB).sort((a, b) => b[1].n - a[1].n).filter(([b], i) => i < 30 || isOwn(b));
amTop.forEach(([b, x]) => out.push(['am', D, b, isOwn(b) ? 1 : 0, r1(x.g1 / N), r1(x.g4 / N), x.bq.size, x.n ? Math.round(x.disc / x.n) : null, topProd(x.prod).name.trim().slice(0, 60)]));
const amSet = new Set(amTop.map(([b]) => b)), apNames = {}, apBy = {};
Object.values(apK).filter(y => amSet.has(y.b)).sort((a, b) => b.n - a.n).forEach(y => {
  const [pid, pr] = Object.entries(y.prod).sort((a, b) => b[1].n - a[1].n)[0]; apNames[pid] = pr.name.trim().slice(0, 60);
  (apBy[y.b] ??= []).push([y.kw.replace(/[~;]/g, ' '), y.seg, y.s, pid, `${y.n}/${nKw[y.kw]}`, y.dn ? (y.dmax || 'y') : ''].join('~'));
});
// compact: one ap row per brand ("search~g|b~slot~pid~seen/measured~maxDiscount;…"), product names once in apn
Object.entries(apBy).forEach(([b, l]) => zl.push(['ap', D, b, l.join(';')]));
Object.entries(apNames).forEach(([pid, n]) => zl.push(['apn', D, pid, n]));
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
// content optimisation (config contentGolive: [{date, pids}]): median organic position on assigned keywords over ALL full runs
// before that date (no date yet = every run so far) and after it
const contentOn = Object.fromEntries((cfg.contentGolive || []).flatMap(g => (g.pids || []).map(p => [String(p), g.date])));
const tAll = runs.map(id => [id.slice(0, 10), WF.includes(id) ? tW[WF.indexOf(id)] : skTop(id)]);
for (const pid of cfg.skuList.map(([p]) => String(p))) {
  const xs = tW.map(s => s[pid] || [0, 0, []]);
  const rd = x => x == null ? null : Math.round(x);
  const cd = contentOn[pid] || '', posAt = keep => tAll.filter(([d]) => keep(d)).flatMap(([, s]) => (s[pid] || [0, 0, []])[2]);
  out.push(['sk', D, pid, nCur[pid] || 0, rd(avg(xs.map(x => x[0]))), nNew[pid] || 0, rd(avg(xs.map(x => x[1]))),
    median(xs.flatMap(x => x[2])), controls.has(pid) ? 1 : 0,
    median(posAt(d => !cd || d < cd)), cd ? median(posAt(d => d >= cd)) : null, cd]);
}
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
  const adAll = (byKw[r.keyword] || []).filter(x => num(x.total_hits) > 0);
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
    pos, topStr, r1(avg(withTop.map(x => num(x.promo_top20)))), num(r.total_hits), all.length, nt, r.groups || '',
    ...slotOf(adAll, 1), ...slotOf(adAll, 4)]);
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
  const kRows = latest;
  const moves = kRows.map(r => {
    const before = (byKw[r.keyword] || []).filter(x => runId(x) < D && num(x.total_hits) > 0).map(org);
    const b = avg(before); return [r.keyword, b == null || org(r) == null ? null : org(r) - b, before.length, num(r.total_hits)];
  }).filter(([, d, n, h]) => d != null && n >= 2 && Math.abs(d) >= 0.1 && h <= 1000).sort((a, b) => b[3] - a[3]);   // > 1000 results = broad non-beer query
  moves.slice(0, 3).forEach(([k, d, n]) => ins.push(['ins', D, d > 0 ? 'up' : 'down',
    `„${k}“: share of search ${pct(org(latestBy[k]))}, o ${Math.round(Math.abs(d) * 100)} b. ${d > 0 ? 'nad' : 'pod'} průměrem.`]));
  const adCh = [];
  for (const r of kRows) for (const s of ['1', '4']) {
    const b = r[`ad${s}_brand`], hold = r[`ad${s}_hold`];
    const firm = !hold || /^(\d+)\/\1$/.test(hold) || Number(hold.split('/')[0]) >= 2;
    if (!b || isOwn(b) || !firm) continue;
    const before = (byKw[r.keyword] || []).filter(x => runId(x) < D), had = before.filter(x => x[`ad${s}_brand`] === b).length;
    if (before.length >= 2 && had * 3 <= before.length && num(r.total_hits) <= 1000) adCh.push([num(r.total_hits), ['ins', D, 'watch',
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
    ins.push(['ins', D, 'watch', `Nová reklama konkurence na brandovém dotazu: ${b} na sponzorované pozici ${s} u „${k}“${p ? ' (se slevou)' : ''}.`]));
}
zl.filter(x => x[0] === 'kq' && x[6] != null && x[11] >= 50 && x[11] <= 1000 && segOf({ keyword: x[2] }) === 'generic').sort((a, b) => a[6] - b[6] || b[11] - a[11]).slice(0, 2)
  .forEach(x => ins.push(['ins', D, 'gap', `Slabý generický dotaz: „${x[2]}“ (${x[11]} výsledků) – share of search ${pct(x[6])}.`]));
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
