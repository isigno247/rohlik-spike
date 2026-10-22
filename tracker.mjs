// Rohlik keyword tracker v5 (GitHub). Same metrics as the Mac rk_engine v5:
// organic rank (target + controls), top10/30/100, share of search top 10, weighted share top 30 (1/log2(pos+1)),
// top competitor brands, ads, autocomplete (product tile / brand phrase), prefix test on head terms, low-results flag.
// v5.1: shared keywords measured once for all configs, 3rd pass skipped when passes 1+2 agree, canary check, products without brand = 'bez značky'.
// Reads every active config/*.json, writes history/<name>_*.csv and out/summary_<name>.md (GitHub issue -> email).
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';

const PASSES = 3, LIMIT = 200, TOP = 100;
const GAP_MS = Number(process.env.GAP_MS ?? 1100);
const BASE = 'https://www.rohlik.cz/services/frontend-service';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept': 'application/json', 'Accept-Language': 'cs-CZ,cs;q=0.9', 'Referer': 'https://www.rohlik.cz/' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' });
const RUN = process.env.GITHUB_RUN_NUMBER || 'local';
const median = a => { const b = a.filter(x => x != null).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const r3 = x => x == null ? '' : Math.round(x * 1000) / 1000;
const csv = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const W = pos => 1 / Math.log2(pos + 1); // 1. = 1.00, 2. = 0.63, 10. = 0.29, 30. = 0.20
let calls = 0;
const NOBRAND = 'bez značky';
const cache = new Map();           // `${warehouse}|${keyword}` -> raw passes, shared by all configs
const tracked = new Set();          // every target/control id of every active config
let skipped3 = 0;

async function getJson(url) {
  for (let i = 1; i <= 3; i++) {
    try { const res = await fetch(url, { headers: HEADERS }); calls++;
      if (res.ok) { await sleep(GAP_MS); return await res.json(); }
      console.log(`HTTP ${res.status} (try ${i})`); if (res.status === 403 || res.status === 429) await sleep(30000 * i);
    } catch (e) { console.log(`ERR ${e} (try ${i})`); }
    await sleep(5000 * i);
  }
  throw new Error('Rohlik request failed 3x — stopping so no partial week is recorded');
}
const search = (q, wh) => getJson(`${BASE}/search-metadata?search=${encodeURIComponent(q)}&offset=0&limit=${LIMIT}&companyId=1&warehouseId=${wh}`).then(j => j.data ?? {});
const autocomplete = (q, wh) => getJson(`${BASE}/autocomplete?search=${encodeURIComponent(q)}&referer=whisperer&companyId=1&warehouseId=${wh}`).then(j => j.data ?? j);

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c; }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [h, ...b] = rows; return b.filter(r => r.length > 1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}
function appendCsv(path, cols, rows) {
  if (!existsSync(path)) writeFileSync(path, cols.join(',') + '\n');
  if (rows.length) appendFileSync(path, rows.map(r => cols.map(c => csv(r[c])).join(',')).join('\n') + '\n');
}

// raw search+autocomplete passes for one keyword, cached across configs; 3rd pass only when passes 1 and 2 disagree
async function measureRaw(kw, wh) {
  const key = `${wh}|${kw}`; if (cache.has(key)) return cache.get(key);
  const sig = s => { const org = (s.productList ?? []).filter(x => x.productPromotionType !== 'SPONSORED').map(x => x.productId);
    return org.slice(0, 30).join(',') + '#' + [...tracked].map(id => { const i = org.indexOf(id); return i < 0 || i >= TOP ? 0 : i + 1; }).join(','); };
  const raw = [];
  for (let p = 0; p < PASSES; p++) {
    if (p === 2 && sig(raw[0].s) === sig(raw[1].s)) { skipped3++; break; }
    raw.push({ s: await search(kw, wh), a: await autocomplete(kw, wh) });
  }
  cache.set(key, raw); return raw;
}
// canary: if Rohlik changes its API, fail loudly instead of recording "not found" everywhere
async function canary(cfg) {
  const c = cfg.canary || { query: cfg.brand_match, min_results: 5, must_find: cfg.target_sku };
  const s = await search(c.query, cfg.warehouse_id), list = s.productList ?? [];
  if ((s.totalHits ?? 0) < c.min_results || !list.some(x => x.productId === c.must_find && x.productName))
    throw new Error(`CANARY FAILED for ${cfg.label}: "${c.query}" returned ${s.totalHits ?? 0} results / target ${c.must_find} ${list.some(x => x.productId === c.must_find) ? 'found' : 'NOT found'} — Rohlik API may have changed`);
  console.log(`canary ok: "${c.query}" ${s.totalHits} results, target found`);
}

async function runConfig(name, cfg) {
  const wh = cfg.warehouse_id, token = cfg.brand_match.toLowerCase();
  const exclude = new Set(cfg.brand_exclude_ids || []);
  const ownIds = new Set([cfg.target_sku, ...cfg.controls.map(c => c.id)]);
  const brandIds = new Set(ownIds);               // every product id seen that belongs to the client brand
  const brandOf = p => (p.brand || '').trim() || NOBRAND;
  const isClient = p => !exclude.has(p.productId) && (ownIds.has(p.productId) || (p.brand || '').toLowerCase().includes(token)
    || new RegExp(`(^|[^a-zá-ž])${token}([^a-zá-ž]|$)`, 'i').test(p.productName || ''));
  const groupOf = Object.fromEntries(Object.entries(cfg.keywords).flatMap(([g, ks]) => ks.map(k => [k, g])));
  const allKw = Object.keys(groupOf);

  // ---- per keyword: 3 passes of search + autocomplete
  const rows = [], brandAcc = {};
  for (const kw of allKw) {
    const raw = await measureRaw(kw, wh);
    const P = [];
    for (const { s, a } of raw) {
      const list = s.productList ?? [];
      list.filter(isClient).forEach(x => brandIds.add(x.productId));
      const organic = list.filter(x => x.productPromotionType !== 'SPONSORED');
      const ads = list.filter(x => x.productPromotionType === 'SPONSORED');
      const rankOf = id => { const i = organic.findIndex(x => x.productId === id); return i < 0 || i >= TOP ? 0 : i + 1; };
      const w = {}; let wsum = 0;
      organic.slice(0, 30).forEach((x, i) => { const b = isClient(x) ? cfg.client : brandOf(x); w[b] = (w[b] || 0) + W(i + 1); wsum += W(i + 1); });
      Object.keys(w).forEach(b => w[b] /= wsum || 1);
      const acIds = a.productIds || [], sugg = (a.suggestions || []).map(x => typeof x === 'string' ? x : (x.text ?? x.name ?? ''));
      P.push({ hits: s.totalHits ?? 0, target: rankOf(cfg.target_sku), controls: cfg.controls.map(c => rankOf(c.id)),
        sos10: organic.slice(0, 10).filter(isClient).length / 10, w, ads: ads.length, firstAd: ads[0] || null,
        adBrands: [...new Set(ads.map(x => isClient(x) ? cfg.client : brandOf(x)))],
        acIds, acSug: sugg.some(t => t.toLowerCase().includes(token)), item: list.find(x => x.productId === cfg.target_sku) || null });
    }
    const brands = {}; P.forEach(p => Object.entries(p.w).forEach(([b, v]) => brands[b] = (brands[b] || 0) + v / P.length));
    const comp = Object.entries(brands).filter(([b]) => b !== cfg.client && b !== NOBRAND).sort((x, y) => y[1] - x[1]);
    const rankMed = c => { const v = P.map(c); const m = median(v.map(x => x || 999)); return m === 999 ? 0 : m; };
    const rank = rankMed(p => p.target);
    const item = P.map(p => p.item).find(Boolean), saleTypes = new Set((item?.sales || []).map(x => x.type));
    const fa = P.map(p => p.firstAd).find(Boolean);
    const row = {
      date: today, run: RUN, keyword: kw, group: groupOf[kw], results: median(P.map(p => p.hits)),
      rank, top10: rank && rank <= 10 ? 1 : 0, top30: rank && rank <= 30 ? 1 : 0, top100: rank ? 1 : 0,
      sos10: r3(median(P.map(p => p.sos10))), wsos30: r3(brands[cfg.client] || 0),
      top_competitor: comp[0]?.[0] || '', top_competitor_share: comp[0] ? r3(comp[0][1]) : '',
      competitors: comp.slice(0, 5).map(([b, v]) => `${b}:${r3(v)}`).join('|'),
      ads: median(P.map(p => p.ads)), first_ad: fa ? fa.productName.slice(0, 70) : '', first_ad_brand: fa ? (isClient(fa) ? cfg.client : brandOf(fa)) : '',
      ad_brands: [...new Set(P.flatMap(p => p.adBrands))].join('|'),
      ac_tile: P.filter(p => p.acIds.some(id => brandIds.has(id))).length >= 2 ? 1 : 0,
      ac_target: P.filter(p => p.acIds.includes(cfg.target_sku)).length >= 2 ? 1 : 0,
      ac_sug: P.filter(p => p.acSug).length >= 2 ? 1 : 0,
      low_results: median(P.map(p => p.hits)) < 20 ? 1 : 0,
      in_stock: item ? (item.inStock ? 1 : 0) : '',
      on_sale: [...saleTypes].some(t => ['sale', 'longtermAction', 'expiration', 'groupDiscount'].includes(t)) ? 1 : 0,
      multipack: saleTypes.has('multipack') ? 1 : 0,
    };
    cfg.controls.forEach((c, i) => row[`control_${c.id}`] = rankMed(p => p.controls[i]));
    rows.push(row);
    if (row.group !== 'competitor') Object.entries(brands).forEach(([b, v]) => brandAcc[b] = (brandAcc[b] || 0) + v);
    console.log(`${name} | ${kw.padEnd(28)} | rank ${String(rank || '–').padStart(3)} | hits ${row.results} | sos10 ${row.sos10} | w30 ${row.wsos30}`);
  }

  // ---- brand share across current + recommended keywords
  const core = rows.filter(r => r.group !== 'competitor');
  const brandRows = Object.entries(brandAcc).filter(([b]) => b !== NOBRAND).map(([b, v]) => ({ date: today, run: RUN, brand: b, is_client: b === cfg.client ? 1 : 0, wsos30: r3(v / core.length) }))
    .sort((x, y) => y.wsos30 - x.wsos30).slice(0, 12);

  // ---- prefix test: from which typed character autocomplete offers the brand (1 pass)
  const prefixRows = [];
  for (const term of cfg.head_terms) {
    let phrase = 0, tile = 0, ad = 0;
    for (let n = 1; n <= term.length && !(phrase && tile && ad); n++) {
      if (term[n - 1] === ' ') continue;
      const a = await autocomplete(term.slice(0, n), wh);
      const ids = a.productIds || [], imp = (a.impressions || []).map(x => x.productId ?? x.id ?? x);
      const sug = (a.suggestions || []).map(x => typeof x === 'string' ? x : (x.text ?? x.name ?? ''));
      if (!phrase && sug.some(t => t.toLowerCase().includes(token))) phrase = n;
      if (!tile && ids.some(id => brandIds.has(id))) tile = n;
      if (!ad && imp.some(id => brandIds.has(id))) ad = n;
    }
    const from = [phrase, tile].filter(Boolean).length ? Math.min(...[phrase, tile].filter(Boolean)) : 0;
    prefixRows.push({ date: today, run: RUN, term, from_char: from, term_length: term.length, phrase_from: phrase, tile_from: tile, ad_from: ad });
    console.log(`${name} | prefix ${term.padEnd(22)} | from ${from || '–'}`);
  }
  return { rows, brandRows, prefixRows };
}

// ---------- summary for the issue/email (compact, < 60k chars)
function summary(cfg, name, rows, brandRows, prefixRows, prevRows) {
  const runKey = r => `${r.date} run ${r.run}`;
  const runs = [...new Set(prevRows.map(runKey))];
  const pick = k => Object.fromEntries(prevRows.filter(r => runKey(r) === k).map(r => [r.keyword, r]));
  const prev = runs.length ? pick(runs.at(-1)) : {}, base = runs.length ? pick(runs[0]) : {};
  const rec = rows.filter(r => r.group === 'recommended'), core = rows.filter(r => r.group !== 'competitor');
  const avg = f => r3(mean(core.map(r => Number(r[f]) || 0)));
  const ctl = cfg.controls.map(c => `control_${c.id}`);
  const head = ['keyword', 'group', 'results', 'rank', 'rank_prev', 'rank_base', ...ctl, 'sos10', 'sos10_prev', 'wsos30', 'wsos30_prev',
    'top_competitor', 'top_competitor_share', 'competitors', 'ads', 'first_ad_brand', 'first_ad', 'ad_brands', 'ac_tile', 'ac_target', 'ac_sug', 'low_results', 'in_stock', 'on_sale', 'multipack'];
  const kwLines = rows.map(r => head.map(h => h === 'rank_prev' ? (prev[r.keyword]?.rank ?? '') : h === 'rank_base' ? (base[r.keyword]?.rank ?? '')
    : h === 'sos10_prev' ? (prev[r.keyword]?.sos10 ?? '') : h === 'wsos30_prev' ? (prev[r.keyword]?.wsos30 ?? '') : r[h]).map(csv).join(','));
  const out = [
    `## ${cfg.label} (SKU ${cfg.target_sku}) · ${today} · warehouse ${cfg.warehouse_id} · run ${RUN}`,
    `Recommended visible ${rec.filter(r => r.top100).length}/${rec.length} · top30 ${rec.filter(r => r.top30).length} · top10 ${rec.filter(r => r.top10).length} · ` +
    `brand sos10 ${avg('sos10')} · brand wsos30 ${avg('wsos30')} · ac tile ${core.filter(r => r.ac_tile).length}/${core.length} · ac phrase ${core.filter(r => r.ac_sug).length}/${core.length} · requests ${calls} (3rd pass skipped ${skipped3}×, shared keywords reused)`,
    `Previous: ${runs.at(-1) || 'none (baseline)'} · Baseline: ${runs[0] || 'this run'}`,
    '', '```csv', head.join(','), ...kwLines, '```',
    '', '```csv', 'brand,is_client,wsos30', ...brandRows.map(b => [b.brand, b.is_client, b.wsos30].map(csv).join(',')), '```',
    '', '```csv', 'term,from_char,term_length,phrase_from,tile_from,ad_from', ...prefixRows.map(p => [p.term, p.from_char, p.term_length, p.phrase_from, p.tile_from, p.ad_from].map(csv).join(',')), '```',
  ].join('\n');
  if (out.length <= 60000) writeFileSync(`out/summary_${name}.md`, out);
  else { // too long for one email: split the keyword table, every part keeps the header lines
    const top = out.split('\n').slice(0, 3).join('\n'), tail = out.slice(out.indexOf('```csv\nbrand,'));
    const parts = []; let cur = [];
    for (const l of kwLines) { if ((cur.join('\n').length + l.length) > 50000) { parts.push(cur); cur = []; } cur.push(l); } parts.push(cur);
    parts.forEach((p, i) => writeFileSync(`out/summary_${name}${i ? '-part' + (i + 1) : ''}.md`,
      [top, `Part ${i + 1}/${parts.length}`, '', '```csv', head.join(','), ...p, '```', ...(i === parts.length - 1 ? ['', tail] : [])].join('\n')));
  }
  console.log(`summary ${name}: ${out.length} chars`);
}

mkdirSync('history', { recursive: true }); mkdirSync('out', { recursive: true });
const configs = readdirSync('config').filter(f => f.endsWith('.json')).map(f => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(`config/${f}`, 'utf8'))])
  .filter(([n, c]) => { if (c.active === false || !c.controls) { console.log(`skip ${n}`); return false; } return true; });
configs.forEach(([, c]) => [c.target_sku, ...c.controls.map(x => x.id)].forEach(id => tracked.add(id)));
for (const [, cfg] of configs) await canary(cfg);
for (const [name, cfg] of configs) {
  const kp = `history/${name}_keywords.csv`;
  const prevRows = existsSync(kp) ? parseCsv(readFileSync(kp, 'utf8')) : [];
  const { rows, brandRows, prefixRows } = await runConfig(name, cfg);
  const kcols = ['date', 'run', 'keyword', 'group', 'results', 'rank', ...cfg.controls.map(c => `control_${c.id}`), 'top10', 'top30', 'top100', 'sos10', 'wsos30',
    'top_competitor', 'top_competitor_share', 'competitors', 'ads', 'first_ad_brand', 'first_ad', 'ad_brands', 'ac_tile', 'ac_target', 'ac_sug', 'low_results', 'in_stock', 'on_sale', 'multipack'];
  appendCsv(kp, kcols, rows);
  appendCsv(`history/${name}_brands.csv`, ['date', 'run', 'brand', 'is_client', 'wsos30'], brandRows);
  appendCsv(`history/${name}_prefixes.csv`, ['date', 'run', 'term', 'from_char', 'term_length', 'phrase_from', 'tile_from', 'ad_from'], prefixRows);
  summary(cfg, name, rows, brandRows, prefixRows, prevRows);
}
