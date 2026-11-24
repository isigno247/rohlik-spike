// Rohlík keyword tracker – keyword-centric (POS Media). Node 22, no dependencies.
// One search = full ranking -> every tracked SKU and every competitor is measured at once.
// Env: CONFIG (default config/prazdroj.json), MODE = full | key, PASSES (optional override)
import fs from 'node:fs';
import zlib from 'node:zlib';

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
const NOVINKA_SLOT = Number(cfg.novinkaSlot || 6);
const KEY_DEPTH = Number(cfg.limitKey || 200);
const P1 = Number(cfg.pageSize || 12), P2 = 2 * P1;   // tiles on the first search page / first two pages (incl. sponsored)
const sleep = ms => new Promise(r => setTimeout(r, ms));
// v4 (24 Nov 2026, Michal Slávik's method): whole result list for every query, raw row per tile, 2 sessions for main queries
const FULL_DEPTH = Number(cfg.fullDepth || 2000);     // longest query ~1 200 results; API pages by 200
const MAIN_PASSES = Number(cfg.mainPasses || 2);      // main (key) queries: 2 independent sessions

// go-live log: [{date:'YYYY-MM-DD', pids:[...], keywords:[...]}] -> key "pid|keyword" -> date
const live = new Map();
for (const g of cfg.golive || []) for (const p of g.pids) for (const k of g.keywords) live.set(`${p}|${k.toLowerCase()}`, g.date);

// v2 (10 Nov 2026 test): key keywords go deeper (broad queries like "pivo" have 400+ hits); out-of-stock items
// are always sorted to the very end by the API, so a tracked SKU that goes OOS drops to the tail.
async function search(q, depth = cfg.limit) {
  const pages = [];
  for (let off = 0; off < depth; off += 200) {
    const d = await searchPage(q, off, Math.min(200, depth - off));
    if (!d) return pages.length ? merge(pages) : null;
    pages.push(d);
    if (off + 200 >= (d.totalHits ?? 0) || !(d.productIds || []).length) break;
    await sleep(300);
  }
  return merge(pages);
}
const merge = ps => {
  if (ps.length === 1) return { ...ps[0], _dups: 0 };
  const all = ps.flatMap(d => d.productIds || []), ids = [...new Set(all)];
  return { ...ps[0], productIds: ids, _dups: all.length - ids.length,
    productList: ps.flatMap(d => d.productList || []), impressions: ps[0].impressions };
};
async function searchPage(q, offset, limit) {
  const url = `${BASE}?search=${encodeURIComponent(q)}&offset=${offset}&limit=${limit}&companyId=1&warehouseId=${cfg.warehouseId}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'accept': 'application/json', 'user-agent': 'Mozilla/5.0 (POS Media keyword tracker)' }, signal: AbortSignal.timeout(30000) });
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
  // ads Set by productId is safe for ANONYMOUS calls: 0 duplicate productIds in 22 queries (sponsored slots 1 and 4).
  // Logged-in API + website DO duplicate (novinka at #6 and again at its organic rank, e.g. #236; ad #1 again organically).
  // Anonymous API collapses these to the inserted slot only -> the true organic rank of a slotted novinka or an ad product
  // is NOT observable anonymously; org_pos_clean is left empty for them on purpose.
  const ads = new Set((d.impressions || []).map(i => i.productId));
  const byId = new Map((d.productList || []).map(p => [p.productId, p]));
  let org = 0, clean = 0;
  const rows = ids.map((id, i) => {
    const p = byId.get(id) || {};
    const ad = ads.has(id);
    const isNew = (p.badge || []).some(b => b.slug === 'new');
    const inStock = p.inStock !== false;
    // Rohlík injects one "Novinka" product at position 6 (13 of 14 queries with a novinka, 10 Nov 2026)
    const slot = i + 1 === NOVINKA_SLOT && isNew && !ad;
    if (!ad) org++;
    const isClean = !ad && !slot && inStock;
    if (isClean) clean++;
    return { id, pos: i + 1, org: ad ? null : org, orgClean: isClean ? clean : null, ad, isNew, inStock, slot,
      brand: brandOf(p), name: (p.productName || '').slice(0, 45), promo: promoOf(p), disc: discOf(p),
      price: p.price?.full ?? null, priceBefore: p.originalPrice?.full ?? (typeof p.originalPrice === 'number' ? p.originalPrice : null) };
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
  // raw tile rows (Michal's data fields): one row per tile and session, whole list; written as we go, gzip per run in history/raw/
  const RAW_COLS = ['run_id', 'date', 'time', 'mode', 'warehouse', 'query', 'set', 'session', 'total_hits', 'depth', 'dups',
    'position_total', 'position_organic', 'rohlik_id', 'brand', 'name', 'in_stock', 'sponsored', 'novinka', 'novinka_slot',
    'price', 'price_before', 'discount', 'akce', 'client'];
  fs.mkdirSync('out', { recursive: true });
  const RAW_TMP = 'out/raw_tmp.csv';
  fs.writeFileSync(RAW_TMP, RAW_COLS.join(',') + '\n');
  const runId = `${pragueDate} ${pragueTime} ${MODE}`;
  const qc = { incomplete: [], failed: [], retried: [], sessionDiff: [], rawRows: 0 };
  const isClient = r => own.has(String(r.brand).toLowerCase()) || !!cfg.skus[r.id];
  const addRaw = (k, key, session, full, d) => {
    const lines = full.rows.map(r => [runId, pragueDate, pragueTime, MODE, cfg.warehouseId, k, key ? 'main' : 'backend', session,
      full.total, full.rows.length, d._dups || 0, r.pos, r.org ?? '', r.id, r.brand, r.name, r.inStock ? 1 : 0, r.ad ? 1 : 0,
      r.isNew ? 1 : 0, r.slot ? 1 : 0, r.price ?? '', r.priceBefore ?? '', r.disc, r.disc ? 1 : 0, isClient(r) ? 1 : 0].map(csvCell).join(','));
    if (lines.length) fs.appendFileSync(RAW_TMP, lines.join('\n') + '\n');
    qc.rawRows += lines.length;
    if (full.rows.length < Math.min(full.total, FULL_DEPTH) - 2) qc.incomplete.push(`${k} (${full.rows.length}/${full.total})`);
  };
  // failed queries are tried once more at the end of the run
  const queue = [...list], retried = new Set();
  for (let qi = 0; qi < queue.length; qi++) {
    const [k, groups, cur, plan, key] = queue[qi];
    if ((qi + 1) % 50 === 0) console.log(`progress: ${qi + 1}/${queue.length} queries, ${n} searches`);
    const snaps = [];
    const nPass = key ? Math.max(PASSES, MAIN_PASSES) : PASSES;
    const legacyDepth = key ? KEY_DEPTH : cfg.limit;
    const ownBySession = [];
    for (let pass = 0; pass < nPass; pass++) {
      const d = await search(k, FULL_DEPTH); n++;
      if (d) {
        const full = snapshot(d);
        addRaw(k, key, pass + 1, full, d);
        ownBySession.push(Object.fromEntries(full.rows.filter(r => cfg.skus[r.id] && r.org != null).map(r => [r.id, r.org])));
        // the existing metrics keep their old depth (top 100 / 200), so the dashboard history stays comparable
        snaps.push({ total: full.total, rows: full.rows.slice(0, legacyDepth) });
      }
      await sleep(SPACING_MS);
    }
    if (!snaps.length) {
      if (!retried.has(k)) { retried.add(k); qc.retried.push(k); queue.push(queue[qi]); continue; }
      qc.failed.push(k); kwRows.push({ k, groups, error: 'no response' }); continue;
    }
    if (ownBySession.length >= 2) {   // session agreement: |position session 1 − session 2| of tracked SKUs
      const [a, b] = ownBySession, diffs = Object.keys(a).filter(id => id in b).map(id => Math.abs(a[id] - b[id]));
      if (diffs.length) qc.sessionDiff.push([k, median(diffs)]);
    }
    const s0 = snaps[0];
    const isOwn = r => own.has(r.brand.toLowerCase()) || !!cfg.skus[r.id];
    // share of search = average over all passes (ads rotate between page loads)
    const shares = snaps.map(s => {
      const top = s.rows.slice(0, cfg.topN), org = s.rows.filter(r => !r.ad).slice(0, cfg.topN);
      return [top.length ? top.filter(isOwn).length / top.length : null, org.length ? org.filter(isOwn).length / org.length : null];
    });
    const mean = a => { const b = a.filter(x => x != null); return b.length ? b.reduce((x, y) => x + y, 0) / b.length : null; };
    const sosAll = mean(shares.map(x => x[0])), sosOrg = mean(shares.map(x => x[1]));
    // share of search on page 1 (P1 tiles, 12) and pages 1–2 (P2 tiles, 24): tiles incl. sponsored, fixed denominator,
    // split into organic and sponsored Prazdroj tiles, averaged over passes like the top-20 share above
    const sosDepth = n => {
      const per = snaps.map(s => { const t = s.rows.slice(0, n).filter(isOwn); return [t.filter(r => !r.ad).length / n, t.filter(r => r.ad).length / n]; });
      return [mean(per.map(x => x[0])), mean(per.map(x => x[1]))];
    };
    const [sos12Org, sos12Ad] = sosDepth(P1), [sos24Org, sos24Ad] = sosDepth(P2);
    const f3 = x => x === null ? '' : x.toFixed(3);
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
        found_in_passes: orgs.filter(x => x != null).length + '/' + snaps.length,
        // v2 columns (appended): stock + novinka effects separated from keyword effect
        in_stock: r0 ? (r0.inStock ? 1 : 0) : '', novinka: r0?.isNew ? 1 : 0,
        novinka_slot: snaps.filter(s => s.rows.some(r => r.id === pid && r.slot)).length + '/' + snaps.length,
        org_pos_clean: median(snaps.map(s => s.rows.find(r => r.id === pid)?.orgClean ?? null)) });
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
      prazdroj_disc: s0.rows.filter(r => cfg.skus[r.id] && r.disc).map(r => `${r.id}:${r.disc}`).join(' '),
      // best organic position per brand (median over passes), brands that reach the organic top 50 – ranking trend per brand
      brand_best: (() => {
        const per = {};
        snaps.forEach(sn => { const b = {}; sn.rows.forEach(r => { if (r.org != null && r.org <= 50 && !(r.brand in b)) b[r.brand] = r.org; });
          Object.entries(b).forEach(([k, v]) => (per[k] ??= []).push(v)); });
        return Object.entries(per).map(([k, v]) => [k, median(v)]).sort((a, b) => a[1] - b[1]).slice(0, 15)
          .map(([k, v]) => `${k.replace(/[|:]/g, ' ')}:${v}`).join('|');
      })(),
      // v2 columns (appended)
      depth: s0.rows.length,
      oos_top20: s0.rows.slice(0, cfg.topN).filter(r => !r.inStock).length, oos_total: s0.rows.filter(r => !r.inStock).length,
      novinka_slot_pid: s0.rows.find(r => r.slot)?.id ?? '', novinka_slot_brand: s0.rows.find(r => r.slot)?.brand ?? '',
      // v3 columns (appended): share of search page 1 (12 tiles) and top 24, incl. sponsored tiles; promo/OOS in top 24
      sos12_org: f3(sos12Org), sos12_ad: f3(sos12Ad), sos24_org: f3(sos24Org), sos24_ad: f3(sos24Ad),
      promo_top24: s0.rows.slice(0, P2).filter(r => r.disc).length, oos_top24: s0.rows.slice(0, P2).filter(r => !r.inStock).length });
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
  fs.mkdirSync('history/raw', { recursive: true }); fs.mkdirSync('history/qc', { recursive: true });
  const stamp = `${pragueDate}_${pragueTime.replace(':', '')}_${MODE}`;
  fs.writeFileSync(`history/raw/${cfg.client}_${stamp}.csv.gz`, zlib.gzipSync(fs.readFileSync(RAW_TMP)));
  const sd = qc.sessionDiff.map(x => x[1]);
  const qcOut = { run: runId, warehouse: cfg.warehouseId, queries: list.length, searches: n, raw_rows: qc.rawRows,
    incomplete_lists: qc.incomplete, failed: qc.failed, retried: qc.retried,
    session_agreement: { queries: sd.length, median_diff: median(sd), worst: qc.sessionDiff.sort((x, y) => y[1] - x[1]).slice(0, 5) } };
  fs.writeFileSync(`history/qc/${cfg.client}_${stamp}.json`, JSON.stringify(qcOut, null, 1));
  console.log('QC:', JSON.stringify({ ...qcOut, incomplete_lists: qc.incomplete.length, failed: qc.failed.length, retried: qc.retried.length }));

  // e-mail parts: slim columns (full detail stays in history/ in git) and small parts –
  // 55k-char parts were created as issues but GitHub never e-mailed them; ~12k parts arrive reliably
  const EMAIL_COLS = ['date', 'time', 'mode', 'passes', 'keyword', 'groups', 'key', 'total_hits', 'n_ads',
    'ad1_pid', 'ad1_brand', 'ad1_promo', 'ad4_pid', 'ad4_brand', 'ad4_promo', 'ad1_hold', 'ad4_hold',
    'prazdroj_sos_top20', 'prazdroj_sos_org_top20', 'prazdroj_best_org_pos', 'prazdroj_positions',
    'linked_skus', 'linked_found', 'brands_top5', 'oos_top20', 'novinka_slot_brand']; // v2 cols appended 10 Nov 2026
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
