// Rohlík keyword tracker – keyword-centric (POS Media). Node 22, no dependencies.
// One search = full ranking -> every tracked SKU and every competitor is measured at once.
// Env: CONFIG (default config/prazdroj.json), MODE = full | key, PASSES (optional override)
import fs from 'node:fs';

const CFG_PATH = process.env.CONFIG || 'config/prazdroj.json';
const MODE = (process.env.MODE || 'full').toLowerCase();
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
// compact config: skuList = [[productId, brand], ...]; keywords = [keyword, groups, currentSkuIdx[], plannedSkuIdx[], key?]
cfg.skus = Object.fromEntries(cfg.skuList.map(([id, b]) => [String(id), [b]]));
cfg.keywords = cfg.keywords.map(([k, g, c, p, key]) => [k, g, c.map(i => cfg.skuList[i][0]), p.map(i => cfg.skuList[i][0]), key]);
const now = new Date();
const pragueDate = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });            // YYYY-MM-DD
const pragueTime = now.toLocaleTimeString('sv-SE', { timeZone: 'Europe/Prague', hour12: false }).slice(0, 5);
const PASSES = Number(process.env.PASSES || (cfg.baselineUntil && pragueDate <= cfg.baselineUntil ? 3 : 1));
const SPACING_MS = Number(process.env.SPACING_MS || 1500);
const BASE = 'https://www.rohlik.cz/services/frontend-service/search-metadata';
const own = new Set(cfg.ownBrands.map(b => b.toLowerCase()));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// go-live log: [{date:'YYYY-MM-DD', pids:[...], keywords:[...]}] -> key "pid|keyword" -> date
const live = new Map();
for (const g of cfg.golive || []) for (const p of g.pids) for (const k of g.keywords) live.set(`${p}|${k.toLowerCase()}`, g.date);

async function search(q) {
  const url = `${BASE}?search=${encodeURIComponent(q)}&offset=0&limit=${cfg.limit}&companyId=1&warehouseId=${cfg.warehouseId}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0 (POS Media keyword tracker)' } });
      if (r.ok) return (await r.json()).data;
      if (r.status === 429) await sleep(15000 * attempt);
    } catch (e) { await sleep(3000 * attempt); }
  }
  return null;
}

const promoOf = p => {
  const s = (p.sales || []).map(x => `${x.type || 'sale'}${x.discountPercentage ? ' -' + Math.round(x.discountPercentage) + '%' : ''}`);
  if (p.goodPrice) s.push(`goodPrice -${p.goodPriceSalePercentage || 0}%`);
  return s.join(' + ');
};
// discount in % (max over sale types); 'y' = on promo without a stated %; '' = full price
const discOf = p => {
  const v = [...(p.sales || []).map(x => x.discountPercentage || 0), p.goodPrice ? (p.goodPriceSalePercentage || 0) : null].filter(x => x != null);
  if (!v.length) return '';
  const m = Math.round(Math.max(...v));
  return m > 0 ? String(m) : 'y';
};
const brandOf = p => (typeof p.brand === 'string' ? p.brand : p.brand?.name) || 'bez značky';

function snapshot(d) {
  const ids = d.productIds || [];
  const ads = new Set((d.impressions || []).map(i => i.productId));
  const byId = new Map((d.productList || []).map(p => [p.productId, p]));
  let org = 0;
  const rows = ids.map((id, i) => {
    const p = byId.get(id) || {};
    const ad = ads.has(id);
    if (!ad) org++;
    return { id, pos: i + 1, org: ad ? null : org, ad, brand: brandOf(p), name: (p.productName || '').slice(0, 45), promo: promoOf(p), disc: discOf(p) };
  });
  return { total: d.totalHits ?? ids.length, rows };
}

const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const median = a => { const b = a.filter(x => x != null).sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : null; };

async function main() {
  // canary: Rohlík must answer normally, otherwise fail loudly instead of writing empty data
  const can = await search(cfg.canary.query);
  if (!can || (can.productIds || []).length < cfg.canary.minResults) throw new Error('Canary failed – Rohlík search not answering normally');

  const list = cfg.keywords.filter(k => MODE === 'key' ? k[4] === 1 : true);
  const kwRows = [], posRows = [];
  // product names for everything shown in the top 5 (the dashboard needs competitor names)
  const PROD = `history/${cfg.client}_products.json`;
  const products = fs.existsSync(PROD) ? JSON.parse(fs.readFileSync(PROD, 'utf8')) : {};
  let n = 0;
  for (const [k, groups, cur, plan, key] of list) {
    const snaps = [];
    for (let pass = 0; pass < PASSES; pass++) {
      const d = await search(k); n++;
      if (d) snaps.push(snapshot(d));
      await sleep(SPACING_MS);
    }
    if (!snaps.length) { kwRows.push({ k, groups, error: 'no response' }); continue; }
    const s0 = snaps[0];
    const isOwn = r => own.has(r.brand.toLowerCase()) || !!cfg.skus[r.id];
    // share of search = average over all passes (ads rotate between page loads)
    const shares = snaps.map(s => {
      const top = s.rows.slice(0, cfg.topN), org = s.rows.filter(r => !r.ad).slice(0, cfg.topN);
      return [top.length ? top.filter(isOwn).length / top.length : null, org.length ? org.filter(isOwn).length / org.length : null];
    });
    const mean = a => { const b = a.filter(x => x != null); return b.length ? b.reduce((x, y) => x + y, 0) / b.length : null; };
    const sosAll = mean(shares.map(x => x[0])), sosOrg = mean(shares.map(x => x[1]));
    const brandCount = {};
    s0.rows.slice(0, cfg.topN).forEach(r => brandCount[r.brand] = (brandCount[r.brand] || 0) + 1);
    // sponsored slot = the product seen there most often across passes, with how often (e.g. 2/3)
    const slot = pos => {
      const seen = snaps.map(s => s.rows.find(r => r.pos === pos && r.ad)).filter(Boolean);
      if (!seen.length) return [null, ''];
      const c = {}; seen.forEach(r => c[r.id] = (c[r.id] || 0) + 1);
      const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
      return [seen.find(r => String(r.id) === best[0]), `${best[1]}/${snaps.length}`];
    };
    const [ad1, ad1Hold] = slot(1), [ad4, ad4Hold] = slot(4);
    const otherAds = [...new Set(snaps.flatMap(s => s.rows.filter(r => r.ad && r.pos !== 1 && r.pos !== 4).map(r => `${r.brand}@${r.pos}`)))].join(' | ');

    // Prazdroj SKUs: tracked + linked to this keyword
    const linked = new Set([...cur, ...plan]);
    const seen = new Set(s0.rows.filter(r => cfg.skus[r.id]).map(r => r.id));
    const ownPositions = [];
    for (const pid of new Set([...seen, ...linked])) {
      const orgs = snaps.map(s => s.rows.find(r => r.id === pid)?.org ?? null);
      const alls = snaps.map(s => s.rows.find(r => r.id === pid)?.pos ?? null);
      const r0 = s0.rows.find(r => r.id === pid);
      const pidStr = String(pid);
      const golive = plan.includes(pid) ? live.get(`${pid}|${k}`) : null;
      const status = cur.includes(pid) ? 'current' : plan.includes(pid) ? (golive && golive <= pragueDate ? 'live' : 'planned') : 'not linked';
      const period = golive && golive <= pragueDate ? 'post' : 'pre';
      const orgMed = median(orgs);
      if (orgMed != null) ownPositions.push(`${pid}:${orgMed}${r0?.ad ? 'ad' : ''}`);
      if (orgMed == null && !r0) continue;          // linked but not found -> counted in keyword row, no position row
      posRows.push({ date: pragueDate, time: pragueTime, mode: MODE, keyword: k, pid: pidStr, brand: cfg.skus[pidStr]?.[0] || r0?.brand || '',
        org_pos: orgMed, pos_incl_ads: median(alls), sponsored: r0?.ad ? 1 : 0, promo: r0?.promo || '', kw_status: status, period,
        found_in_passes: orgs.filter(x => x != null).length + '/' + snaps.length });
    }
    kwRows.push({ date: pragueDate, time: pragueTime, mode: MODE, passes: snaps.length, keyword: k, groups, key: key ? 1 : 0, total_hits: s0.total,
      n_ads: s0.rows.filter(r => r.ad).length,
      ad1_pid: ad1?.id ?? '', ad1_brand: ad1?.brand ?? '', ad1_name: ad1?.name ?? '', ad1_promo: ad1?.promo ?? '',
      ad4_pid: ad4?.id ?? '', ad4_brand: ad4?.brand ?? '', ad4_name: ad4?.name ?? '', ad4_promo: ad4?.promo ?? '',
      other_ads: otherAds,
      prazdroj_sos_top20: sosAll == null ? '' : sosAll.toFixed(3), prazdroj_sos_org_top20: sosOrg == null ? '' : sosOrg.toFixed(3),
      prazdroj_best_org_pos: Math.min(...ownPositions.map(x => parseInt(x.split(':')[1])), 999) === 999 ? '' : Math.min(...ownPositions.map(x => parseInt(x.split(':')[1]))),
      prazdroj_positions: ownPositions.join(' '),
      linked_skus: linked.size, linked_found: [...linked].filter(p => s0.rows.some(r => r.id === p)).length,
      brands_top20: Object.entries(brandCount).sort((a, b) => b[1] - a[1]).map(([b, c]) => `${b}:${c}`).join(' | '),
      ad1_hold: ad1Hold, ad4_hold: ad4Hold,
      // what Rohlík shows: first 5 products of the first page load, "pid:a|o:discount" (a = sponsored, o = organic)
      top5: s0.rows.slice(0, 5).map(r => `${r.id}:${r.ad ? 'a' : 'o'}:${r.disc}`).join(' '),
      promo_top20: s0.rows.slice(0, cfg.topN).filter(r => r.disc).length,
      prazdroj_disc: s0.rows.filter(r => cfg.skus[r.id] && r.disc).map(r => `${r.id}:${r.disc}`).join(' ') });
    for (const r of s0.rows.slice(0, 5)) products[r.id] = [r.brand, r.name];
  }

  fs.mkdirSync('history', { recursive: true }); fs.mkdirSync('out', { recursive: true });
  const write = (rows, name) => {
    if (!rows.length) return '';
    const cols = Object.keys(rows.find(r => !r.error) || rows[0]);
    const body = rows.map(r => cols.map(c => csvCell(r[c])).join(',')).join('\n');
    const file = `history/${cfg.client}_${name}.csv`;
    if (!fs.existsSync(file)) fs.writeFileSync(file, cols.join(',') + '\n');
    else {   // columns added at the end since the file was started: rewrite the header line only
      const txt = fs.readFileSync(file, 'utf8'), nl = txt.indexOf('\n');
      if (txt.slice(0, nl) !== cols.join(',')) fs.writeFileSync(file, cols.join(',') + txt.slice(nl));
    }
    fs.appendFileSync(file, body + '\n');
    return cols.join(',') + '\n' + body + '\n';
  };
  fs.writeFileSync(PROD, JSON.stringify(products));
  const kwCsv = write(kwRows, 'keywords');
  const posCsv = write(posRows, 'positions');

  // e-mail parts: slim columns (full detail stays in history/ in git) and small parts –
  // 55k-char parts were created as issues but GitHub never e-mailed them; ~12k parts arrive reliably
  const EMAIL_COLS = ['date', 'time', 'mode', 'passes', 'keyword', 'groups', 'key', 'total_hits', 'n_ads',
    'ad1_pid', 'ad1_brand', 'ad1_promo', 'ad4_pid', 'ad4_brand', 'ad4_promo', 'ad1_hold', 'ad4_hold',
    'prazdroj_sos_top20', 'prazdroj_sos_org_top20', 'prazdroj_best_org_pos', 'prazdroj_positions',
    'linked_skus', 'linked_found', 'brands_top5'];
  const PART_LIMIT = Number(process.env.PART_LIMIT || 10000);
  const slim = r => ({ ...r, brands_top5: (r.brands_top20 || '').split(' | ').slice(0, 5).join(' | ') });
  const emailCsv = kwRows.length ? EMAIL_COLS.join(',') + '\n' + kwRows.map(r => EMAIL_COLS.map(c => csvCell(slim(r)[c])).join(',')).join('\n') + '\n' : '';
  const parts = [];
  const chunk = (csv, label) => {
    const [head, ...lines] = csv.trim().split('\n');
    let cur = [];
    for (const l of lines) {
      if ((head.length + cur.join('\n').length + l.length) > PART_LIMIT) { parts.push({ label, text: [head, ...cur].join('\n') }); cur = []; }
      cur.push(l);
    }
    if (cur.length) parts.push({ label, text: [head, ...cur].join('\n') });
  };
  if (emailCsv && process.env.EMAIL_KEYWORDS === '1') chunk(emailCsv, 'keywords');   // positions + full keyword columns stay in history/ (git)
  parts.forEach((p, i) => fs.writeFileSync(`out/part_${String(i + 1).padStart(2, '0')}_${p.label}.csv`,
    `# ${cfg.client} ${pragueDate} ${pragueTime} mode=${MODE} part ${i + 1}/${parts.length} (${p.label})\n${p.text}\n# end\n`));
  console.log(`done: ${list.length} keywords, ${n} requests, ${PASSES} pass(es), ${kwRows.length} keyword rows, ${posRows.length} position rows, ${parts.length} parts`);
}
main().catch(e => { console.error(e); process.exit(1); });
