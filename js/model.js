'use strict';
/* Motore di mercato: dati storici, volatilità simulata, Black-Scholes, catene opzioni, analisi strategie, margini. */

const MULT = 100;
const LIQUID = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'XLF', 'XLE', 'XLK', 'GLD', 'TLT', 'HYG', 'EEM', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'TSLA']);
const ETF_LIST = ['SPY', 'QQQ', 'IWM', 'DIA', 'SMH', 'XBI', 'ARKK', 'EEM', 'EFA', 'HYG', 'TLT', 'GLD', 'SLV', 'USO', 'XLF', 'XLE', 'XLK', 'XLV', 'XLY', 'XLP', 'XLI', 'XLU'];
const ETF_STRIKES = new Set(ETF_LIST);
const NON_EQUITY = new Set(['GLD', 'TLT', 'SLV', 'USO', 'HYG', 'EEM', 'EFA']);
const HIDDEN = new Set(['^VIX', '^IRX']);

const Market = { index: [], series: {}, calendar: [] };

/* ---------- caricamento dati ---------- */
async function loadMarket(onProgress) {
  const index = await (await fetch('data/index.json')).json();
  Market.index = index;
  let done = 0;
  await Promise.all(index.map(async it => {
    const j = await (await fetch('data/' + it.file)).json();
    Market.series[it.symbol] = buildSeries(j);
    onProgress && onProgress(++done, index.length);
  }));
  Market.calendar = Market.series.SPY.dates;
}

function buildSeries(j) {
  const n = j.rows.length;
  const s = { symbol: j.symbol, name: j.name, dates: new Array(n), o: new Float64Array(n), h: new Float64Array(n),
    l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n), idx: new Map() };
  j.rows.forEach((r, i) => {
    s.dates[i] = r[0]; s.o[i] = r[1]; s.h[i] = r[2]; s.l[i] = r[3]; s.c[i] = r[4]; s.v[i] = r[5];
    s.idx.set(r[0], i);
  });
  s.hv20 = rollingVol(s.c, 20);
  s.hv60 = rollingVol(s.c, 60);
  s.hvLong = rollingMean(s.hv20, 252);
  return s;
}

function rollingVol(c, w) {
  const n = c.length, out = new Float64Array(n);
  let sum = 0, sq = 0;
  const r = new Float64Array(n);
  for (let i = 1; i < n; i++) r[i] = Math.log(c[i] / c[i - 1]);
  for (let i = 1; i < n; i++) {
    sum += r[i]; sq += r[i] * r[i];
    if (i > w) { sum -= r[i - w]; sq -= r[i - w] * r[i - w]; }
    const k = Math.min(i, w);
    const mean = sum / k;
    out[i] = k > 1 ? Math.sqrt(Math.max(0, (sq - k * mean * mean) / (k - 1)) * 252) : 0.2;
  }
  out[0] = out[1] || 0.2;
  return out;
}

function rollingMean(a, w) {
  const out = new Float64Array(a.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i];
    if (i >= w) sum -= a[i - w];
    out[i] = sum / Math.min(i + 1, w);
  }
  return out;
}

/* indice dell'ultima barra con data <= date (-1 se nessuna) */
function atOrBefore(s, date) {
  const hit = s.idx.get(date);
  if (hit !== undefined) return hit;
  let lo = 0, hi = s.dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.dates[mid] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function closeOn(sym, date) {
  const s = Market.series[sym];
  const i = atOrBefore(s, date);
  return i < 0 ? s.c[0] : s.c[i];
}

/* ---------- date ---------- */
const DAY = 86400000;
const toDate = d => new Date(d + 'T00:00:00Z');
const fmtISO = dt => dt.toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);
const addDays = (d, n) => fmtISO(new Date(toDate(d).getTime() + n * DAY));

function snapTradingDay(date) {
  const cal = Market.calendar;
  const i = atOrBefore(Market.series.SPY, date);
  return cal[Math.max(0, i)];
}

/* giorno di liquidazione: ultimo giorno di borsa <= scadenza (gestisce Venerdì Santo ecc.) */
function settleDate(expiry) {
  const cal = Market.calendar;
  if (expiry > cal[cal.length - 1]) return null;
  return snapTradingDay(expiry);
}

function expirations(date) {
  const d0 = toDate(date);
  const set = new Set();
  // settimanali: prossimi 8 venerdì
  const fri = new Date(d0);
  fri.setUTCDate(fri.getUTCDate() + ((5 - fri.getUTCDay() + 7) % 7 || 7));
  for (let k = 0; k < 8; k++) set.add(fmtISO(new Date(fri.getTime() + k * 7 * DAY)));
  // mensili: terzo venerdì dei prossimi 14 mesi
  for (let m = 0; m <= 14; m++) {
    const first = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + m, 1));
    const third = new Date(first);
    third.setUTCDate(1 + ((5 - first.getUTCDay() + 7) % 7) + 14);
    const iso = fmtISO(third);
    if (iso > date) set.add(iso);
  }
  return [...set].filter(e => e > date).sort();
}

function isMonthly(expiry) {
  const d = toDate(expiry);
  return d.getUTCDay() === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21;
}

/* ---------- tassi e volatilità ---------- */
function riskFree(date) {
  const s = Market.series['^IRX'];
  if (!s) return 0.02;
  const i = atOrBefore(s, date);
  return i < 0 ? 0.02 : Math.max(0, s.c[i] / 100);
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const volCache = new Map();

/* IV ATM a ~30 giorni. SPY = VIX; azioni = VIX scalato per il rapporto di volatilità realizzata vs SPY,
   miscelato con la volatilità realizzata del titolo. Usa solo dati <= date (nessun look-ahead). */
function atmVol(sym, date) {
  const key = sym + date;
  const hit = volCache.get(key);
  if (hit !== undefined) return hit;
  const s = Market.series[sym];
  const i = Math.max(0, atOrBefore(s, date));
  const hv20 = s.hv20[i], hv60 = s.hv60[i];
  let v;
  const vixS = Market.series['^VIX'];
  if (NON_EQUITY.has(sym) || !vixS) {
    v = (0.6 * hv20 + 0.4 * hv60) * 1.08 + 0.01;
  } else {
    const vix = vixS.c[Math.max(0, atOrBefore(vixS, date))] / 100;
    if (sym === 'SPY') v = vix;
    else {
      const spy = Market.series.SPY;
      const ratio = clamp(hv60 / spy.hv60[Math.max(0, atOrBefore(spy, date))], 0.6, 6);
      v = 0.6 * vix * ratio + 0.4 * (hv20 * 1.05 + 0.03);
    }
  }
  v = clamp(v, 0.06, 2.5);
  volCache.set(key, v);
  return v;
}

function longVol(sym, date) {
  const s = Market.series[sym];
  return s.hvLong[Math.max(0, atOrBefore(s, date))] * 1.1 + 0.01;
}

/* superficie di volatilità: struttura a termine (mean reversion verso la vol di lungo periodo) + skew */
function impliedVol(sym, date, K, T, S) {
  const a = atmVol(sym, date), L = longVol(sym, date);
  const f = Math.min(1.35, Math.exp(-2.2 * (T - 30 / 365)));
  const ivT = clamp(L + (a - L) * f, 0.05, 3);
  const x = Math.log(K / S) / (ivT * Math.sqrt(Math.max(T, 1 / 365)));
  const skew = NON_EQUITY.has(sym) ? -0.02 : -0.12;
  return ivT * clamp(1 + skew * x + 0.03 * x * x, 0.55, 3);
}

/* ---------- Black-Scholes ---------- */
function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}
const npdf = x => 0.3989422804014327 * Math.exp(-x * x / 2);

function bs(type, S, K, T, r, v) {
  if (T <= 0 || v <= 0) {
    const intr = type === 'C' ? Math.max(0, S - K) : Math.max(0, K - S);
    const itm = type === 'C' ? S > K : S < K;
    return { price: intr, delta: itm ? (type === 'C' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const sq = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * sq);
  const d2 = d1 - v * sq;
  const disc = Math.exp(-r * T);
  const pdf = npdf(d1);
  let price, delta, theta;
  if (type === 'C') {
    price = S * ncdf(d1) - K * disc * ncdf(d2);
    delta = ncdf(d1);
    theta = -S * pdf * v / (2 * sq) - r * K * disc * ncdf(d2);
  } else {
    price = K * disc * ncdf(-d2) - S * ncdf(-d1);
    delta = ncdf(d1) - 1;
    theta = -S * pdf * v / (2 * sq) + r * K * disc * ncdf(-d2);
  }
  return { price: Math.max(0, price), delta, gamma: pdf / (S * v * sq), theta: theta / 365, vega: S * pdf * sq / 100 };
}

const yearsTo = (date, expiry) => Math.max(0, daysBetween(date, expiry)) / 365;

/* quotazione simulata di un'opzione al close del giorno `date` (prezzo sottostante opzionale per scenari) */
function quote(sym, date, type, K, expiry, Sover) {
  const S = Sover ?? closeOn(sym, date);
  const T = yearsTo(date, expiry);
  const iv = T > 0 ? impliedVol(sym, date, K, T, S) : 0;
  const g = bs(type, S, K, T, riskFree(date), iv);
  const mid = g.price;
  let bid, ask;
  if (T <= 0) { bid = ask = mid; }
  else if (mid < 0.005) { bid = 0; ask = 0.01; }
  else {
    const w = LIQUID.has(sym) ? Math.max(0.01, 0.01 + mid * 0.012) : Math.max(0.02, 0.02 + mid * 0.03);
    bid = Math.max(0, Math.floor((mid - w / 2) * 100) / 100);
    ask = Math.max(0.01, Math.ceil((mid + w / 2) * 100) / 100);
  }
  return { ...g, mid, bid, ask, iv, T, S };
}

/* ---------- strike ---------- */
function strikeStep(sym, S) {
  if (S < 3) return 0.1;
  if (S < 10) return 0.25;
  if (S < 25) return 0.5;
  if (S < 60) return 1;
  if (ETF_STRIKES.has(sym)) return S < 700 ? 1 : 5;
  if (S < 200) return 2.5;
  if (S < 600) return 5;
  return 10;
}
const roundStrike = (k, step) => Math.round(Math.round(k / step) * step * 100) / 100;

function strikeList(sym, S, each) {
  const step = strikeStep(sym, S);
  const atm = roundStrike(S, step);
  const out = [];
  for (let k = -each; k <= each; k++) {
    const K = roundStrike(atm + k * step, step);
    if (K > 0) out.push(K);
  }
  return out;
}

/* strike con delta più vicino al target (|delta|) */
function strikeByDelta(sym, date, type, expiry, target) {
  const S = closeOn(sym, date);
  const ks = strikeList(sym, S, 80);
  let best = ks[0], bd = 9;
  for (const K of ks) {
    const d = Math.abs(Math.abs(quote(sym, date, type, K, expiry).delta) - target);
    const otm = type === 'C' ? K >= S : K <= S;
    if (otm && d < bd) { bd = d; best = K; }
  }
  return best;
}

/* ---------- analisi strategia ---------- */
function legValueAt(sym, date, leg, S, atExpiry) {
  if (atExpiry && leg.expiry <= atExpiry) return leg.type === 'C' ? Math.max(0, S - leg.K) : Math.max(0, leg.K - S);
  const from = atExpiry || date;
  const T = yearsTo(from, leg.expiry);
  const iv = impliedVol(sym, date, leg.K, T, closeOn(sym, date));
  return bs(leg.type, S, leg.K, T, riskFree(date), iv).price;
}

/* legs: qty con segno (totale contratti). cost: importo pagato in $ (negativo = credito). */
function analyze(sym, date, legs, cost) {
  const S0 = closeOn(sym, date);
  const firstExp = legs.reduce((m, l) => (l.expiry < m ? l.expiry : m), legs[0].expiry);
  const T = yearsTo(date, firstExp);
  const sigma = atmVol(sym, date);
  const sd = S0 * sigma * Math.sqrt(Math.max(T, 1 / 365));
  const Ks = legs.map(l => l.K);
  const lo = Math.max(0.01, Math.min(S0 - 3.2 * sd, Math.min(...Ks) * 0.9));
  const hi = Math.max(S0 + 3.2 * sd, Math.max(...Ks) * 1.1);
  const N = 240;
  const xs = [], expPL = [], nowPL = [];
  const pts = new Set([...Ks]);
  for (let k = 0; k <= N; k++) pts.add(lo + (hi - lo) * k / N);
  const sorted = [...pts].filter(x => x >= lo && x <= hi).sort((a, b) => a - b);
  const r = riskFree(date);
  for (const x of sorted) {
    xs.push(x);
    let ve = 0, vn = 0;
    for (const l of legs) {
      ve += l.qty * legValueAt(sym, date, l, x, firstExp);
      const iv = impliedVol(sym, date, l.K, yearsTo(date, l.expiry), S0);
      vn += l.qty * bs(l.type, x, l.K, yearsTo(date, l.expiry), r, iv).price;
    }
    expPL.push(ve * MULT - cost);
    nowPL.push(vn * MULT - cost);
  }
  // estremi: valore a S=0 e pendenza oltre l'ultimo strike
  let atZero = 0, slopeUp = 0;
  for (const l of legs) {
    atZero += l.qty * legValueAt(sym, date, l, 0.0001, firstExp);
    if (l.type === 'C') slopeUp += l.qty;
  }
  atZero = atZero * MULT - cost;
  const allPL = [...expPL, atZero];
  let maxP = Math.max(...allPL), maxL = Math.min(...allPL);
  const unlimitedUp = slopeUp > 1e-9, unlimitedDown = slopeUp < -1e-9;
  const be = [];
  for (let i = 1; i < xs.length; i++) {
    const a = expPL[i - 1], b = expPL[i];
    if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) be.push(xs[i - 1] + (xs[i] - xs[i - 1]) * (-a) / (b - a || 1));
  }
  // probabilità di profitto (distribuzione lognormale risk-neutral, vol ATM)
  let pop = 0;
  const v = sigma * Math.sqrt(Math.max(T, 1 / 365));
  const mu = Math.log(S0) + (r - sigma * sigma / 2) * Math.max(T, 1 / 365);
  const cdf = x => ncdf((Math.log(Math.max(x, 1e-9)) - mu) / v);
  for (let i = 0; i < xs.length; i++) {
    const left = i === 0 ? 0 : (xs[i - 1] + xs[i]) / 2;
    const right = i === xs.length - 1 ? Infinity : (xs[i] + xs[i + 1]) / 2;
    if (expPL[i] > 0) pop += (right === Infinity ? 1 : cdf(right)) - (left === 0 ? 0 : cdf(left));
  }
  // greche
  const gr = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const l of legs) {
    const q = quote(sym, date, l.type, l.K, l.expiry);
    gr.delta += q.delta * l.qty * MULT; gr.gamma += q.gamma * l.qty * MULT;
    gr.theta += q.theta * l.qty * MULT; gr.vega += q.vega * l.qty * MULT;
  }
  return { S0, xs, expPL, nowPL, maxProfit: unlimitedUp ? Infinity : maxP, maxLoss: unlimitedDown ? -Infinity : maxL,
    breakevens: be, pop, greeks: gr, firstExp, sd };
}

/* ---------- margine (semplificazione Reg-T in stile IB) ---------- */
function nakedReq(sym, date, l) {
  const S = closeOn(sym, date);
  const q = quote(sym, date, l.type, l.K, l.expiry);
  const otm = l.type === 'C' ? Math.max(0, l.K - S) : Math.max(0, S - l.K);
  const base = l.type === 'C' ? Math.max(0.2 * S - otm, 0.1 * S) : Math.max(0.2 * S - otm, 0.1 * l.K);
  return (q.mid + base) * MULT * Math.abs(l.qty);
}

function marginReq(sym, date, legs) {
  if (!legs.some(l => l.qty < 0)) return 0;
  const firstExp = legs.reduce((m, l) => (l.expiry < m ? l.expiry : m), legs[0].expiry);
  const S = closeOn(sym, date);
  // perdita massima a scadenza (valore dei soli leg, senza premio)
  let minV = Infinity, slopeUp = 0;
  const grid = new Set(legs.map(l => l.K));
  grid.add(0.0001);
  for (let k = 1; k <= 60; k++) grid.add(S * 3 * k / 60);
  for (const x of grid) {
    let v = 0;
    for (const l of legs) v += l.qty * legValueAt(sym, date, l, x, firstExp);
    minV = Math.min(minV, v);
  }
  for (const l of legs) if (l.type === 'C') slopeUp += l.qty;
  const defined = Math.max(0, -minV * MULT);
  // naked: max fra lato call e lato put + premio dell'altro lato
  const side = t => legs.filter(l => l.qty < 0 && l.type === t).reduce((a, l) => a + nakedReq(sym, date, l), 0);
  const prem = t => legs.filter(l => l.qty < 0 && l.type === t)
    .reduce((a, l) => a + quote(sym, date, l.type, l.K, l.expiry).mid * MULT * Math.abs(l.qty), 0);
  const naked = Math.max(side('C') + prem('P'), side('P') + prem('C'));
  if (slopeUp < -1e-9) return naked;
  return Math.min(defined, naked);
}

const commissionFor = contracts => Math.max(1, 0.65 * contracts);

/* serie IV ATM simulata per il grafico */
const ivSeriesCache = {};
function ivSeries(sym) {
  if (ivSeriesCache[sym]) return ivSeriesCache[sym];
  const s = Market.series[sym];
  const arr = s.dates.map(d => atmVol(sym, d));
  ivSeriesCache[sym] = arr;
  return arr;
}
