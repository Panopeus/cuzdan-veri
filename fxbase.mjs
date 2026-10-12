// Inflation and interest data for the dollar and euro versions of the app's "a year ago" card. All sources are public,
// keyless and free to reuse: US CPI from the Bureau of Labor Statistics (public domain), US Treasury daily bill rates
// (public domain), euro-area HICP (Eurostat) and euro-area bank deposit rates from the ECB Data Portal (reuse with
// source attribution). Each call is made at most once a day by fetch.mjs.

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

async function text(url) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "akce-market-feed (github.com/Panopeus/cuzdan-veri)" }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (i >= 3) throw new Error(`${url.split("?")[0]}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

/** ECB Data Portal series as [["YYYY-MM", value], …] oldest first (csv, data columns only) */
async function ecb(key, from) {
  const csv = await text(`https://data-api.ecb.europa.eu/service/data/${key}?format=csvdata&detail=dataonly&startPeriod=${from}`);
  const [head, ...rows] = csv.trim().split(/\r?\n/);
  const cols = head.split(","), ti = cols.indexOf("TIME_PERIOD"), vi = cols.indexOf("OBS_VALUE");
  if (ti < 0 || vi < 0) throw new Error(`ECB ${key}: unexpected columns`);
  const out = [];
  for (const r of rows) { const c = r.split(","), v = parseFloat(c[vi]); if (/^\d{4}-\d{2}$/.test(c[ti]) && isFinite(v)) out.push([c[ti], v]); }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** US CPI-U, all items, not seasonally adjusted (1982-84=100), last ~3 years by month */
export async function cpiUS() {
  const j = JSON.parse(await text("https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0"));
  if (j.status !== "REQUEST_SUCCEEDED") throw new Error("BLS: " + j.status);
  const out = (j.Results?.series?.[0]?.data || [])
    .filter((x) => /^M(0[1-9]|1[0-2])$/.test(x.period) && parseFloat(x.value) > 0)
    .map((x) => [`${x.year}-${x.period.slice(1)}`, Math.round(parseFloat(x.value) * 1000) / 1000])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (out.length < 14) throw new Error("BLS CPI: too few points");
  return { series: "BLS CUUR0000SA0", base: "1982-84=100", m: out };
}

/** Euro-area HICP, all items (2015=100), Eurostat. Since 2026 Eurostat publishes it under COICOP 2018 in prc_hicp_minr
    (the older prc_hicp_midx / ECB ICP series stop at 2025-12). */
export async function cpiEA(from) {
  const j = JSON.parse(await text(`https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_minr?geo=EA&coicop18=TOTAL&unit=I15&sinceTimePeriod=${from}`));
  const idx = j.dimension?.time?.category?.index || {}, v = j.value || {};
  const m = Object.keys(idx).filter((k) => /^\d{4}-\d{2}$/.test(k) && v[idx[k]] > 0).sort().map((k) => [k, Math.round(v[idx[k]] * 100) / 100]);
  if (m.length < 14) throw new Error("Eurostat HICP: too few points");
  return { series: "Eurostat prc_hicp_minr EA TOTAL I15", base: "2015=100", m };
}

/** Growth of 1 € kept in household deposits with agreed maturity up to 1 year (new business, euro-area average rate),
    renewed monthly over the last 12 published months, before tax. Also the average annual rate (%). */
export async function depositEUR(from) {
  const m = (await ecb("MIR/M.U2.B.L22.F.R.A.2250.EUR.N", from)).filter((e) => e[1] > -5 && e[1] < 50);
  if (m.length < 12) throw new Error("ECB deposit rates: too few months");
  const last = m.slice(-12);
  const growth = last.reduce((g, [, r]) => g * (1 + r / 100 / 12), 1);
  return { growth: Math.round(growth * 10000) / 10000, avg: Math.round((last.reduce((s, e) => s + e[1], 0) / 12) * 100) / 100, to: last[11][0] };
}

/** Growth of 1 $ in 4-week US Treasury bills rolled over every 4 weeks from `from` to `to` (coupon-equivalent yield). */
export async function depositUSD(from, to) {
  const rows = [];
  for (let y = from.getUTCFullYear(); y <= to.getUTCFullYear(); y++) {
    const csv = await text(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_bill_rates&field_tdr_date_value=${y}`);
    const [head, ...lines] = csv.trim().split(/\r?\n/);
    const ci = head.split(",").findIndex((c) => /4 WEEKS COUPON EQUIVALENT/i.test(c));
    if (ci < 0) throw new Error("Treasury: 4-week column missing");
    for (const l of lines) {
      const c = l.split(","), md = c[0].match(/^(\d{2})\/(\d{2})\/(\d{4})$/), v = parseFloat(c[ci]);
      if (md && isFinite(v)) rows.push([`${md[3]}-${md[1]}-${md[2]}`, v]);
    }
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const at = (d) => { const k = iso(d); let r = null; for (const e of rows) { if (e[0] <= k) r = e[1]; else break; } return r ?? rows[0]?.[1]; };
  if (rows.length < 200) throw new Error("Treasury: too few days");
  let g = 1, sum = 0, n = 0;
  for (let d = new Date(from); d < to; d = new Date(d.getTime() + 28 * 864e5)) {
    const days = Math.min(28, Math.round((to - d) / 864e5)), r = at(d);
    g *= 1 + (r / 100) * days / 365; sum += r; n++;
  }
  return { growth: Math.round(g * 10000) / 10000, avg: Math.round((sum / n) * 100) / 100 };
}
