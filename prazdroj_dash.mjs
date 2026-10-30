// Daily dashboard feed for the Prazdroj Search Monitor (POS Media). Node 22, no dependencies.
// Runs after a full tracker run. Reads history/*.csv + config, writes out/part_9N_dash.csv:
// one JSON array per line, first cell = table id. The dashboard reads these e-mails via MS365.
import fs from 'node:fs';

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

const out = [];
// tr – one row per full run (last 60): organic share by segment, ad slots, control vs treated SKU positions
for (const d of runs.slice(-60)) {
  const rows = kwOn(d).filter(r => num(r.total_hits) > 0);
  const seg = k => r3(avg(rows.filter(r => segOf(r) === k).map(org)));
  const a1 = rows.filter(r => r.ad1_brand), a4 = rows.filter(r => r.ad4_brand);
  const st = controls.size ? skuStats(d) : {};
  const grp = inCtl => r3(avg(Object.entries(st).filter(([pid]) => controls.has(pid) === inCtl).map(([, x]) => median(x.pos))));
  out.push(['tr', d.slice(0, 10), d.slice(11), rows.length, seg('key'), seg('generic'), seg('brand'),
    rows.filter(r => segOf(r) === 'generic' && org(r) === 0).length,
    a1.filter(r => isOwn(r.ad1_brand)).length, a1.length, a4.filter(r => isOwn(r.ad4_brand)).length, a4.length,
    a1.filter(r => r.ad1_promo).length + a4.filter(r => r.ad4_promo).length, conquestOf(rows).length,
    controls.size ? grp(true) : null, controls.size ? grp(false) : null]);
}
// kt – key terms, latest and previous full run (latest carries Prazdroj SKU positions for the drill-down)
for (const d of [P, D].filter(Boolean)) for (const r of kwOn(d).filter(r => r.key === '1'))
  out.push(['kt', d, r.keyword, num(r.total_hits), org(r), num(r.prazdroj_best_org_pos), r.ad1_brand, r.ad1_promo, r.ad1_hold || '',
    r.ad4_brand, r.ad4_promo, r.ad4_hold || '', (r.brands_top20 || '').split(' | ').slice(0, 3).join(' | '), d === D ? r.prazdroj_positions : '']);
// kh – key-term history over the last 12 runs of any kind (full + 13:07/17:07 checks): ad rotation during the day
const allRuns = [...new Set(kwEvery.map(runId))].sort().slice(-12);
for (const id of allRuns) for (const r of kwEvery.filter(r => runId(r) === id && r.key === '1'))
  out.push(['kh', id, r.keyword, org(r), num(r.prazdroj_best_org_pos), r.ad1_brand, r.ad1_hold || '', r.ad4_brand, r.ad4_hold || '']);
// ad – sponsored slots by brand (latest)
const latest = kwOn(D).filter(r => num(r.total_hits) > 0);
const ab = {};
for (const r of latest) for (const [s, b, p] of [[1, r.ad1_brand, r.ad1_promo], [4, r.ad4_brand, r.ad4_promo]]) if (b) {
  ab[b] ??= [0, 0, 0]; ab[b][s === 1 ? 0 : 1]++; if (p) ab[b][2]++;
}
Object.entries(ab).sort((a, b) => (b[1][0] + b[1][1]) - (a[1][0] + a[1][1])).slice(0, 25)
  .forEach(([b, [s1, s4, pr]]) => out.push(['ad', D, b, s1, s4, pr, isOwn(b) ? 1 : 0]));
// br – brand presence on non-brand searches (latest): keywords where the brand is in the top 20, average places held
const nonBrand = latest.filter(r => segOf(r) !== 'brand');
const bp = {};
for (const r of nonBrand) for (const x of (r.brands_top20 || '').split(' | ')) {
  const m = x.match(/^(.*):(\d+)$/); if (!m) continue;
  bp[m[1]] ??= [0, 0]; bp[m[1]][0]++; bp[m[1]][1] += Number(m[2]);
}
Object.entries(bp).filter(([b]) => b !== 'bez značky').sort((a, b) => b[1][1] - a[1][1])
  .filter(([b], i) => i < 25 || isOwn(b))
  .forEach(([b, [kw, places]]) => out.push(['br', D, b, isOwn(b) ? 1 : 0, kw, r3(places / Math.max(1, nonBrand.length)), ab[b]?.[0] || 0, ab[b]?.[1] || 0]));
// cq – competitor ads on Prazdroj brand searches (latest)
conquestOf(latest).slice(0, 40).forEach(x => out.push(['cq', D, ...x]));
// sk – SKUs: linked keywords from config; seen/found/positions from the positions history
const linked = {};
cfg.keywords.forEach(([k, g, c, p]) => [...c, ...p].forEach(i => { const pid = String(cfg.skuList[i][0]); linked[pid] = (linked[pid] || 0) + 1; }));
const sD = skuStats(D), sP = P ? skuStats(P) : {};
for (const [pid] of cfg.skuList) {
  const a = sD[pid] || { seen: 0, found: 0, pos: [], top10: 0 }, b = sP[pid];
  out.push(['sk', D, String(pid), linked[pid] || 0, a.found, a.seen, a.top10, median(a.pos), a.pos.length ? Math.min(...a.pos) : null,
    b ? b.seen : null, b ? median(b.pos) : null, controls.has(String(pid)) ? 1 : 0]);
}
// gp – current backend keywords where none of the linked SKUs shows (latest)
latest.filter(r => /(^|\+)c(\+|$)/.test(r.groups) && num(r.linked_skus) > 0 && num(r.linked_found) === 0)
  .slice(0, 60).forEach(r => out.push(['gp', D, r.keyword, num(r.linked_skus), num(r.total_hits), (r.brands_top20 || '').split(' | ')[0] || '']));
// gl – go-live log (dated markers on the trend)
for (const g of cfg.golive || []) out.push(['gl', g.date, (g.keywords || []).length, (g.pids || []).length, g.note || '']);
// cfg – facts the page shows
out.push(['cfg', D, controls.size, (cfg.golive || []).length, cfg.baselineUntil || '']);

// ins – rule-based notes; a share move counts when it held for two runs in a row, or is 20+ pts in one run
const ins = [];
const pct = x => Math.round(x * 100) + ' %';
const by = id => id ? Object.fromEntries(kwOn(id).filter(r => r.key === '1').map(r => [r.keyword, r])) : {};
const ktD = by(D), ktP = by(P), ktPP = by(PP);
if (P) {
  const moves = Object.keys(ktD).filter(k => ktP[k] && org(ktD[k]) != null && org(ktP[k]) != null).map(k => {
    const d1 = org(ktD[k]) - org(ktP[k]);
    const d0 = ktPP[k] && org(ktPP[k]) != null ? org(ktP[k]) - org(ktPP[k]) : null;
    const lasting = d0 != null && Math.sign(d0) === Math.sign(d1) && Math.abs(d0) >= 0.05;
    return [k, d1, lasting, num(ktD[k].total_hits)];
  }).filter(([, d1, lasting]) => Math.abs(d1) >= 0.2 || (lasting && Math.abs(d1) >= 0.1))
    .sort((a, b) => b[3] - a[3]);
  moves.slice(0, 3).forEach(([k, d, lasting]) => ins.push(['ins', D, d > 0 ? 'up' : 'down',
    `"${k}": Prazdroj organic share of the top 20 ${d > 0 ? 'up' : 'down'} ${Math.round(Math.abs(d) * 100)} pts to ${pct(org(ktD[k]))}${lasting ? ', second run in a row' : ''}.`]));
  const adCh = [];
  for (const k of Object.keys(ktD)) for (const s of ['1', '4']) {
    const b = ktD[k][`ad${s}_brand`], a = ktP[k]?.[`ad${s}_brand`], hold = ktD[k][`ad${s}_hold`];
    const firm = !hold || /^(\d+)\/\1$/.test(hold) || Number(hold.split('/')[0]) >= 2;   // seen in most passes
    if (b && b !== a && !isOwn(b) && firm) adCh.push([num(ktD[k].total_hits), ['ins', D, 'watch',
      `"${k}": ${b} took sponsored #${s}${ktD[k][`ad${s}_promo`] ? ' with ' + ktD[k][`ad${s}_promo`] : ''}${hold ? ' (' + hold + ' passes)' : ''}, was ${a || 'empty'}.`]]);
  }
  adCh.sort((a, b) => b[0] - a[0]).slice(0, 3).forEach(([, x]) => ins.push(x));
  const lost = cfg.skuList.map(([pid, br]) => [String(pid), br]).filter(([pid]) => sP[pid] && (sD[pid]?.seen || 0) < sP[pid].seen - 2)
    .sort((a, b) => (sP[b[0]].seen - (sD[b[0]]?.seen || 0)) - (sP[a[0]].seen - (sD[a[0]]?.seen || 0)));
  lost.slice(0, 2).forEach(([pid, br]) => ins.push(['ins', D, 'down', `${br} SKU ${pid} shows on ${sD[pid]?.seen || 0} keywords, ${sP[pid].seen - (sD[pid]?.seen || 0)} fewer than the run before.`]));
  const cqP = new Set(conquestOf(kwOn(P)).map(x => x.join('|')));
  conquestOf(latest).filter(x => !cqP.has(x.join('|'))).slice(0, 2).forEach(([k, s, b, p]) => ins.push(['ins', D, 'watch', `New competitor ad on a Prazdroj brand search: ${b} at #${s} on "${k}"${p ? ' (' + p + ')' : ''}.`]));
}
Object.values(ktD).filter(r => num(r.total_hits) >= 20 && org(r) != null).sort((a, b) => org(a) - org(b)).slice(0, 2)
  .forEach(r => ins.push(['ins', D, 'gap', `Weakest key term: "${r.keyword}" – Prazdroj holds ${pct(org(r))} of the organic top 20 (${r.total_hits} results).`]));
const t = out.filter(x => x[0] === 'tr').at(-1);
if (t) ins.push(['ins', D, 'info', `Prazdroj holds sponsored #1 on ${t[8]} of ${t[9]} keywords with an ad, #4 on ${t[10]} of ${t[11]}; ${Math.round(t[12] / Math.max(1, t[9] + t[11]) * 100)} % of all ads run with a promo.`]);
out.push(...ins.slice(0, 10));

// write parts: ≤ 9,000 chars each, JSON lines inside a code fence
const lines = out.map(x => JSON.stringify(x));
const parts = []; let cur = [];
for (const l of lines) { if (cur.join('\n').length + l.length > 9000) { parts.push(cur); cur = []; } cur.push(l); }
if (cur.length) parts.push(cur);
fs.mkdirSync('out', { recursive: true });
parts.forEach((p, i) => fs.writeFileSync(`out/part_${90 + i}_dash.csv`,
  `# ${cfg.client} ${D} mode=full dash ${i + 1}/${parts.length} (dash)\n\`\`\`\n${p.join('\n')}\n\`\`\`\n# end\n`));
console.log(`dash: ${D} vs ${P || '-'}: ${lines.length} lines, ${parts.length} part(s)`);
