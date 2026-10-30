// Daily dashboard feed for the Prazdroj Search Monitor (POS Media). Node 22, no dependencies.
// Runs after a full tracker run. Reads history/*.csv + config, writes out/part_9N_dash.csv:
// one JSON array per line, first cell = table id. The dashboard reads these e-mails via MS365.
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG || 'config/prazdroj.json', 'utf8'));
const own = new Set(cfg.ownBrands.map(b => b.toLowerCase()));
const isOwn = b => own.has(String(b || '').toLowerCase());

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
  return d.filter(x => x.length >= h.length - 1).map(x => Object.fromEntries(h.map((k, i) => [k, x[i] ?? ''])));
}
const read = f => fs.existsSync(f) ? parse(fs.readFileSync(f, 'utf8')) : [];
const kwAll = read(`history/${cfg.client}_keywords.csv`).filter(r => r.mode === 'full');
const posAll = read(`history/${cfg.client}_positions.csv`).filter(r => r.mode === 'full');
if (!kwAll.length) { console.log('dash: no full runs yet'); process.exit(0); }

// one full run per date: the latest time that day
const runOf = {};
for (const r of kwAll) if (!runOf[r.date] || r.time > runOf[r.date]) runOf[r.date] = r.time;
const dates = Object.keys(runOf).sort();
const D = dates.at(-1), P = dates.length > 1 ? dates.at(-2) : null;
const kwOn = d => kwAll.filter(r => r.date === d && r.time === runOf[d]);
const posOn = d => posAll.filter(r => r.date === d && r.time === runOf[d]);
const num = x => (x === '' || x == null ? null : Number(x));
const r2 = x => x == null ? null : Math.round(x * 1000) / 1000;
const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const median = a => { const b = a.filter(x => x != null).sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : null; };
const brandRx = /birell|kozel|pilsner|urquell|radegast|gambrinus|frisco|elektr|proud|primus|excelent|klasik|peroni/i;
const conquestOf = rows => rows.filter(r => brandRx.test(r.keyword)).flatMap(r =>
  [['1', r.ad1_brand, r.ad1_promo], ['4', r.ad4_brand, r.ad4_promo]].filter(([, b]) => b && !isOwn(b)).map(([s, b, p]) => [r.keyword, s, b, p]));

const out = [];
// trend: one row per full-run date (last 60)
for (const d of dates.slice(-60)) {
  const rows = kwOn(d).filter(r => num(r.total_hits) > 0);
  const a1 = rows.filter(r => r.ad1_brand), a4 = rows.filter(r => r.ad4_brand);
  out.push(['tr', d, runOf[d], rows.length, r2(avg(rows.map(r => num(r.prazdroj_sos_top20)))), r2(avg(rows.map(r => num(r.prazdroj_sos_org_top20)))),
    rows.filter(r => num(r.prazdroj_sos_top20) === 0).length, a1.filter(r => isOwn(r.ad1_brand)).length, a1.length,
    a4.filter(r => isOwn(r.ad4_brand)).length, a4.length, a1.filter(r => r.ad1_promo).length + a4.filter(r => r.ad4_promo).length,
    conquestOf(rows).length]);
}
// key terms: latest and previous run
for (const d of [P, D].filter(Boolean)) for (const r of kwOn(d).filter(r => r.key === '1'))
  out.push(['kt', d, r.keyword, num(r.total_hits), num(r.prazdroj_sos_top20), num(r.prazdroj_best_org_pos), r.ad1_brand, r.ad1_promo, r.ad4_brand, r.ad4_promo,
    (r.brands_top20 || '').split(' | ').slice(0, 3).join(' | ')]);
// ad slots by brand (latest)
const latest = kwOn(D).filter(r => num(r.total_hits) > 0);
const ab = {};
for (const r of latest) for (const [s, b, p] of [[1, r.ad1_brand, r.ad1_promo], [4, r.ad4_brand, r.ad4_promo]]) if (b) {
  ab[b] ??= [0, 0, 0]; ab[b][s === 1 ? 0 : 1]++; if (p) ab[b][2]++;
}
Object.entries(ab).sort((a, b) => (b[1][0] + b[1][1]) - (a[1][0] + a[1][1])).slice(0, 25)
  .forEach(([b, [s1, s4, pr]]) => out.push(['ad', D, b, s1, s4, pr, isOwn(b) ? 1 : 0]));
// competitor ads on Prazdroj brand searches (latest)
conquestOf(latest).slice(0, 40).forEach(x => out.push(['cq', D, ...x]));
// SKUs: linked keywords from config; seen/found from positions
const linked = {};
cfg.keywords.forEach(([k, g, c, p]) => [...c, ...p].forEach(i => { const pid = String(cfg.skuList[i][0]); linked[pid] = (linked[pid] || 0) + 1; }));
const skuStats = d => {
  const s = {};
  for (const r of posOn(d)) {
    const x = s[r.pid] ??= { seen: 0, found: 0, pos: [], top10: 0 };
    x.seen++; if (r.kw_status !== 'not linked') x.found++;
    const o = num(r.org_pos); if (o != null) { x.pos.push(o); if (o <= 10) x.top10++; }
  }
  return s;
};
const sD = skuStats(D), sP = P ? skuStats(P) : {};
for (const [pid] of cfg.skuList) {
  const a = sD[pid] || { seen: 0, found: 0, pos: [], top10: 0 }, b = sP[pid];
  out.push(['sk', D, String(pid), linked[pid] || 0, a.found, a.seen, a.top10, median(a.pos), a.pos.length ? Math.min(...a.pos) : null,
    b ? b.seen : null, b ? median(b.pos) : null]);
}
// current keywords where none of the linked SKUs shows (latest)
latest.filter(r => /(^|\+)c(\+|$)/.test(r.groups) && num(r.linked_skus) > 0 && num(r.linked_found) === 0)
  .slice(0, 60).forEach(r => out.push(['gp', D, r.keyword, num(r.linked_skus), num(r.total_hits), (r.brands_top20 || '').split(' | ')[0] || '']));

// rule-based insights (latest vs previous)
const ins = [];
const pct = x => Math.round(x * 100) + ' %';
const ktD = Object.fromEntries(kwOn(D).filter(r => r.key === '1').map(r => [r.keyword, r]));
const ktP = P ? Object.fromEntries(kwOn(P).filter(r => r.key === '1').map(r => [r.keyword, r])) : {};
if (P) {
  const moves = Object.keys(ktD).filter(k => ktP[k]).map(k => [k, num(ktD[k].prazdroj_sos_top20) - num(ktP[k].prazdroj_sos_top20)]).filter(([, d]) => Math.abs(d) >= 0.1)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  moves.slice(0, 3).forEach(([k, d]) => ins.push(['ins', D, d > 0 ? 'up' : 'down',
    `"${k}": Prazdroj share of the top 20 ${d > 0 ? 'up' : 'down'} ${Math.round(Math.abs(d) * 100)} pts to ${pct(num(ktD[k].prazdroj_sos_top20))}.`]));
  const adCh = [];
  for (const k of Object.keys(ktD)) for (const s of ['1', '4']) {
    const b = ktD[k][`ad${s}_brand`], a = ktP[k]?.[`ad${s}_brand`];
    if (b && b !== a && !isOwn(b)) adCh.push([num(ktD[k].total_hits), ['ins', D, 'watch', `"${k}": ${b} took sponsored #${s}${ktD[k][`ad${s}_promo`] ? ' with ' + ktD[k][`ad${s}_promo`] : ''} (was ${a || 'empty'}).`]]);
  }
  adCh.sort((a, b) => b[0] - a[0]).slice(0, 3).forEach(([, x]) => ins.push(x));
  const lost = cfg.skuList.map(([pid, br]) => [String(pid), br]).filter(([pid]) => sP[pid] && (sD[pid]?.seen || 0) < sP[pid].seen - 2)
    .sort((a, b) => (sP[b[0]].seen - (sD[b[0]]?.seen || 0)) - (sP[a[0]].seen - (sD[a[0]]?.seen || 0)));
  lost.slice(0, 2).forEach(([pid, br]) => ins.push(['ins', D, 'down', `${br} SKU ${pid} shows on ${sD[pid]?.seen || 0} keywords, ${sP[pid].seen - (sD[pid]?.seen || 0)} fewer than the run before.`]));
  const cqP = new Set(conquestOf(kwOn(P)).map(x => x.join('|')));
  conquestOf(latest).filter(x => !cqP.has(x.join('|'))).slice(0, 2).forEach(([k, s, b, p]) => ins.push(['ins', D, 'watch', `New competitor ad on a Prazdroj brand search: ${b} at #${s} on "${k}"${p ? ' (' + p + ')' : ''}.`]));
}
const weak = Object.values(ktD).filter(r => num(r.total_hits) >= 20).sort((a, b) => num(a.prazdroj_sos_top20) - num(b.prazdroj_sos_top20)).slice(0, 2);
weak.forEach(r => ins.push(['ins', D, 'gap', `Weakest key term: "${r.keyword}" – Prazdroj holds ${pct(num(r.prazdroj_sos_top20))} of the top 20 (${r.total_hits} results).`]));
const t = out.filter(x => x[0] === 'tr').at(-1);
if (t) ins.push(['ins', D, 'info', `Prazdroj holds sponsored #1 on ${t[7]} of ${t[8]} keywords with an ad, #4 on ${t[9]} of ${t[10]}; ${Math.round(t[11] / Math.max(1, t[8] + t[10]) * 100)} % of all ads run with a promo.`]);
out.push(...ins.slice(0, 10));

// write parts: ≤ 9,000 chars each, JSON lines inside a code fence
const lines = out.map(x => JSON.stringify(x));
const parts = []; let cur = [];
for (const l of lines) { if (cur.join('\n').length + l.length > 9000) { parts.push(cur); cur = []; } cur.push(l); }
if (cur.length) parts.push(cur);
fs.mkdirSync('out', { recursive: true });
const time = runOf[D];
parts.forEach((p, i) => fs.writeFileSync(`out/part_${90 + i}_dash.csv`,
  `# ${cfg.client} ${D} ${time} mode=full dash ${i + 1}/${parts.length} (dash)\n\`\`\`\n${p.join('\n')}\n\`\`\`\n# end\n`));
console.log(`dash: ${D} vs ${P || '-'}: ${lines.length} lines, ${parts.length} part(s)`);
