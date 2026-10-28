'use strict';
/* Interfaccia: conto simulato, navigazione temporale, grafico, catena opzioni, strategy builder, portafoglio. */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const STORE_KEY = 'optsim.v1';
const nf = (d) => new Intl.NumberFormat('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: 'always' });
const NF0 = nf(0), NF2 = nf(2), NF3 = nf(3);
const money = (v, d = 2) => (v < 0 ? '−' : '') + '$' + (d ? NF2 : NF0).format(Math.abs(v));
const signed = (v, d = 2) => (v > 0 ? '+' : v < 0 ? '−' : '') + (d === 0 ? NF0 : NF2).format(Math.abs(v));
const pct = v => signed(v * 100) + '%';
const cls = v => (v > 0.0049 ? 'up' : v < -0.0049 ? 'down' : '');
const fmtK = K => (Number.isInteger(K) ? String(K) : K.toFixed(2).replace(/0$/, '')).replace('.', ',');
const MONTHS = ['GEN', 'FEB', 'MAR', 'APR', 'MAG', 'GIU', 'LUG', 'AGO', 'SET', 'OTT', 'NOV', 'DIC'];
const DOW = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const expLabel = e => { const d = toDate(e); return `${MONTHS[d.getUTCMonth()]}${String(d.getUTCDate()).padStart(2, '0')}'${String(d.getUTCFullYear()).slice(2)}`; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const App = {
  date: null, sym: 'SPY', expiry: null, strikesEach: 10,
  acct: null,
  ticket: { strat: 'iron_condor', legs: [], qty: 1, width: 2, delta: 0.25, mode: 'mid', limit: '' },
  view: { tf: 'D', range: '6M', ind: { sma20: true, sma50: true, sma200: false, bb: false, em: true, pos: true } },
  selectedPos: null, tab: 'pos', playTimer: null,
  pages: [], pageIdx: 0, watchFilter: '',
  bots: [], botOn: false, botPause: true,
};

/* ---------- persistenza (solo comodità locale) ---------- */
function save() {
  try {
    syncPage();
    localStorage.setItem(STORE_KEY, JSON.stringify({ date: App.date, sym: App.sym, expiry: App.expiry, acct: App.acct,
      view: App.view, strikesEach: App.strikesEach, ticket: App.ticket, pages: App.pages, pageIdx: App.pageIdx,
      bots: App.bots, botOn: App.botOn, botPause: App.botPause }));
  } catch (e) { /* storage non disponibile */ }
}
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; }
}

/* ---------- conto ---------- */
function newAccount(capital, date) {
  return { start: capital, cash: capital, positions: [], closed: [], trades: [], equity: [{ d: date, v: capital }],
    realized: 0, commissions: 0, nextId: 1, startDate: date, botLog: [], botState: {} };
}

const legQuote = (sym, l, date = App.date) => quote(sym, date, l.type, l.K, l.expiry);
const groupValue = (g, date = App.date) => g.legs.reduce((a, l) => a + l.qty * legQuote(g.sym, l, date).mid * MULT, 0);

function totals(date = App.date) {
  const a = App.acct;
  let mv = 0, margin = 0, unreal = 0, theta = 0;
  for (const g of a.positions) {
    const v = groupValue(g, date);
    mv += v;
    margin += marginReq(g.sym, date, g.legs);
    unreal += v + g.received - g.cost;
    for (const l of g.legs) theta += legQuote(g.sym, l, date).theta * l.qty * MULT;
  }
  const netLiq = a.cash + mv;
  const prev = a.equity.length > 1 ? a.equity[a.equity.length - 2].v : a.start;
  return { netLiq, mv, margin, bp: a.cash - margin, unreal, theta, dayPL: netLiq - prev };
}

function recordEquity() {
  const eq = App.acct.equity;
  const v = totals().netLiq;
  if (eq.length && eq[eq.length - 1].d === App.date) eq[eq.length - 1].v = v;
  else eq.push({ d: App.date, v });
}

function logTrade(kind, g, desc, amount, comm) {
  App.acct.trades.unshift({ d: App.date, id: g.id, sym: g.sym, kind, desc, amount, comm });
}

const legsText = (legs, withExp = true) => legs.map(l =>
  `${l.qty > 0 ? '+' : ''}${l.qty} ${l.type} ${fmtK(l.K)}${withExp ? ' ' + expLabel(l.expiry) : ''}`).join(' · ');

/* liquida i leg scaduti alla chiusura del giorno di scadenza */
function processExpirations() {
  const a = App.acct;
  for (const g of [...a.positions]) {
    const keep = [];
    for (const l of g.legs) {
      const sd = settleDate(l.expiry);
      if (sd && sd <= App.date) {
        const S = closeOn(g.sym, sd);
        const intr = l.type === 'C' ? Math.max(0, S - l.K) : Math.max(0, l.K - S);
        const amt = intr * MULT * l.qty;
        a.cash += amt; g.received += amt;
        logTrade('Scadenza', g, `${legsText([l])} @ ${NF2.format(intr)} (sott. ${NF2.format(S)})`, amt, 0);
      } else keep.push(l);
    }
    if (keep.length !== g.legs.length) {
      g.legs = keep;
      if (!keep.length) finishGroup(g, 'scaduta');
    }
  }
}

function finishGroup(g, how) {
  const a = App.acct;
  const pnl = g.received - g.cost - g.comm;
  a.realized += pnl;
  a.positions = a.positions.filter(x => x !== g);
  a.closed.unshift({ ...g, closeDate: App.date, pnl, how });
  if (App.selectedPos === g.id) App.selectedPos = null;
  toast(how === 'scaduta' ? 'info' : 'ok', `#${g.id} ${g.sym} ${g.name} ${how}`, `P&L realizzato ${money(pnl)}`);
}

/* ---------- navigazione temporale ---------- */
const calIndex = d => Market.series.SPY.idx.get(d);
const hasActivity = () => App.acct.positions.length || App.acct.trades.length;

function advance(n) {
  const cal = Market.calendar;
  const i = calIndex(App.date);
  const target = Math.min(cal.length - 1, i + n);
  if (target === i) { stopPlay(); toast('info', 'Fine dei dati storici', `Ultimo giorno disponibile: ${cal[i]}`); return; }
  for (let k = i + 1; k <= target; k++) {
    App.date = cal[k];
    processExpirations();
    const acted = runBots();
    recordEquity();
    if (acted && App.botPause) { stopPlay(); break; }
  }
  onDateChanged();
}

function goTo(raw) {
  if (!raw) return;
  const cal = Market.calendar;
  const d = snapTradingDay(raw < cal[minStartIdx()] ? cal[minStartIdx()] : raw);
  if (d === App.date) { renderTime(); return; }
  if (d > App.date) { advance(calIndex(d) - calIndex(App.date)); return; }
  if (!hasActivity()) {
    App.date = d;
    App.acct = newAccount(App.acct.start, d);
    onDateChanged();
    return;
  }
  renderTime();
  confirmModal('Tornare indietro nel tempo?',
    `Hai operazioni registrate. Spostarsi al ${d} azzera il portafoglio e riparte con ${money(App.acct.start, 0)} di capitale, così il simulatore non usa informazioni dal futuro.`,
    'Azzera e vai al ' + d, () => { App.date = d; App.acct = newAccount(App.acct.start, d); App.selectedPos = null; onDateChanged(); });
}

const minStartIdx = () => 260; // serve un anno di storia per la volatilità

function onDateChanged(force) {
  const exps = expirations(App.date);
  if (!App.expiry || !exps.includes(App.expiry)) App.expiry = defaultExpiry(exps);
  App.ticket.legs = App.ticket.legs.filter(l => l.expiry > App.date);
  if (!App.ticket.legs.length && App.ticket.strat !== 'custom') buildTemplate();
  renderAll(force);
  save();
}

function defaultExpiry(exps) {
  const m = exps.find(e => isMonthly(e) && daysBetween(App.date, e) >= 25);
  return m || exps[0];
}

function togglePlay() {
  if (App.playTimer) return stopPlay();
  $('#play').classList.add('on'); $('#play').textContent = '❚❚ Pausa';
  App.playTimer = setInterval(() => advance(1), +$('#speed').value);
}
function stopPlay() {
  clearInterval(App.playTimer); App.playTimer = null;
  $('#play').classList.remove('on'); $('#play').textContent = '▶ Play';
}

/* ---------- ticket / ordini ---------- */
function buildTemplate() {
  const st = STRATEGIES.find(s => s.id === App.ticket.strat);
  if (!st || !st.build) return;
  const ctx = strategyContext(App.sym, App.date, App.expiry, App.ticket.width, App.ticket.delta);
  App.ticket.legs = st.build(ctx);
  App.ticket.limit = '';
}

function addLeg(type, K, expiry, qty) {
  const t = App.ticket;
  if (t.strat !== 'custom') { t.strat = 'custom'; }
  const ex = t.legs.find(l => l.type === type && l.K === K && l.expiry === expiry);
  if (ex) { ex.qty += qty; if (!ex.qty) t.legs = t.legs.filter(l => l !== ex); }
  else t.legs.push(leg(type, K, expiry, qty));
  App.selectedPos = null;
  t.limit = '';
  renderTicket(); renderChain();
}

function comboPrice(legs, date = App.date) {
  let mid = 0, nat = 0, far = 0;
  for (const l of legs) {
    const q = legQuote(App.sym, l, date);
    mid += l.qty * q.mid;
    nat += l.qty * (l.qty > 0 ? q.ask : q.bid);
    far += l.qty * (l.qty > 0 ? q.bid : q.ask);
  }
  return { mid, nat, far };
}

function orderPrice() {
  const t = App.ticket;
  const { mid, nat } = comboPrice(t.legs);
  if (t.mode === 'mid') return { px: Math.round(mid * 100) / 100, mid, nat, ok: true };
  if (t.mode === 'nat') return { px: nat, mid, nat, ok: true };
  const L = parseFloat(String(t.limit).replace(',', '.'));
  if (!isFinite(L)) return { px: null, mid, nat, ok: false, why: 'Inserisci un prezzo limite.' };
  const P = mid >= 0 ? L : -L;
  if (P + 1e-9 < mid) return { px: null, mid, nat, ok: false, why: `Limite meno aggressivo del mid (${NF2.format(Math.abs(mid))}): l'ordine non verrebbe eseguito.` };
  return { px: Math.min(P, nat), mid, nat, ok: true };
}

function transmit() {
  const t = App.ticket, a = App.acct;
  const n = Math.max(1, Math.floor(+t.qty || 1));
  if (!t.legs.length) return;
  const op = orderPrice();
  if (!op.ok) { toast('err', 'Ordine non eseguito', op.why); return; }
  const legs = t.legs.map(l => ({ ...l, qty: l.qty * n, open: legQuote(App.sym, l).mid }));
  const cost = op.px * MULT * n;
  const contracts = legs.reduce((s, l) => s + Math.abs(l.qty), 0);
  const comm = commissionFor(contracts);
  const marginNow = a.positions.reduce((s, g) => s + marginReq(g.sym, App.date, g.legs), 0);
  const req = marginReq(App.sym, App.date, legs);
  const bpAfter = a.cash - cost - comm - marginNow - req;
  if (bpAfter < 0) {
    toast('err', 'Buying power insufficiente', `Servono ${money(cost + comm + req)} (premio + margine), disponibili ${money(a.cash - marginNow)}.`);
    return;
  }
  const st = STRATEGIES.find(s => s.id === t.strat);
  const g = { id: a.nextId++, sym: App.sym, name: st && st.build ? st.name : describeLegs(legs), openDate: App.date,
    legs, n, cost, comm, received: 0, openPx: op.px };
  a.cash -= cost + comm;
  a.commissions += comm;
  a.positions.push(g);
  logTrade('Apertura', g, `${g.name} ${n}× ${legsText(t.legs)} @ ${NF2.format(Math.abs(op.px))} ${op.px >= 0 ? 'DB' : 'CR'}`, -cost, comm);
  toast('ok', `Eseguito: ${g.sym} ${g.name}`, `${n}× @ ${NF2.format(Math.abs(op.px))} ${op.px >= 0 ? 'debito' : 'credito'} · comm. ${money(comm)}`);
  t.legs = []; t.strat = 'custom'; t.limit = '';
  App.selectedPos = g.id;
  recordEquity();
  renderAll(); save();
}

function closePosition(id, how = 'chiusa') {
  const a = App.acct;
  const g = a.positions.find(x => x.id === id);
  if (!g) return;
  const natural = App.ticket.mode === 'nat';
  let proceeds = 0, contracts = 0;
  for (const l of g.legs) {
    const q = legQuote(g.sym, l);
    proceeds += l.qty * (natural ? (l.qty > 0 ? q.bid : q.ask) : q.mid) * MULT;
    contracts += Math.abs(l.qty);
  }
  const comm = commissionFor(contracts);
  a.cash += proceeds - comm;
  a.commissions += comm;
  g.comm += comm; g.received += proceeds;
  logTrade('Chiusura', g, `${g.name} ${legsText(g.legs)} @ ${NF2.format(Math.abs(proceeds / MULT / g.n))} ${natural ? '(natural)' : '(mid)'}`, proceeds, comm);
  finishGroup(g, how);
  recordEquity();
  renderAll(); save();
}

/* ---------- render: testata ---------- */
function renderAcct() {
  const t = totals(), a = App.acct;
  const ret = t.netLiq / a.start - 1;
  const kv = (k, v, c = '') => `<div class="kv"><span>${k}</span><b class="${c}">${v}</b></div>`;
  $('#acct').innerHTML =
    kv('Net Liquidation', money(t.netLiq)) +
    kv('Rendimento', pct(ret), cls(ret)) +
    kv('Cash', money(a.cash)) +
    kv('Buying power', money(t.bp), t.bp < 0 ? 'down' : '') +
    kv('Margine', money(t.margin)) +
    kv('P&L giorno', money(t.dayPL), cls(t.dayPL)) +
    kv('Non realizzato', money(t.unreal), cls(t.unreal)) +
    kv('Realizzato', money(a.realized), cls(a.realized)) +
    kv('Theta/giorno', money(t.theta), cls(t.theta));
}

function renderTime() {
  const d = toDate(App.date);
  $('#datePick').value = App.date;
  $('#dateDow').textContent = DOW[d.getUTCDay()];
  const i = calIndex(App.date), cal = Market.calendar;
  const days = daysBetween(App.acct.startDate, App.date);
  $('#timeInfo').innerHTML = `<span>Sessione dal <b>${App.acct.startDate}</b> · <b>${days}</b> giorni</span>` +
    `<span>Barra <b>${i + 1}</b>/<b>${cal.length}</b></span><span>Dati fino al <b>${cal[cal.length - 1]}</b></span>` +
    `<span>T-bill <b>${NF2.format(riskFree(App.date) * 100)}%</b></span>`;
}

function renderWatch() {
  const held = new Set(App.acct.positions.map(g => g.sym));
  const wf = App.watchFilter.trim().toLowerCase();
  $('#watch').innerHTML = Market.index.filter(x => (!HIDDEN.has(x.symbol) || x.symbol === '^VIX') && (!wf || x.symbol.toLowerCase().includes(wf) || x.name.toLowerCase().includes(wf))).map(x => {
    const s = Market.series[x.symbol];
    const i = atOrBefore(s, App.date);
    const c = s.c[i], ch = c / s.c[Math.max(0, i - 1)] - 1;
    const tradable = !HIDDEN.has(x.symbol);
    return `<div class="w-row ${x.symbol === App.sym ? 'on' : ''}" data-sym="${x.symbol}" ${tradable ? '' : 'data-ro="1"'} title="${esc(x.name)}">
      <span class="s">${x.symbol.replace('^', '')}${SMALL.has(x.symbol) ? '<i class="sc" title="Small cap">SC</i>' : ''}${held.has(x.symbol) ? '<i class="posdot"></i>' : ''}</span><span class="p">${NF2.format(c)}</span>
      <span class="n">${esc(x.name)}</span><span class="c ${cls(ch)}">${pct(ch)}</span></div>`;
  }).join('');
}

/* ---------- grafico ---------- */
const Chart = { chart: null, candles: null, vol: null, lines: {}, iv: null, hv: null, priceLines: [], markers: null, key: '', len: 0, bars: [] };
const CH = { up: '#2bbf6e', down: '#ef4f4f', grid: '#151920', text: '#838b98', line: '#232832' };

function initChart() {
  const LC = LightweightCharts;
  const c = LC.createChart($('#chart'), {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#0b0d11' }, textColor: CH.text, fontFamily: 'IBM Plex Mono, monospace', fontSize: 11,
      panes: { separatorColor: CH.line, separatorHoverColor: '#2e3542' }, attributionLogo: false },
    grid: { vertLines: { color: CH.grid }, horzLines: { color: CH.grid } },
    crosshair: { mode: LC.CrosshairMode.Normal },
    rightPriceScale: { borderColor: CH.line },
    timeScale: { borderColor: CH.line, rightOffset: 6, minBarSpacing: 0.5 },
    localization: { locale: 'it-IT' },
  });
  Chart.chart = c;
  Chart.candles = c.addSeries(LC.CandlestickSeries, { upColor: CH.up, downColor: CH.down, borderUpColor: CH.up, borderDownColor: CH.down,
    wickUpColor: CH.up, wickDownColor: CH.down, priceLineColor: '#f0a530' });
  Chart.vol = c.addSeries(LC.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  const line = (color, w = 1, extra = {}) => c.addSeries(LC.LineSeries, { color, lineWidth: w, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra });
  Chart.lines.sma20 = line('#f0a530');
  Chart.lines.sma50 = line('#3b8cff');
  Chart.lines.sma200 = line('#c06cf0');
  Chart.lines.bbU = line('rgba(160,170,190,.55)', 1, { lineStyle: 2 });
  Chart.lines.bbL = line('rgba(160,170,190,.55)', 1, { lineStyle: 2 });
  Chart.iv = c.addSeries(LC.LineSeries, { color: '#f0a530', lineWidth: 1.5, priceLineVisible: false, title: 'IV',
    priceFormat: { type: 'custom', formatter: v => (v * 100).toFixed(1) + '%' } }, 1);
  Chart.hv = c.addSeries(LC.LineSeries, { color: '#7d8796', lineWidth: 1, priceLineVisible: false, title: 'HV20',
    priceFormat: { type: 'custom', formatter: v => (v * 100).toFixed(1) + '%' } }, 1);
  c.panes()[1].setHeight(90);
  Chart.markers = LC.createSeriesMarkers(Chart.candles, []);
  c.subscribeCrosshairMove(p => renderLegend(p && p.time ? Chart.bars.find(b => b.time === p.time) : null));
}

function periodKey(d, tf) {
  if (tf === 'D') return d;
  if (tf === 'M') return d.slice(0, 7) + '-01';
  const dt = toDate(d); const dow = (dt.getUTCDay() + 6) % 7;
  return fmtISO(new Date(dt.getTime() - dow * DAY));
}

function buildBars(sym, tf) {
  const s = Market.series[sym];
  const end = atOrBefore(s, App.date);
  const ivs = ivSeries(sym);
  const bars = [];
  for (let i = 0; i <= end; i++) {
    const t = periodKey(s.dates[i], tf);
    const last = bars[bars.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, s.h[i]); last.low = Math.min(last.low, s.l[i]);
      last.close = s.c[i]; last.volume += s.v[i]; last.iv = ivs[i]; last.hv = s.hv20[i]; last.d = s.dates[i];
    } else bars.push({ time: t, open: s.o[i], high: s.h[i], low: s.l[i], close: s.c[i], volume: s.v[i], iv: ivs[i], hv: s.hv20[i], d: s.dates[i] });
  }
  return bars;
}

function sma(bars, n) {
  const out = []; let sum = 0;
  bars.forEach((b, i) => { sum += b.close; if (i >= n) sum -= bars[i - n].close; if (i >= n - 1) out.push({ time: b.time, value: sum / n }); });
  return out;
}
function bollinger(bars, n = 20, k = 2) {
  const u = [], l = [];
  for (let i = n - 1; i < bars.length; i++) {
    let m = 0; for (let j = i - n + 1; j <= i; j++) m += bars[j].close; m /= n;
    let v = 0; for (let j = i - n + 1; j <= i; j++) v += (bars[j].close - m) ** 2;
    const sd = Math.sqrt(v / n);
    u.push({ time: bars[i].time, value: m + k * sd }); l.push({ time: bars[i].time, value: m - k * sd });
  }
  return [u, l];
}

function renderChart(forceRange) {
  const { tf, ind } = App.view;
  const bars = buildBars(App.sym, tf);
  const key = App.sym + tf;
  const incremental = !forceRange && key === Chart.key && bars.length >= Chart.len && Chart.len > 0;
  Chart.bars = bars;
  const cd = bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
  const vd = bars.map(b => ({ time: b.time, value: b.volume, color: b.close >= b.open ? 'rgba(43,191,110,.35)' : 'rgba(239,79,79,.35)' }));
  const ivd = bars.map(b => ({ time: b.time, value: b.iv }));
  const hvd = bars.map(b => ({ time: b.time, value: b.hv }));
  if (incremental) {
    for (let i = Math.max(0, Chart.len - 1); i < bars.length; i++) {
      Chart.candles.update(cd[i]); Chart.vol.update(vd[i]); Chart.iv.update(ivd[i]); Chart.hv.update(hvd[i]);
    }
  } else {
    Chart.candles.setData(cd); Chart.vol.setData(vd); Chart.iv.setData(ivd); Chart.hv.setData(hvd);
  }
  Chart.lines.sma20.setData(ind.sma20 ? sma(bars, 20) : []);
  Chart.lines.sma50.setData(ind.sma50 ? sma(bars, 50) : []);
  Chart.lines.sma200.setData(ind.sma200 ? sma(bars, 200) : []);
  const [bu, bl] = ind.bb ? bollinger(bars) : [[], []];
  Chart.lines.bbU.setData(bu); Chart.lines.bbL.setData(bl);
  Chart.key = key; Chart.len = bars.length;
  if (!incremental) applyRange();
  renderPriceLines();
  renderMarkers();
  renderLegend(null);
}

function applyRange() {
  const r = App.view.range, bars = Chart.bars;
  if (!bars.length) return;
  if (r === 'ALL') { Chart.chart.timeScale().fitContent(); return; }
  const days = { '1M': 31, '3M': 92, '6M': 183, '1Y': 365, '3Y': 1095 }[r];
  const from = addDays(App.date, -days);
  let i = bars.findIndex(b => b.d >= from);
  if (i < 0) i = 0;
  Chart.chart.timeScale().setVisibleLogicalRange({ from: i, to: bars.length - 1 + 6 });
}

function renderPriceLines() {
  Chart.priceLines.forEach(p => Chart.candles.removePriceLine(p));
  Chart.priceLines = [];
  const add = (price, color, title, style = 2) => Chart.priceLines.push(Chart.candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
  if (App.view.ind.pos) {
    const agg = new Map();
    for (const g of App.acct.positions.filter(g => g.sym === App.sym))
      for (const l of g.legs) { const k = l.type + l.K; agg.set(k, { ...l, qty: (agg.get(k)?.qty || 0) + l.qty }); }
    for (const l of agg.values()) if (l.qty) add(l.K, l.qty > 0 ? '#3b8cff' : '#ef4f4f', `${l.qty > 0 ? '+' : ''}${l.qty} ${l.type}${fmtK(l.K)}`);
  }
  if (App.view.ind.em && App.expiry) {
    const S = closeOn(App.sym, App.date), T = yearsTo(App.date, App.expiry);
    const em = S * impliedVol(App.sym, App.date, S, T, S) * Math.sqrt(T);
    add(S + em, 'rgba(240,165,48,.7)', `+1σ ${expLabel(App.expiry)}`, 1);
    add(S - em, 'rgba(240,165,48,.7)', `−1σ ${expLabel(App.expiry)}`, 1);
  }
}

function renderMarkers() {
  const tf = App.view.tf, ms = [];
  for (const tr of [...App.acct.trades].reverse()) {
    if (tr.sym !== App.sym || tr.kind === 'Scadenza') continue;
    const open = tr.kind === 'Apertura';
    ms.push({ time: periodKey(tr.d, tf), position: open ? 'belowBar' : 'aboveBar', color: open ? '#3b8cff' : '#f0a530',
      shape: open ? 'arrowUp' : 'arrowDown', text: `#${tr.id}` });
  }
  ms.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  Chart.markers.setMarkers(ms);
}

function renderLegend(bar) {
  const b = bar || Chart.bars[Chart.bars.length - 1];
  if (!b) return;
  const chg = b.close - b.open;
  $('#legend').innerHTML = `<div><span>${b.d}</span><span>A <b>${NF2.format(b.open)}</b></span><span>M <b>${NF2.format(b.high)}</b></span>` +
    `<span>m <b>${NF2.format(b.low)}</b></span><span>C <b class="${cls(chg)}">${NF2.format(b.close)}</b></span>` +
    `<span>Vol <b>${NF0.format(b.volume / 1e6)}M</b></span><span>IV <b>${(b.iv * 100).toFixed(1)}%</b></span></div>`;
}

function renderQuoteHeader() {
  const s = Market.series[App.sym];
  const i = atOrBefore(s, App.date);
  const c = s.c[i], p = s.c[Math.max(0, i - 1)], ch = c - p;
  const ivs = ivSeries(App.sym);
  const win = ivs.slice(Math.max(0, i - 251), i + 1);
  const lo = Math.min(...win), hi = Math.max(...win);
  const ivr = hi > lo ? (ivs[i] - lo) / (hi - lo) : 0;
  const kv = (k, v) => `<span class="kv">${k}<b>${v}</b></span>`;
  $('#quoteH').innerHTML = `<span class="sym">${App.sym}</span><span class="exch">${esc(s.name)}</span>` +
    `<span class="last ${cls(ch)}">${NF2.format(c)}</span><span class="chg ${cls(ch)}">${signed(ch)} (${pct(ch / p)})</span>` +
    kv('Max', NF2.format(s.h[i])) + kv('Min', NF2.format(s.l[i])) + kv('Vol', NF0.format(s.v[i])) +
    kv('IV 30g', (ivs[i] * 100).toFixed(1) + '%') + kv('HV 20g', (s.hv20[i] * 100).toFixed(1) + '%') + kv('IV Rank', Math.round(ivr * 100));
}

/* ---------- option chain ---------- */
function renderChain() {
  const sym = App.sym, date = App.date;
  $('#chainSym').textContent = sym;
  const exps = expirations(date);
  $('#expTabs').innerHTML = exps.map(e => {
    const dte = daysBetween(date, e), m = isMonthly(e);
    return `<button type="button" data-exp="${e}" class="${e === App.expiry ? 'on' : ''} ${m ? 'm' : ''}">${expLabel(e)}<small>${dte}g${m ? '' : ' · W'}</small></button>`;
  }).join('');
  const S = closeOn(sym, date);
  const ks = strikeList(sym, S, App.strikesEach);
  const inLeg = new Set(App.ticket.legs.filter(l => l.expiry === App.expiry).map(l => l.type + l.K));
  const held = new Map();
  for (const g of App.acct.positions) if (g.sym === sym) for (const l of g.legs) if (l.expiry === App.expiry) held.set(l.type + l.K, (held.get(l.type + l.K) || 0) + l.qty);
  const cell = (q, type, K, side) => {
    const itm = type === 'C' ? K < S : K > S;
    const hl = inLeg.has(type + K) ? ' inleg' : '';
    const c = itm ? ' itm' : '';
    const h = held.get(type + K);
    const badge = h ? `<span class="pq">${h > 0 ? '+' : ''}${h}</span>` : '';
    const g = `<td class="g gk${c}">${q.delta.toFixed(2)}</td><td class="g gk${c}">${q.theta.toFixed(3)}</td><td class="g${c}">${(q.iv * 100).toFixed(1)}</td>`;
    const ba = `<td class="bid${c}${hl}" data-a="sell" data-t="${type}" data-k="${K}">${q.bid.toFixed(2)}</td><td class="ask${c}${hl}" data-a="buy" data-t="${type}" data-k="${K}">${q.ask.toFixed(2)}${side === 'C' ? badge : ''}</td>`;
    return side === 'C' ? g + ba : ba + `<td class="g${c}">${(q.iv * 100).toFixed(1)}</td><td class="g gk${c}">${q.theta.toFixed(3)}</td><td class="g gk${c}">${q.delta.toFixed(2)}${badge}</td>`;
  };
  let rows = '', spotDone = false;
  for (const K of ks) {
    if (!spotDone && K > S) {
      rows += `<tr class="spot-row"><td colspan="11"><span>${sym} ${NF2.format(S)}</span></td></tr>`;
      spotDone = true;
    }
    const qc = quote(sym, date, 'C', K, App.expiry), qp = quote(sym, date, 'P', K, App.expiry);
    rows += `<tr>${cell(qc, 'C', K, 'C')}<td class="k">${fmtK(K)}</td>${cell(qp, 'P', K, 'P')}</tr>`;
  }
  $('#chainT').innerHTML = `<thead><tr><th colspan="5" class="side">CALLS</th><th class="side"></th><th colspan="5" class="side">PUTS</th></tr>
    <tr><th class="gk">Delta</th><th class="gk">Theta</th><th>IV %</th><th>Bid</th><th>Ask</th><th>Strike</th><th>Bid</th><th>Ask</th><th>IV %</th><th class="gk">Theta</th><th class="gk">Delta</th></tr></thead><tbody>${rows}</tbody>`;
}

/* ---------- strategy builder ---------- */
function renderStrats() {
  const groups = [...new Set(STRATEGIES.map(s => s.group))];
  $('#strats').innerHTML = groups.map(g => `<div class="strat-g"><span>${g}</span>${STRATEGIES.filter(s => s.group === g)
    .map(s => `<button type="button" data-s="${s.id}" class="${App.ticket.strat === s.id ? 'on' : ''}">${s.name}</button>`).join('')}</div>`).join('');
}

function renderTicket() {
  const t = App.ticket;
  renderStrats();
  $('#ticketSym').textContent = `${App.sym} · ${NF2.format(closeOn(App.sym, App.date))}`;
  $('#pWidth').value = String(t.width); $('#pDelta').value = t.delta.toFixed(2); $('#pQty').value = t.qty;
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === t.mode));
  $('#pLimit').hidden = t.mode !== 'lmt';
  if (document.activeElement !== $('#pLimit')) $('#pLimit').value = t.limit;

  const S = closeOn(App.sym, App.date);
  const ks = strikeList(App.sym, S, 40);
  const exps = expirations(App.date);
  if (!t.legs.length) {
    const st = STRATEGIES.find(s => s.id === t.strat);
    $('#legs').innerHTML = `<div class="empty">${st && st.desc ? st.desc : 'Scegli una strategia o clicca un prezzo nella catena.'}</div>`;
  } else {
    $('#legs').innerHTML = `<table><thead><tr><th>Azione</th><th>Q</th><th>Tipo</th><th>Strike</th><th>Scadenza</th><th style="text-align:right">Mid</th><th></th></tr></thead><tbody>` +
      t.legs.map((l, i) => {
        const q = legQuote(App.sym, l);
        const kOpts = (ks.includes(l.K) ? ks : [...ks, l.K].sort((a, b) => a - b)).map(k => `<option value="${k}" ${k === l.K ? 'selected' : ''}>${fmtK(k)}</option>`).join('');
        const eOpts = exps.map(e => `<option value="${e}" ${e === l.expiry ? 'selected' : ''}>${expLabel(e)} (${daysBetween(App.date, e)}g)</option>`).join('');
        return `<tr data-i="${i}"><td><button type="button" class="act ${l.qty > 0 ? 'b' : 's'}" data-f="side">${l.qty > 0 ? 'BUY' : 'SELL'}</button></td>
          <td><input type="number" min="1" max="20" value="${Math.abs(l.qty)}" data-f="q" aria-label="Rapporto"></td>
          <td><select data-f="type" aria-label="Tipo"><option ${l.type === 'C' ? 'selected' : ''}>C</option><option ${l.type === 'P' ? 'selected' : ''}>P</option></select></td>
          <td><select data-f="K" aria-label="Strike">${kOpts}</select></td>
          <td><select data-f="exp" aria-label="Scadenza">${eOpts}</select></td>
          <td style="text-align:right">${q.mid.toFixed(2)}</td>
          <td><button type="button" class="x" data-f="del" aria-label="Rimuovi leg">×</button></td></tr>`;
      }).join('') + '</tbody></table>';
  }
  renderAnalysis();
}

function renderAnalysis() {
  const t = App.ticket, a = App.acct;
  const pos = App.selectedPos != null ? a.positions.find(g => g.id === App.selectedPos) : null;
  const send = $('#btnSend');
  let legs, cost, sym = App.sym, header = '';
  if (pos) {
    sym = pos.sym;
    legs = pos.legs; cost = pos.cost - pos.received;
    header = `<div class="pos-view"><span>Analisi posizione #${pos.id} · ${pos.sym} ${esc(pos.name)}</span><button type="button" class="btn sm" id="backTicket">Torna al ticket</button></div>`;
    $('#comboPx').innerHTML = '';
  } else if (t.legs.length) {
    const n = Math.max(1, +t.qty || 1);
    const op = orderPrice();
    legs = t.legs.map(l => ({ ...l, qty: l.qty * n }));
    const px = op.ok ? op.px : op.mid;
    cost = px * MULT * n;
    $('#comboPx').innerHTML = `Mid <b>${NF2.format(Math.abs(op.mid))}</b> ${op.mid >= 0 ? 'DB' : 'CR'} · Nat ${NF2.format(Math.abs(op.nat))}`;
    if (t.mode === 'lmt' && !t.limit) $('#pLimit').placeholder = NF2.format(Math.abs(op.mid));
  }
  $('#payoffH').innerHTML = header || `<span>Profilo P&L</span><span class="lg"><span><i style="border-color:#3b8cff"></i>A scadenza</span><span><i style="border-color:#c06cf0;border-top-style:dashed"></i>Oggi (T+0)</span></span>`;
  if (!legs || !legs.length) {
    $('#stats').innerHTML = '';
    send.disabled = true; send.textContent = 'Trasmetti ordine'; send.classList.remove('sell');
    drawPayoff(null);
    return;
  }
  const an = analyze(sym, App.date, legs, cost);
  const req = pos ? marginReq(sym, App.date, legs) : marginReq(App.sym, App.date, legs);
  const contracts = legs.reduce((s, l) => s + Math.abs(l.qty), 0);
  const kv = (k, v, c = '') => `<div class="kv"><span>${k}</span><b class="${c}">${v}</b></div>`;
  const mp = an.maxProfit === Infinity ? 'Illimitato' : money(an.maxProfit, 0);
  const ml = an.maxLoss === -Infinity ? 'Illimitata' : money(an.maxLoss, 0);
  const rr = isFinite(an.maxProfit) && isFinite(an.maxLoss) && an.maxLoss < 0 ? (an.maxProfit / -an.maxLoss).toFixed(2) : '—';
  $('#stats').innerHTML =
    kv(pos ? 'Costo netto' : (cost >= 0 ? 'Debito' : 'Credito'), money(Math.abs(cost))) +
    kv('Max profitto', mp, 'up') + kv('Max perdita', ml, 'down') +
    kv('Break-even', an.breakevens.length ? an.breakevens.map(x => NF2.format(x)).join(' / ') : '—') +
    kv('Prob. profitto', (an.pop * 100).toFixed(0) + '%') + kv('Rischio/Rend.', rr) +
    kv('Delta', signed(an.greeks.delta, 1)) + kv('Theta/g', money(an.greeks.theta), cls(an.greeks.theta)) + kv('Vega', money(an.greeks.vega)) +
    kv('Margine', money(req, 0)) + kv('Commissioni', money(commissionFor(contracts))) +
    kv('Scadenza', `${expLabel(an.firstExp)} (${daysBetween(App.date, an.firstExp)}g)`);
  if (pos) { send.disabled = true; send.textContent = 'Posizione aperta'; send.classList.remove('sell'); }
  else {
    send.disabled = false;
    send.classList.toggle('sell', cost < 0);
    send.textContent = `Trasmetti · ${cost >= 0 ? 'Compra' : 'Vendi'} ${Math.max(1, +t.qty || 1)} @ ${NF2.format(Math.abs(cost / MULT / Math.max(1, +t.qty || 1)))}`;
  }
  drawPayoff(an);
}

/* ---------- grafico payoff (canvas) ---------- */
let lastPayoff = null;
function drawPayoff(an) {
  lastPayoff = an;
  const cv = $('#payoff'), dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.font = '10px IBM Plex Mono, monospace';
  if (!an) {
    g.fillStyle = '#5b6370'; g.textAlign = 'center';
    g.fillText('Il profilo di profitto/perdita appare qui', W / 2, H / 2);
    return;
  }
  const pad = { l: 58, r: 10, t: 12, b: 22 };
  const xs = an.xs, ys = [...an.expPL, ...an.nowPL];
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const m = (y1 - y0) * 0.08; y0 -= m; y1 += m;
  const X = x => pad.l + (x - xs[0]) / (xs[xs.length - 1] - xs[0]) * (W - pad.l - pad.r);
  const Y = y => pad.t + (y1 - y) / (y1 - y0) * (H - pad.t - pad.b);
  an._X = X; an._Y = Y; an._pad = pad; an._W = W; an._H = H;
  // griglia
  g.strokeStyle = '#151920'; g.fillStyle = '#5b6370'; g.lineWidth = 1; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) {
    const v = y0 + (y1 - y0) * k / 4, y = Y(v);
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke();
    g.fillText(money(v, 0), pad.l - 6, y);
  }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let k = 0; k <= 4; k++) {
    const v = xs[0] + (xs[xs.length - 1] - xs[0]) * k / 4;
    g.fillText(NF2.format(v), X(v), H - pad.b + 6);
  }
  // area profitto/perdita
  const zero = Y(0);
  for (const [sign, col] of [[1, 'rgba(43,191,110,.16)'], [-1, 'rgba(239,79,79,.16)']]) {
    g.save(); g.beginPath();
    g.rect(pad.l, sign > 0 ? pad.t : zero, W - pad.l - pad.r, sign > 0 ? zero - pad.t : H - pad.b - zero); g.clip();
    g.beginPath(); g.moveTo(X(xs[0]), zero);
    xs.forEach((x, i) => g.lineTo(X(x), Y(an.expPL[i])));
    g.lineTo(X(xs[xs.length - 1]), zero); g.closePath(); g.fillStyle = col; g.fill(); g.restore();
  }
  g.strokeStyle = '#3a4352'; g.beginPath(); g.moveTo(pad.l, zero); g.lineTo(W - pad.r, zero); g.stroke();
  // spot e ±1σ
  const sx = X(an.S0);
  g.strokeStyle = 'rgba(240,165,48,.8)'; g.setLineDash([3, 3]);
  g.beginPath(); g.moveTo(sx, pad.t); g.lineTo(sx, H - pad.b); g.stroke();
  g.strokeStyle = 'rgba(240,165,48,.25)';
  for (const s of [-1, 1]) { const x = X(an.S0 + s * an.sd); if (x > pad.l && x < W - pad.r) { g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, H - pad.b); g.stroke(); } }
  // T+0
  g.strokeStyle = '#c06cf0'; g.lineWidth = 1.25; g.setLineDash([4, 3]);
  g.beginPath(); xs.forEach((x, i) => (i ? g.lineTo(X(x), Y(an.nowPL[i])) : g.moveTo(X(x), Y(an.nowPL[i])))); g.stroke();
  // scadenza
  g.setLineDash([]); g.strokeStyle = '#3b8cff'; g.lineWidth = 2;
  g.beginPath(); xs.forEach((x, i) => (i ? g.lineTo(X(x), Y(an.expPL[i])) : g.moveTo(X(x), Y(an.expPL[i])))); g.stroke();
  // break-even
  g.fillStyle = '#d5dae2';
  for (const b of an.breakevens) { g.beginPath(); g.arc(X(b), zero, 3, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = '#f0a530'; g.textAlign = 'left'; g.textBaseline = 'top';
  g.fillText(NF2.format(an.S0), Math.min(sx + 4, W - 50), pad.t);
}

function payoffHover(e) {
  const an = lastPayoff, tip = $('#payoffTip');
  if (!an || !an._X) { tip.hidden = true; return; }
  const rect = e.target.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const xs = an.xs;
  const v = xs[0] + (px - an._pad.l) / (an._W - an._pad.l - an._pad.r) * (xs[xs.length - 1] - xs[0]);
  if (v < xs[0] || v > xs[xs.length - 1]) { tip.hidden = true; return; }
  let i = xs.findIndex(x => x >= v); if (i < 0) i = xs.length - 1;
  tip.hidden = false;
  tip.innerHTML = `${NF2.format(xs[i])} (${pct(xs[i] / an.S0 - 1)}) · scad. <span class="${cls(an.expPL[i])}">${money(an.expPL[i], 0)}</span> · oggi <span class="${cls(an.nowPL[i])}">${money(an.nowPL[i], 0)}</span>`;
}

/* ---------- portafoglio ---------- */
function renderPortfolio() {
  $$('#bottomTabs button').forEach(b => b.classList.toggle('on', b.dataset.t === App.tab));
  const a = App.acct, body = $('#portBody');
  $('#equityWrap').hidden = App.tab !== 'equity';
  body.hidden = App.tab === 'equity';
  if (App.tab === 'equity') { renderEquity(); return; }
  if (App.tab === 'bots') { renderBots(body); return; }
  if (App.tab === 'pos') {
    if (!a.positions.length) {
      body.innerHTML = `<div class="empty-state">Nessuna posizione aperta. Scegli una strategia nel <b>Strategy Builder</b> o clicca bid/ask nella catena, poi premi <b>Trasmetti ordine</b>.</div>`;
      return;
    }
    let tv = 0, tp = 0, td = 0, tt = 0, tm = 0;
    const rows = a.positions.map(g => {
      const v = groupValue(g);
      const pnl = v + g.received - g.cost - g.comm;
      const basis = Math.abs(g.cost) || 1;
      let d = 0, th = 0;
      for (const l of g.legs) { const q = legQuote(g.sym, l); d += q.delta * l.qty * MULT; th += q.theta * l.qty * MULT; }
      const mr = marginReq(g.sym, App.date, g.legs);
      const firstExp = g.legs.reduce((m, l) => (l.expiry < m ? l.expiry : m), g.legs[0].expiry);
      const dte = daysBetween(App.date, firstExp);
      tv += v; tp += pnl; td += d; tt += th; tm += mr;
      return `<tr class="${App.selectedPos === g.id ? 'sel' : ''}" data-id="${g.id}">
        <td>#${g.id} <b>${g.sym}</b> ${esc(g.name)}<div class="legtxt">${legsText(g.legs)}</div></td>
        <td>${g.openDate}</td><td><span class="pill ${dte <= 7 ? 'exp' : ''}">${dte}g</span></td>
        <td>${money(-g.cost)}</td><td>${money(v)}</td>
        <td class="${cls(pnl)}">${money(pnl)}</td><td class="${cls(pnl)}">${pct(pnl / basis)}</td>
        <td>${signed(d, 1)}</td><td class="${cls(th)}">${money(th)}</td><td>${money(mr, 0)}</td>
        <td><div class="acts"><button type="button" class="btn sm" data-act="an" data-id="${g.id}">Analizza</button><button type="button" class="btn sm danger" data-act="close" data-id="${g.id}">Chiudi</button></div></td></tr>`;
    }).join('');
    body.innerHTML = `<table class="pt"><thead><tr><th>Posizione</th><th>Apertura</th><th>DTE</th><th>Premio</th><th>Valore</th><th>P&L</th><th>P&L %</th><th>Delta</th><th>Theta/g</th><th>Margine</th><th></th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><td>Totale (${a.positions.length})</td><td></td><td></td><td></td><td>${money(tv)}</td><td class="${cls(tp)}">${money(tp)}</td><td></td><td>${signed(td, 1)}</td><td class="${cls(tt)}">${money(tt)}</td><td>${money(tm, 0)}</td><td class="muted">Chiusura a ${App.ticket.mode === 'nat' ? 'natural' : 'mid'}</td></tr></tfoot></table>`;
    return;
  }
  if (App.tab === 'closed') {
    if (!a.closed.length) { body.innerHTML = `<div class="empty-state">Le posizioni chiuse o scadute compaiono qui con il P&L realizzato.</div>`; return; }
    body.innerHTML = `<table class="pt"><thead><tr><th>Posizione</th><th>Apertura</th><th>Chiusura</th><th>Giorni</th><th>Esito</th><th>Premio</th><th>P&L netto</th><th>Commissioni</th></tr></thead><tbody>` +
      a.closed.map(g => `<tr><td>#${g.id} <b>${g.sym}</b> ${esc(g.name)}</td><td>${g.openDate}</td><td>${g.closeDate}</td><td>${daysBetween(g.openDate, g.closeDate)}</td>
        <td><span class="pill">${g.how}</span></td><td>${money(-g.cost)}</td><td class="${cls(g.pnl)}">${money(g.pnl)}</td><td>${money(g.comm)}</td></tr>`).join('') + '</tbody></table>';
    return;
  }
  if (!a.trades.length) { body.innerHTML = `<div class="empty-state">Nessun eseguito. Gli ordini trasmessi, le chiusure e le scadenze vengono registrati qui.</div>`; return; }
  body.innerHTML = `<table class="pt"><thead><tr><th>Data</th><th class="l">Tipo</th><th class="l">Dettaglio</th><th>Importo</th><th>Commissioni</th></tr></thead><tbody>` +
    a.trades.map(t => `<tr><td>${t.d}</td><td class="l">${t.kind} #${t.id}</td><td class="l">${t.sym} ${esc(t.desc)}</td><td class="${cls(t.amount)}">${money(t.amount)}</td><td>${t.comm ? money(t.comm) : '—'}</td></tr>`).join('') + '</tbody></table>';
}

let eqChart = null, eqSeries = null;
function renderEquity() {
  const a = App.acct;
  if (!eqChart) {
    eqChart = LightweightCharts.createChart($('#eqChart'), {
      autoSize: true, layout: { background: { type: 'solid', color: '#0f1217' }, textColor: CH.text, fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: CH.grid }, horzLines: { color: CH.grid } }, rightPriceScale: { borderColor: CH.line }, timeScale: { borderColor: CH.line },
      localization: { locale: 'it-IT' },
    });
    eqSeries = eqChart.addSeries(LightweightCharts.BaselineSeries, { baseValue: { type: 'price', price: a.start }, lineWidth: 2,
      topLineColor: CH.up, topFillColor1: 'rgba(43,191,110,.25)', topFillColor2: 'rgba(43,191,110,.02)',
      bottomLineColor: CH.down, bottomFillColor1: 'rgba(239,79,79,.02)', bottomFillColor2: 'rgba(239,79,79,.25)' });
  }
  eqSeries.applyOptions({ baseValue: { type: 'price', price: a.start } });
  eqSeries.setData(a.equity.map(e => ({ time: e.d, value: e.v })));
  eqChart.timeScale().fitContent();
  let peak = -Infinity, mdd = 0;
  for (const e of a.equity) { peak = Math.max(peak, e.v); mdd = Math.min(mdd, e.v / peak - 1); }
  const wins = a.closed.filter(g => g.pnl > 0).length;
  const last = a.equity[a.equity.length - 1].v;
  // benchmark: SPY nello stesso periodo
  const spyRet = closeOn('SPY', App.date) / closeOn('SPY', a.startDate) - 1;
  const kv = (k, v, c = '') => `<div class="kv"><span>${k}</span><b class="${c}">${v}</b></div>`;
  $('#eqStats').innerHTML = kv('Capitale iniziale', money(a.start, 0)) + kv('Net Liquidation', money(last)) +
    kv('Rendimento', pct(last / a.start - 1), cls(last / a.start - 1)) + kv('SPY stesso periodo', pct(spyRet), cls(spyRet)) +
    kv('Max drawdown', pct(mdd), mdd < 0 ? 'down' : '') +
    kv('Trade chiusi', `${a.closed.length} · ${a.closed.length ? Math.round(wins / a.closed.length * 100) : 0}% vincenti`) +
    kv('Commissioni pagate', money(a.commissions));
}

/* ---------- pagine (ognuna con la sua option chain, scadenza e ticket) ---------- */
const newTicket = () => ({ strat: 'custom', legs: [], qty: 1, width: 2, delta: 0.25, mode: 'mid', limit: '' });
const newPage = sym => ({ sym, expiry: null, strikesEach: 10, ticket: newTicket(), selectedPos: null });

function syncPage() {
  const p = App.pages[App.pageIdx];
  if (!p) return;
  Object.assign(p, { sym: App.sym, expiry: App.expiry, strikesEach: App.strikesEach, ticket: App.ticket, selectedPos: App.selectedPos });
}

function switchPage(i) {
  if (i === App.pageIdx || !App.pages[i]) return;
  syncPage();
  App.pageIdx = i;
  const p = App.pages[i];
  Object.assign(App, { sym: p.sym, expiry: p.expiry, strikesEach: p.strikesEach, ticket: p.ticket, selectedPos: p.selectedPos ?? null });
  onDateChanged(true);
}

function addPage(sym) {
  syncPage();
  const p = newPage(sym);
  p.ticket.strat = 'iron_condor';
  App.pages.push(p);
  switchPageRaw(App.pages.length - 1);
}
function switchPageRaw(i) {
  App.pageIdx = i;
  const p = App.pages[i];
  Object.assign(App, { sym: p.sym, expiry: p.expiry, strikesEach: p.strikesEach, ticket: p.ticket, selectedPos: null });
  onDateChanged(true);
}

function closePage(i) {
  if (App.pages.length < 2) { toast('info', 'Serve almeno una pagina'); return; }
  syncPage();
  App.pages.splice(i, 1);
  switchPageRaw(i < App.pageIdx ? App.pageIdx - 1 : Math.min(App.pageIdx, App.pages.length - 1));
}

function renderPages() {
  syncPage();
  const held = new Set(App.acct.positions.map(g => g.sym));
  const seen = {};
  $('#pagebar').innerHTML = App.pages.map((p, i) => {
    seen[p.sym] = (seen[p.sym] || 0) + 1;
    const label = seen[p.sym] > 1 ? `<small>${seen[p.sym]}</small>` : '';
    const exp = p.expiry ? `<small>${expLabel(p.expiry)}</small>` : '';
    return `<div class="ptab ${i === App.pageIdx ? 'on' : ''}" data-i="${i}" role="tab" tabindex="0" aria-selected="${i === App.pageIdx}"><span class="ps">${p.sym}</span>${label}${exp}${held.has(p.sym) ? '<i class="posdot"></i>' : ''}<button type="button" class="px" data-x="${i}" aria-label="Chiudi pagina ${p.sym}">×</button></div>`;
  }).join('') + '<button type="button" class="padd" id="pageAdd">+ Nuova pagina</button>';
}

function newPageModal() {
  stopPlay();
  const groups = [['ETF e indici', x => ETF_LIST.includes(x.symbol)], ['Titoli large cap', x => !ETF_LIST.includes(x.symbol) && !SMALL.has(x.symbol)],
    ['Small cap (ETF e titoli)', x => SMALL.has(x.symbol)]];
  const items = Market.index.filter(x => !HIDDEN.has(x.symbol));
  const draw = q => {
    const f = q.trim().toLowerCase();
    $('#symGrid').innerHTML = groups.map(([g, fn]) => {
      const list = items.filter(fn).filter(x => !f || x.symbol.toLowerCase().includes(f) || x.name.toLowerCase().includes(f));
      return list.length ? `<div class="grp">${g}</div>` + list.map(x => `<button type="button" data-s="${x.symbol}">${x.symbol}<small>${esc(x.name)}</small></button>`).join('') : '';
    }).join('') || '<div class="muted">Nessun simbolo trovato.</div>';
  };
  openModal('Nuova pagina', `<p>Ogni pagina ha la sua option chain, la sua scadenza e il suo Strategy Builder. Le posizioni e il conto restano condivisi tra tutte le pagine.</p>
    <input type="search" id="symSearch" class="inp" style="width:100%" placeholder="Cerca per simbolo o nome" autocomplete="off" aria-label="Cerca simbolo">
    <div class="symgrid" id="symGrid"></div>
    <div class="modal-actions"><button type="button" class="btn" id="mCancel">Annulla</button></div>`);
  draw('');
  $('#symSearch').oninput = e => draw(e.target.value);
  $('#symSearch').focus();
  $('#symGrid').onclick = e => { const b = e.target.closest('button[data-s]'); if (!b) return; closeModal(); addPage(b.dataset.s); };
  $('#mCancel').onclick = closeModal;
}

/* ---------- render complessivo ---------- */
function ensurePages() {
  if (!App.pages.length) {
    App.pages = [newPage(App.sym)];
    Object.assign(App.pages[0], { expiry: App.expiry, strikesEach: App.strikesEach, ticket: App.ticket });
    App.pageIdx = 0;
  }
}
function renderAll(forceRange) {
  ensurePages(); renderPages(); renderBotBadge();
  renderAcct(); renderTime(); renderWatch(); renderQuoteHeader();
  renderChart(forceRange); renderChain(); renderTicket(); renderPortfolio();
  $$('#tfSeg button').forEach(b => b.classList.toggle('on', b.dataset.tf === App.view.tf));
  $$('#rangeSeg button').forEach(b => b.classList.toggle('on', b.dataset.r === App.view.range));
  $$('#indSeg button').forEach(b => b.classList.toggle('on', !!App.view.ind[b.dataset.i]));
  $('#strikesEach').value = String(App.strikesEach);
}

/* ---------- toast e modali ---------- */
function toast(kind, title, msg) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<b>${esc(title)}</b>${msg ? `<span class="muted">${esc(msg)}</span>` : ''}`;
  $('#toasts').prepend(el);
  while ($('#toasts').children.length > 4) $('#toasts').lastChild.remove();
  setTimeout(() => el.remove(), 4200);
}

function openModal(title, html) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
}
const closeModal = () => { $('#modal').hidden = true; };

function confirmModal(title, text, okLabel, onOk) {
  stopPlay();
  openModal(title, `<p>${esc(text)}</p><div class="modal-actions"><button type="button" class="btn" id="mCancel">Annulla</button><button type="button" class="btn primary" id="mOk">${esc(okLabel)}</button></div>`);
  $('#mCancel').onclick = closeModal;
  $('#mOk').onclick = () => { closeModal(); onOk(); };
}

const CAPITALS = [[5000, 'Piccolo'], [10000, 'Base'], [25000, 'Medio-piccolo'], [50000, 'Medio'], [100000, 'Medio-grande'], [250000, 'Grande']];

function setupModal(firstRun) {
  stopPlay();
  const cal = Market.calendar;
  const minD = cal[minStartIdx()], maxD = cal[cal.length - 22];
  let cap = App.acct ? App.acct.start : 50000;
  let start = App.date || cal[Math.max(minStartIdx(), cal.length - 505)];
  const presets = [
    ['2020-01-21', 'Pre crollo COVID', 'gen 2020'], ['2022-01-03', 'Bear market', '2022'], ['2018-01-22', 'Volmageddon', 'gen 2018'],
    ['2023-01-03', 'Rally AI', '2023'], [cal[cal.length - 253], 'Un anno fa', ''], ['rnd', 'Data casuale', ''],
  ];
  openModal(firstRun ? 'Option Trading Trainer' : 'Nuova simulazione', `
    <p>Scegli capitale e giorno di partenza. Vedrai prezzi e grafici solo fino al giorno selezionato, poi avanzi nel tempo e le tue opzioni si rivalutano ogni giorno con dati storici reali degli ultimi 10 anni.</p>
    <h3>Capitale del portafoglio</h3>
    <div class="chips" id="capChips">${CAPITALS.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === cap ? 'on' : ''}">${money(v, 0)}<small>${l}</small></button>`).join('')}</div>
    <div class="modal-row" style="margin-top:8px"><label class="muted" for="capCustom">Altro importo $</label><input id="capCustom" class="inp" type="number" min="1000" step="1000" value="${cap}"></div>
    <h3>Giorno di partenza</h3>
    <div class="chips" id="dateChips">${presets.map(([d, l, s]) => `<button type="button" data-d="${d}">${l}<small>${s || (d === 'rnd' ? 'tra ' + minD.slice(0, 4) + ' e ' + maxD.slice(0, 4) : d)}</small></button>`).join('')}</div>
    <div class="modal-row" style="margin-top:8px"><label class="muted" for="startDate">Data</label><input id="startDate" class="inp" type="date" min="${minD}" max="${maxD}" value="${start}"></div>
    <div class="modal-actions">${firstRun ? '' : '<button type="button" class="btn" id="mCancel">Annulla</button>'}<button type="button" class="btn primary" id="mStart">Inizia simulazione</button></div>`);
  $('#capChips').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    cap = +b.dataset.v; $('#capCustom').value = cap;
    $$('#capChips button').forEach(x => x.classList.toggle('on', x === b));
  };
  $('#capCustom').oninput = e => { cap = +e.target.value; $$('#capChips button').forEach(x => x.classList.toggle('on', +x.dataset.v === cap)); };
  $('#dateChips').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    let d = b.dataset.d;
    if (d === 'rnd') d = cal[minStartIdx() + Math.floor(Math.random() * (cal.length - 22 - minStartIdx()))];
    $('#startDate').value = snapTradingDay(d);
  };
  if (!firstRun) $('#mCancel').onclick = closeModal;
  $('#mStart').onclick = () => {
    const c = Math.max(1000, Math.round(+$('#capCustom').value || cap));
    let d = $('#startDate').value || start;
    d = snapTradingDay(d < minD ? minD : d > maxD ? maxD : d);
    App.date = d; App.acct = newAccount(c, d); App.selectedPos = null; App.expiry = null;
    App.pages.forEach(p => { p.ticket.legs = []; p.selectedPos = null; });
    App.ticket.legs = []; App.ticket.strat = 'iron_condor';
    closeModal();
    onDateChanged();
    renderChart(true);
    toast('info', 'Simulazione avviata', `${money(c, 0)} al ${d}`);
  };
}

/* ---------- eventi ---------- */
function bind() {
  $('#back1').onclick = () => { const i = calIndex(App.date); if (i > minStartIdx()) goTo(Market.calendar[i - 1]); };
  $('#fwd1').onclick = () => advance(1);
  $('#fwd5').onclick = () => advance(5);
  $('#fwd21').onclick = () => advance(21);
  $('#play').onclick = togglePlay;
  $('#speed').onchange = () => { if (App.playTimer) { stopPlay(); togglePlay(); } };
  $('#datePick').onchange = e => goTo(e.target.value);
  $('#botToggle').onclick = toggleBot;
  $('#btnNew').onclick = () => setupModal(false);

  $('#watch').onclick = e => {
    const r = e.target.closest('.w-row'); if (!r) return;
    if (r.dataset.ro) { toast('info', 'Indice non negoziabile', 'Il VIX è mostrato come riferimento della volatilità implicita.'); return; }
    if (r.dataset.sym === App.sym) return;
    App.sym = r.dataset.sym; App.ticket.legs = []; App.selectedPos = null;
    if (App.ticket.strat !== 'custom') buildTemplate();
    renderAll(true); save();
  };

  $('#watch').ondblclick = e => {
    const r = e.target.closest('.w-row'); if (!r || r.dataset.ro) return;
    addPage(r.dataset.sym);
  };
  $('#watchFilter').oninput = e => { App.watchFilter = e.target.value; renderWatch(); };
  $('#pagebar').onclick = e => {
    const x = e.target.closest('[data-x]');
    if (x) { closePage(+x.dataset.x); return; }
    if (e.target.closest('#pageAdd')) { newPageModal(); return; }
    const t = e.target.closest('.ptab'); if (t) switchPage(+t.dataset.i);
  };
  $('#pagebar').onkeydown = e => { const t = e.target.closest('.ptab'); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); switchPage(+t.dataset.i); } };

  $('#tfSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; App.view.tf = b.dataset.tf; if (b.dataset.tf !== 'D' && ['1M', '3M'].includes(App.view.range)) App.view.range = '1Y'; renderAll(true); save(); };
  $('#rangeSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; App.view.range = b.dataset.r; renderAll(true); save(); };
  $('#indSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; App.view.ind[b.dataset.i] = !App.view.ind[b.dataset.i]; renderAll(); save(); };

  $('#expTabs').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    App.expiry = b.dataset.exp;
    if (App.ticket.strat !== 'custom') buildTemplate();
    renderChain(); renderTicket(); renderPriceLines(); save();
  };
  $('#strikesEach').onchange = e => { App.strikesEach = +e.target.value; renderChain(); save(); };
  $('#chainT').onclick = e => {
    const td = e.target.closest('td[data-a]'); if (!td) return;
    addLeg(td.dataset.t, +td.dataset.k, App.expiry, td.dataset.a === 'buy' ? 1 : -1);
  };

  $('#strats').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    App.ticket.strat = b.dataset.s; App.selectedPos = null;
    if (b.dataset.s === 'custom') App.ticket.legs = []; else buildTemplate();
    renderTicket(); renderChain(); save();
  };
  $('#pWidth').onchange = e => { App.ticket.width = +e.target.value; buildTemplate(); renderTicket(); renderChain(); save(); };
  $('#pDelta').onchange = e => { App.ticket.delta = +e.target.value; buildTemplate(); renderTicket(); renderChain(); save(); };
  $('#pQty').oninput = e => { App.ticket.qty = Math.max(1, Math.min(500, Math.floor(+e.target.value) || 1)); renderAnalysis(); save(); };
  $('#modeSeg').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    App.ticket.mode = b.dataset.m;
    if (b.dataset.m === 'lmt' && !App.ticket.limit && App.ticket.legs.length) App.ticket.limit = NF2.format(Math.abs(comboPrice(App.ticket.legs).mid));
    renderTicket(); renderPortfolio(); save();
  };
  $('#pLimit').oninput = e => { App.ticket.limit = e.target.value; renderAnalysis(); };

  $('#legs').addEventListener('change', e => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    const l = App.ticket.legs[+tr.dataset.i], f = e.target.dataset.f;
    if (f === 'q') l.qty = Math.sign(l.qty) * Math.max(1, Math.min(20, Math.floor(+e.target.value) || 1));
    if (f === 'type') l.type = e.target.value;
    if (f === 'K') l.K = +e.target.value;
    if (f === 'exp') l.expiry = e.target.value;
    App.ticket.strat = 'custom';
    renderTicket(); renderChain(); save();
  });
  $('#legs').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-i]'); const f = e.target.dataset.f; if (!tr || !f) return;
    const i = +tr.dataset.i;
    if (f === 'side') { App.ticket.legs[i].qty *= -1; App.ticket.strat = 'custom'; }
    else if (f === 'del') { App.ticket.legs.splice(i, 1); App.ticket.strat = 'custom'; }
    else return;
    renderTicket(); renderChain(); save();
  });
  $('#btnClear').onclick = () => { App.ticket.legs = []; App.ticket.strat = 'custom'; App.selectedPos = null; renderTicket(); renderChain(); save(); };
  $('#btnSend').onclick = transmit;
  $('#payoffH').addEventListener('click', e => { if (e.target.id === 'backTicket') { App.selectedPos = null; renderTicket(); renderPortfolio(); } });
  $('#payoff').addEventListener('mousemove', payoffHover);
  $('#payoff').addEventListener('mouseleave', () => { $('#payoffTip').hidden = true; });

  $('#bottomTabs').onclick = e => { const b = e.target.closest('button'); if (!b) return; App.tab = b.dataset.t; renderPortfolio(); };
  $('#portBody').onclick = e => {
    if (App.tab === 'bots') { botClick(e); return; }
    const b = e.target.closest('button[data-act]');
    if (b) {
      const id = +b.dataset.id;
      if (b.dataset.act === 'close') {
        const g = App.acct.positions.find(x => x.id === id);
        confirmModal(`Chiudere #${id} ${g.sym} ${g.name}?`, `Le gambe vengono chiuse al prezzo ${App.ticket.mode === 'nat' ? 'natural (bid/ask)' : 'mid'} del ${App.date}. Commissioni incluse.`, 'Chiudi posizione', () => closePosition(id));
      } else { selectPosition(id); }
      return;
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) selectPosition(+tr.dataset.id);
  };

  window.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea, button') || !$('#modal').hidden) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); advance(e.shiftKey ? 5 : 1); }
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  });
  window.addEventListener('resize', () => drawPayoff(lastPayoff));
}

function selectPosition(id) {
  const g = App.acct.positions.find(x => x.id === id);
  if (!g) return;
  App.selectedPos = id;
  if (g.sym !== App.sym) { App.sym = g.sym; App.ticket.legs = []; renderAll(true); }
  else { renderTicket(); renderPortfolio(); }
  $('.ticket').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- avvio ---------- */
(async function boot() {
  try {
    await loadMarket((d, n) => { $('#loadPct').textContent = Math.round(d / n * 100) + '%'; });
  } catch (e) {
    $('#loading').innerHTML = `<div class="loading-box">Impossibile caricare i dati storici (${esc(e.message)}). Apri il sito tramite un server web, non come file locale.</div>`;
    return;
  }
  initChart();
  bind();
  const st = load();
  if (st && st.acct && Market.series[st.sym] && Market.calendar.includes(st.date)) {
    Object.assign(App, { date: st.date, sym: st.sym, expiry: st.expiry, acct: st.acct, strikesEach: st.strikesEach || 10 });
    App.view = { ...App.view, ...st.view, ind: { ...App.view.ind, ...(st.view || {}).ind } };
    App.ticket = { ...App.ticket, ...st.ticket };
    App.bots = st.bots || []; App.botOn = !!st.botOn; App.botPause = st.botPause !== false;
    if (st.pages && st.pages.length && st.pages.every(p => Market.series[p.sym])) {
      App.pages = st.pages; App.pageIdx = Math.min(st.pageIdx || 0, st.pages.length - 1);
      const p = App.pages[App.pageIdx];
      Object.assign(App, { sym: p.sym, expiry: p.expiry, strikesEach: p.strikesEach || 10, ticket: p.ticket, selectedPos: null });
    }
    $('#loading').remove();
    onDateChanged();
    renderChart(true);
  } else {
    // stato iniziale d'esempio dietro al modale di setup
    const cal = Market.calendar;
    App.date = cal[cal.length - 505];
    App.acct = newAccount(50000, App.date);
    $('#loading').remove();
    onDateChanged();
    renderChart(true);
    setupModal(true);
  }
})();
