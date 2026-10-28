// Scarica 10 anni di dati giornalieri OHLCV da Yahoo Finance in data/*.json
// Uso: node scripts/fetch-data.mjs
import { writeFileSync } from 'node:fs';

const TICKERS = [
  // indici e ETF
  'SPY','QQQ','IWM','DIA','SMH','XBI','ARKK','EEM','EFA','HYG','TLT','GLD','SLV','USO',
  'XLF','XLE','XLK','XLV','XLY','XLP','XLI','XLU',
  // tecnologia
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AMD','NFLX','INTC','CSCO','ORCL','CRM','ADBE','QCOM','AVGO','TXN','MU','IBM','PYPL','SHOP',
  // finanza
  'JPM','BAC','WFC','GS','MS','C','V','MA','AXP','BRK-B',
  // consumo e retail
  'WMT','COST','HD','LOW','TGT','NKE','MCD','SBUX','KO','PEP','PG','DIS',
  // salute
  'JNJ','PFE','MRK','ABBV','UNH','LLY','AMGN','GILD',
  // energia e industriali
  'XOM','CVX','COP','OXY','CAT','BA','GE','HON','UPS','LMT','DE',
  // telecom e auto
  'T','VZ','F','GM','BABA',
  // small cap (ETF e titoli)
  'IJR','IWO','IWN','VB','XRT','KRE','JETS','TAN','URA','LIT',
  'PLUG','FCEL','MARA','RIOT','GPRO','UEC','CLF','X','AAL','NCLH','M','KSS','GME','AMC','BB','NOK','SIRI','PENN','WYNN',
  'TLRY','CGC','SAVA','CRSP','HL','CDE','AG','FSLR','ENPH','SEDG','RIG','CCL','SWN','VALE','BYND','CHWY','ZM',
  '^VIX','^IRX'];

async function fetchTicker(t) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=10y&interval=1d&events=div,splits`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${t}: HTTP ${res.status}`);
  const j = await res.json();
  const r = j.chart.result[0];
  const q = r.indicators.quote[0];
  const adj = r.indicators.adjclose?.[0]?.adjclose;
  const rows = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = q.close[i];
    if (c == null || q.open[i] == null) continue;
    // aggiusta OHLC per split/dividendi così il grafico è continuo
    const f = adj && adj[i] ? adj[i] / c : 1;
    const d = new Date((r.timestamp[i] + r.meta.gmtoffset) * 1000).toISOString().slice(0, 10);
    const rd = v => Math.round(v * f * 100) / 100;
    rows.push([d, rd(q.open[i]), rd(q.high[i]), rd(q.low[i]), rd(c), q.volume[i] || 0]);
  }
  return { symbol: t, name: r.meta.longName || r.meta.shortName || t, rows };
}

const index = [];
for (const t of TICKERS) {
  try {
    const data = await fetchTicker(t);
    if (data.rows.length < 2400) { console.log(`${t}: storia troppo corta, saltato`); continue; }
    const file = t.replace('^', '') + '.json';
    writeFileSync(new URL(`../data/${file}`, import.meta.url), JSON.stringify(data));
    index.push({ symbol: t, file, name: data.name, from: data.rows[0][0], to: data.rows.at(-1)[0] });
    console.log(`${t}: ${data.rows.length} giorni`);
  } catch (e) { console.error(e.message); }
}
writeFileSync(new URL('../data/index.json', import.meta.url), JSON.stringify(index, null, 1));
