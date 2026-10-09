// Builds site/market.json for the Cüzdan app: TCMB FX selling rates (+ ~30-day history) and gram gold.
// Gram gold = MetalCharts XAU spot (USD/troy oz) ÷ 31.1034768 × TCMB USD selling rate. Only the derived TL/gram
// price is published, never the raw MetalCharts quote. Past days the chart has no point for are backfilled once
// from TCMB EVDS (Borsa İstanbul gold close). Runs on GitHub Actions; keys come from the METALCHARTS_KEY and
// EVDS_KEY secrets and never leave this job. No dependencies – Node 20+.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const OUT = "site/market.json";
const KEEP = 40;                                // history points kept per series (the app shows ~30 days)
const LOOKBACK = 45;                            // calendar days scanned for missing TCMB bulletins
const TROY_OZ_G = 31.1034768;
const GOLD_SERIES = "TP.ALTINPIYASA.KAP02";     // BİST gold closing price, TL/kg, business days (backfill only)
const CPI_SERIES = "TP.GENENDEKS.T1";           // TÜİK CPI, general index (2003=100), monthly – "beat inflation?" card
const CPI_FROM = "01-01-2003";
const DEP_SERIES = "TP.TRYTAS.MT01";            // TL savings deposits up to 1 month, weighted avg annual rate (%), weekly (flow)
const MC_KEY = process.env.METALCHARTS_KEY || "";
const KEY = process.env.EVDS_KEY || "";

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
// Turkey is UTC+3 all year; the runner clock is UTC
const trToday = () => { const d = new Date(Date.now() + 3 * 36e5); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };
const isoFromTR = (s) => { const m = String(s || "").match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/); return m ? `${m[3]}-${pad(+m[2])}-${pad(+m[1])}` : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with retries; null on 404 (no bulletin that day). */
async function get(url, headers = {}) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      if (i >= 3) throw new Error(`${url.split("?")[0]}: ${e.message}`);
      await sleep(2000 * i);
    }
  }
}

/** One TCMB bulletin – today's, or a past day's from the archive. null when there is none (weekend, holiday). */
async function tcmb(day) {
  const path = day ? `${day.getUTCFullYear()}${pad(day.getUTCMonth() + 1)}/${pad(day.getUTCDate())}${pad(day.getUTCMonth() + 1)}${day.getUTCFullYear()}` : "today";
  const r = await get(`https://www.tcmb.gov.tr/kurlar/${path}.xml`);
  if (!r) return null;
  const xml = await r.text();
  const date = isoFromTR((xml.match(/<Tarih_Date[^>]*\bTarih="([^"]+)"/) || [])[1]) || (day && iso(day));
  const rates = {};
  for (const k of ["USD", "EUR", "GBP"]) {
    const block = (xml.match(new RegExp(`<Currency[^>]*CurrencyCode="${k}"[^>]*>([\\s\\S]*?)</Currency>`)) || [])[1];
    if (!block) continue;
    const unit = parseFloat((block.match(/<Unit>([^<]*)</) || [])[1]) || 1;
    const v = parseFloat((block.match(/<ForexSelling>([^<]*)</) || [])[1]);
    if (v > 0) rates[k] = Math.round((v / unit) * 10000) / 10000;
  }
  if (!rates.USD || !rates.EUR || !date) throw new Error(`TCMB ${path}: rates missing`);
  return { date, rates };
}

/** Live XAU spot from MetalCharts (free plan: 200 calls/month – one call per run). */
async function spotGold() {
  const r = await get("https://api.metalcharts.org/v1/prices", { Authorization: `Bearer ${MC_KEY}` });
  if (!r) throw new Error("MetalCharts: 404");
  const left = r.headers.get("x-ratelimit-month-remaining");
  if (left !== null) console.log(`MetalCharts calls left this month: ${left}`);
  const x = (((await r.json()) || {}).data || {}).XAU || {};
  if (!(x.price > 0) || x.stale) throw new Error("MetalCharts: no fresh XAU price");
  return { usdPerOz: x.price, at: x.timestamp };
}

/** Gram gold (TL) per business day, oldest first: [{d,p}] */
async function gold(from, to) {
  const dash = (d) => `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
  const r = await get(`https://evds3.tcmb.gov.tr/igmevdsms-dis/series=${GOLD_SERIES}&startDate=${dash(from)}&endDate=${dash(to)}&type=json`, { key: KEY });
  if (!r) throw new Error("EVDS: 404");
  const field = GOLD_SERIES.replace(/\./g, "_"), out = [];
  for (const it of (await r.json()).items || []) {
    const d = isoFromTR(it.Tarih), kg = parseFloat(it[field]);
    if (d && kg > 0) out.push({ d, p: Math.round(kg / 10) / 100 });   // TL/kg → TL/gr
  }
  if (!out.length) throw new Error("EVDS: no gold data");
  return out.sort((a, b) => (a.d < b.d ? -1 : 1));
}

/** Whole CPI history, oldest first: [["2003-01", 100.0], …] (one EVDS call; ~290 points) */
async function cpi(to) {
  const dash = (d) => `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
  const r = await get(`https://evds3.tcmb.gov.tr/igmevdsms-dis/series=${CPI_SERIES}&startDate=${CPI_FROM}&endDate=${dash(to)}&type=json`, { key: KEY });
  if (!r) throw new Error("EVDS CPI: 404");
  const field = CPI_SERIES.replace(/\./g, "_"), out = [];
  for (const it of (await r.json()).items || []) {
    const m = String(it.Tarih || "").match(/^(\d{4})-(\d{1,2})$/), v = parseFloat(it[field]);
    if (m && v > 0) out.push([`${m[1]}-${pad(+m[2])}`, Math.round(v * 100) / 100]);
  }
  if (out.length < 100) throw new Error("EVDS CPI: too few points");
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Growth of 1 TL kept in a 1-month deposit renewed every 4 weeks at the then-average rate, before withholding tax. */
async function depositGrowth(from, to) {
  const dash = (d) => `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
  const r = await get(`https://evds3.tcmb.gov.tr/igmevdsms-dis/series=${DEP_SERIES}&startDate=${dash(from)}&endDate=${dash(to)}&type=json`, { key: KEY });
  if (!r) throw new Error("EVDS deposit: 404");
  const field = DEP_SERIES.replace(/\./g, "_");
  const w = ((await r.json()).items || []).map((it) => parseFloat(it[field])).filter((v) => v > 0 && v < 200);
  if (w.length < 40) throw new Error("EVDS deposit: too few weeks");
  const weeks = Math.min(w.length, 52), rates = w.slice(-weeks);
  let g = 1;
  for (let i = 0; i < weeks; i += 4) g *= 1 + (rates[i] / 100) * (Math.min(4, weeks - i) * 7) / 365;
  return { growth: Math.round(g * 10000) / 10000, avg: Math.round((rates.reduce((s, v) => s + v, 0) / weeks) * 100) / 100 };
}

const prev = await readFile(OUT, "utf8").then(JSON.parse).catch(() => ({}));
const FX = ["USD", "EUR", "GBP"];
const hist = { USD: [], EUR: [], GBP: [], GAU: [], ...(prev.hist || {}) };
const T = trToday(), oldest = iso(addDays(T, -LOOKBACK));
const gaps = new Set((prev.gaps || []).filter((d) => d >= oldest));
const put = (k, d, p) => { hist[k] = [...hist[k].filter((e) => e.d !== d), { d, p }].sort((a, b) => (a.d < b.d ? -1 : 1)).slice(-KEEP); };

// today's bulletin is required – without it the job fails and the published file stays as it was
const today = await tcmb();
const rates = { ...(prev.rates || {}), ...today.rates };
for (const k of FX) if (today.rates[k]) put(k, today.date, today.rates[k]);

// archive days still missing from the chart (weekdays only; 404 = holiday, remembered in gaps).
// Checked against the newest series (GBP) so a series added later is backfilled too.
const have = new Set(hist.GBP.map((e) => e.d));
for (let i = 1; i <= LOOKBACK; i++) {
  const d = addDays(T, -i), k = iso(d);
  if (d.getUTCDay() % 6 === 0 || have.has(k) || gaps.has(k)) continue;
  const b = await tcmb(d);
  if (!b) gaps.add(k); else for (const c of FX) if (b.rates[c]) put(c, b.date, b.rates[c]);
  await sleep(300);
}

// gram gold now: spot × today's TCMB dollar; one chart point per (Turkish) day, the latest run of the day wins
let goldDate = prev.goldDate || null, goldAt = prev.goldAt || null;
if (!MC_KEY) console.log("::warning::METALCHARTS_KEY secret is not set – gold is not updated");
else {
  try {
    const s = await spotGold();
    const p = Math.round((s.usdPerOz / TROY_OZ_G) * rates.USD * 100) / 100;
    goldAt = s.at && !isNaN(Date.parse(s.at)) ? s.at : new Date().toISOString();
    goldDate = iso(new Date(Date.parse(goldAt) + 3 * 36e5));   // Turkish date of the quote, not of the run
    rates.GAU = p;
    put("GAU", goldDate, p);
  } catch (e) { console.log(`::warning::${e.message}`); }   // keep the last known gold price
}
// backfill older chart days from EVDS while the chart is short (never overwrites a computed point)
if (KEY && hist.GAU.length < 25) {
  try {
    const have = new Set(hist.GAU.map((e) => e.d));
    for (const e of await gold(addDays(T, -LOOKBACK), T)) if (!have.has(e.d)) put("GAU", e.d, e.p);
    if (!goldDate) { const last = hist.GAU[hist.GAU.length - 1]; rates.GAU = last.p; goldDate = last.d; }
  } catch (e) { console.log(`::warning::${e.message}`); }
}

// CPI is published once a month: re-read at most once a (Turkish) day, keep the last good copy on failure
let cpiData = prev.cpi || null;
if (KEY && (!cpiData || cpiData.checked !== iso(T))) {
  try { cpiData = { series: CPI_SERIES, base: "2003=100", checked: iso(T), m: await cpi(T) }; }
  catch (e) { console.log(`::warning::${e.message}`); }
}

// prices one year ago, for the "last 12 months vs inflation" card: the TCMB bulletin on (or the last one before) the same
// date last year, and the BİST gold close of that day from EVDS. Looked up once per (Turkish) day.
let yearAgo = prev.yearAgo || null;
const yaDay = addDays(T, -365);
if (!yearAgo || yearAgo.asOf !== iso(T) || (KEY && !yearAgo.TRYDEP)) {
  try {
    let b = null;
    for (let i = 0; i < 10 && !b; i++) { b = await tcmb(addDays(yaDay, -i)); if (!b) await sleep(300); }
    if (!b) throw new Error("no TCMB bulletin around " + iso(yaDay));
    const ya = { asOf: iso(T), d: b.date, USD: b.rates.USD, EUR: b.rates.EUR, GBP: b.rates.GBP };
    // BİST's daily gold close is jumpy (±5 % day to day), so the median of the last 5 closes is used
    if (KEY) {
      const g = (await gold(addDays(yaDay, -14), yaDay)).filter((e) => e.d <= b.date).slice(-5);
      if (g.length) { const s = g.map((e) => e.p).sort((x, y) => x - y); ya.GAU = s[Math.floor(s.length / 2)]; ya.goldDate = g[g.length - 1].d; }
      try { const dg = await depositGrowth(yaDay, T); ya.TRYDEP = dg.growth; ya.depAvg = dg.avg; }
      catch (e) { console.log(`::warning::${e.message}`); }
    }
    yearAgo = ya;
  } catch (e) { console.log(`::warning::year-ago prices: ${e.message}`); }
}

const feed = {
  v: 1,
  updated: new Date().toISOString(),
  tcmbDate: today.date,
  goldDate,
  goldAt,
  rates,
  hist,
  gaps: [...gaps].sort(),
  ...(cpiData ? { cpi: cpiData } : {}),
  ...(yearAgo ? { yearAgo } : {}),
  source: "Döviz: TCMB gösterge niteliğindeki döviz satış kuru. Gram altın: MetalCharts ons spot fiyatı ÷ 31,1035 × TCMB dolar satış kuru (yaklaşık); eski günler TCMB EVDS, Borsa İstanbul altın kapanışı. Enflasyon: TÜİK Tüketici Fiyat Endeksi (2003=100), TCMB EVDS.",
  credit: { text: "Metal prices by MetalCharts", url: "https://metalcharts.org" },
};
const same = JSON.stringify({ ...prev, updated: 0 }) === JSON.stringify({ ...feed, updated: 0 });
if (same) console.log("No change.");
else {
  await mkdir("site", { recursive: true });
  await writeFile(OUT, JSON.stringify(feed, null, 1) + "\n");
  console.log(`Written: TCMB ${feed.tcmbDate} USD ${rates.USD} EUR ${rates.EUR} · gold ${goldDate} ${rates.GAU} TL/gr · ${hist.USD.length} days`);
}
