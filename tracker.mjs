// Rohlik keyword tracker. Reads every config/*.json, measures anonymously (3 passes, pinned warehouse),
// appends to history/*.csv and writes out/summary_<config>.md for the GitHub issue (= email to work inbox).
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';

const PASSES = 3;
const GAP_MS = Number(process.env.GAP_MS ?? 1200); // polite spacing between requests
const LIMIT = 200;              // results fetched per query
const NOT_FOUND = 999;
const BASE = 'https://www.rohlik.cz/services/frontend-service';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept': 'application/json', 'Accept-Language': 'cs-CZ,cs;q=0.9', 'Referer': 'https://www.rohlik.cz/',
};
const HIST_COLS = ['date','run','client','sku','role','keyword','group','rank_med','rank_p1','rank_p2','rank_p3','found','bucket',
  'hits','sos_top10','sponsored_top','in_autocomplete','in_stock','on_sale','multipack'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' }); // YYYY-MM-DD
const RUN = process.env.GITHUB_RUN_NUMBER || 'local';
const median = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const csv = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const bucket = r => r === NOT_FOUND ? 'not_found' : r <= 10 ? 'top10' : r <= 30 ? '11-30' : '31+';

async function getJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.json();
      console.log(`HTTP ${res.status} (try ${i}) ${url.split('?')[0]}`);
    } catch (e) { console.log(`ERR ${e} (try ${i})`); }
    await sleep(5000 * i);
  }
  throw new Error('Rohlik request failed 3x — stopping so no partial week is recorded');
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows; return body.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

async function measureKeyword(kw, cfg) {
  const passes = [];
  for (let p = 0; p < PASSES; p++) {
    const q = encodeURIComponent(kw);
    const s = (await getJson(`${BASE}/search-metadata?search=${q}&offset=0&limit=${LIMIT}&companyId=1&warehouseId=${cfg.warehouse_id}`)).data ?? {};
    await sleep(GAP_MS);
    const a = await getJson(`${BASE}/autocomplete?search=${q}&referer=whisperer&companyId=1&warehouseId=${cfg.warehouse_id}`);
    await sleep(GAP_MS);
    const list = s.productList ?? [];
    const organic = list.filter(x => x.productPromotionType !== 'SPONSORED');
    const rankOf = id => { const i = organic.findIndex(x => x.productId === id); return i < 0 ? NOT_FOUND : i + 1; };
    const sp = list.find(x => x.productPromotionType === 'SPONSORED');
    const ad = a.data ?? a;
    passes.push({
      hits: s.totalHits ?? 0,
      target: rankOf(cfg.target_sku), control: cfg.control_sku ? rankOf(cfg.control_sku) : null,
      sos: organic.slice(0, 10).filter(x => (x.productName || '').toLowerCase().includes(cfg.brand_token)).length,
      sponsoredTop: sp ? sp.productName : '',
      item: list.find(x => x.productId === cfg.target_sku) || null,
      inAc: (ad.productIds || []).includes(cfg.target_sku),
      suggestions: (ad.suggestions || []).map(x => typeof x === 'string' ? x : (x.text ?? x.name ?? '')).filter(Boolean),
    });
  }
  return passes;
}

function rowFor(role, sku, kw, group, cfg, passes, key) {
  const ranks = passes.map(p => p[key]);
  const med = median(ranks);
  const item = passes.map(p => p.item).find(Boolean);
  const saleTypes = new Set((item?.sales || []).map(s => s.type));
  return {
    date: today, run: RUN, client: cfg.client, sku, role, keyword: kw, group,
    rank_med: med === NOT_FOUND ? '' : med, rank_p1: ranks[0] === NOT_FOUND ? '' : ranks[0],
    rank_p2: ranks[1] === NOT_FOUND ? '' : ranks[1], rank_p3: ranks[2] === NOT_FOUND ? '' : ranks[2],
    found: med === NOT_FOUND ? 0 : 1, bucket: bucket(med),
    hits: median(passes.map(p => p.hits)), sos_top10: median(passes.map(p => p.sos)),
    sponsored_top: passes.map(p => p.sponsoredTop).find(Boolean) || '',
    in_autocomplete: role === 'target' ? (passes.filter(p => p.inAc).length >= 2 ? 1 : 0) : '',
    in_stock: role === 'target' ? (item ? (item.inStock ? 1 : 0) : '') : '',
    on_sale: role === 'target' ? ([...saleTypes].some(t => ['sale', 'longtermAction', 'expiration', 'groupDiscount'].includes(t)) ? 1 : 0) : '',
    multipack: role === 'target' ? (saleTypes.has('multipack') ? 1 : 0) : '',
  };
}

function summarize(cfg, name, rows, prevHist, newSugg) {
  const t = rows.filter(r => r.role === 'target');
  // earlier runs in file order: previous = last earlier run, baseline = first run ever
  const runKey = r => `${r.date} run ${r.run}`;
  const runs = [...new Set(prevHist.filter(r => r.client === cfg.client && r.role === 'target').map(runKey))];
  const prevDate = runs.at(-1), baseDate = runs[0];
  const lookup = k => Object.fromEntries(prevHist.filter(r => runKey(r) === k && r.role === 'target' && r.client === cfg.client).map(r => [r.keyword, r.rank_med]));
  const prev = prevDate ? lookup(prevDate) : {}, base = baseDate ? lookup(baseDate) : {};
  const fmt = v => v === '' || v === undefined ? '–' : v;
  const delta = (now, then) => (now === '' || then === '' || then === undefined) ? '' : (Number(then) - Number(now)); // + = improved
  const by = b => t.filter(r => r.bucket === b).length;
  const lines = [
    `## ${cfg.label} (SKU ${cfg.target_sku}) · ${today} · warehouse ${cfg.warehouse_id} · run ${RUN}`,
    `Found on ${t.filter(r => r.found).length}/${t.length} keywords · top10 ${by('top10')} · 11–30 ${by('11-30')} · 31+ ${by('31+')} · not found ${by('not_found')}`,
    `Previous run: ${prevDate || 'none (this is the baseline)'} · Baseline: ${baseDate || today}`,
    '', '```csv',
    'keyword,group,rank,prev,base,chg_vs_prev,bucket,hits,sos_top10,in_autocomplete,in_stock,on_sale,multipack,control_rank,sponsored_top',
    ...t.map(r => {
      const c = rows.find(x => x.role === 'control' && x.keyword === r.keyword);
      return [r.keyword, r.group, fmt(r.rank_med), fmt(prev[r.keyword]), fmt(base[r.keyword]), delta(r.rank_med, prev[r.keyword]),
        r.bucket, r.hits, r.sos_top10, r.in_autocomplete, r.in_stock, r.on_sale, r.multipack, c ? fmt(c.rank_med) : '', r.sponsored_top].map(csv).join(',');
    }),
    '```', '',
    newSugg.length ? `New autocomplete suggestions (not in keyword list, first time seen): ${newSugg.join(' · ')}` : 'No new autocomplete suggestions.',
  ];
  writeFileSync(`out/summary_${name}.md`, lines.join('\n'));
}

mkdirSync('history', { recursive: true }); mkdirSync('out', { recursive: true });
for (const file of readdirSync('config').filter(f => f.endsWith('.json'))) {
  const name = file.replace(/\.json$/, '');
  const cfg = JSON.parse(readFileSync(`config/${file}`, 'utf8'));
  const histPath = `history/${name}.csv`, suggPath = `history/${name}_suggestions.csv`;
  const prevHist = existsSync(histPath) ? parseCsv(readFileSync(histPath, 'utf8')) : [];
  const seenSugg = new Set(existsSync(suggPath) ? parseCsv(readFileSync(suggPath, 'utf8')).map(r => r.suggestion) : []);
  const allKw = Object.values(cfg.keywords).flat();
  const rows = [], suggNow = new Set();
  for (const [group, kws] of Object.entries(cfg.keywords)) for (const kw of kws) {
    const passes = await measureKeyword(kw, cfg);
    rows.push(rowFor('target', cfg.target_sku, kw, group, cfg, passes, 'target'));
    if (cfg.control_sku) rows.push(rowFor('control', cfg.control_sku, kw, group, cfg, passes, 'control'));
    passes.forEach(p => p.suggestions.forEach(s => suggNow.add(s.toLowerCase())));
    const r = rows.at(cfg.control_sku ? -2 : -1);
    console.log(`${name} | ${kw.padEnd(22)} | rank ${String(r.rank_med || '–').padStart(3)} | hits ${r.hits} | sos ${r.sos_top10}`);
  }
  if (!existsSync(histPath)) writeFileSync(histPath, HIST_COLS.join(',') + '\n');
  appendFileSync(histPath, rows.map(r => HIST_COLS.map(c => csv(r[c])).join(',')).join('\n') + '\n');
  const newSugg = [...suggNow].filter(s => !allKw.includes(s) && !seenSugg.has(s)).sort();
  if (!existsSync(suggPath)) writeFileSync(suggPath, 'date,client,suggestion\n');
  if (newSugg.length) appendFileSync(suggPath, newSugg.map(s => [today, cfg.client, s].map(csv).join(',')).join('\n') + '\n');
  summarize(cfg, name, rows, prevHist, newSugg);
}
