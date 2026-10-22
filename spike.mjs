// Rohlik feasibility spike: can a GitHub Actions runner read Rohlik search like Chrome does?
// ~30 polite requests total, 1.5 s apart. Output: result.json (+ printed summary).
import { writeFileSync } from 'node:fs';

const KEYWORDS = ['birell', 'nealkoholické pivo', 'nealko pivo', 'pivo', 'energetický nápoj'];
const BRAND = 'birell';
const PASSES = 3;
const BASE = 'https://www.rohlik.cz/services/frontend-service';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'cs-CZ,cs;q=0.9',
  'Referer': 'https://www.rohlik.cz/',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  const t = Date.now();
  try {
    const res = await fetch(url, { headers: HEADERS });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return {
      status: res.status, ms: Date.now() - t, json,
      server: res.headers.get('server'), cfRay: res.headers.get('cf-ray'),
      snippet: json ? null : text.slice(0, 300),
    };
  } catch (e) { return { status: 0, ms: Date.now() - t, error: String(e) }; }
}

const out = { runAt: new Date().toISOString(), runner: null, passes: [] };

// Where is this runner? (matters for Rohlik's default zone)
try { out.runner = await (await fetch('https://ipinfo.io/json')).json(); } catch (e) { out.runner = { error: String(e) }; }

for (let p = 1; p <= PASSES; p++) {
  const pass = { pass: p, keywords: [] };
  for (const kw of KEYWORDS) {
    const q = encodeURIComponent(kw);
    const s = await get(`${BASE}/search-metadata?search=${q}&offset=0&limit=100&companyId=1`);
    await sleep(1500);
    const a = await get(`${BASE}/autocomplete?search=${q}&referer=whisperer&companyId=1`);
    await sleep(1500);

    const d = s.json?.data ?? s.json ?? {};
    const list = d.productList ?? [];
    const organic = list.filter(x => x.productPromotionType !== 'SPONSORED');
    const brandRanks = organic
      .map((x, i) => ({ rank: i + 1, id: x.productId, name: x.productName }))
      .filter(x => (x.name || '').toLowerCase().includes(BRAND));

    pass.keywords.push({
      keyword: kw,
      search: { status: s.status, ms: s.ms, server: s.server, cfRay: s.cfRay, snippet: s.snippet, error: s.error,
                totalHits: d.totalHits, returned: list.length, sponsored: list.length - organic.length,
                top10: organic.slice(0, 10).map(x => `${x.productId} ${x.productName}`), brandRanks },
      autocomplete: { status: a.status, ms: a.ms, snippet: a.snippet, error: a.error,
                      suggestions: (a.json?.suggestions ?? a.json?.data?.suggestions ?? []).map(x => x.text ?? x.name ?? x),
                      productIds: a.json?.productIds ?? a.json?.data?.productIds ?? [] },
    });
  }
  out.passes.push(pass);
}

writeFileSync('result.json', JSON.stringify(out, null, 2));

// Short human summary in the Actions log
console.log(`Runner: ${out.runner?.city}, ${out.runner?.country} (${out.runner?.org})`);
for (const p of out.passes) for (const k of p.keywords) {
  const s = k.search;
  console.log(`pass ${p.pass} | ${k.keyword.padEnd(20)} | search ${s.status} hits=${s.totalHits ?? '-'} ` +
    `birell ranks=[${s.brandRanks.map(b => b.rank).join(',')}] | autocomplete ${k.autocomplete.status} ` +
    `sugg=${k.autocomplete.suggestions.length}${s.snippet ? ' | BODY: ' + s.snippet.replace(/\s+/g, ' ').slice(0, 120) : ''}`);
}
