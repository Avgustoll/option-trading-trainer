'use strict';
/* Trader automatico: regole "se [condizioni] allora apri [strategia]" valutate al close di ogni giorno simulato,
   con uscite per target di profitto, stop loss e DTE. Usa solo dati fino al giorno corrente. */

const METRICS = [
  { k: 'ivr', label: 'IV Rank (0-100)', def: 50 },
  { k: 'iv', label: 'IV 30g (%)', def: 30 },
  { k: 'ivhv', label: 'IV / HV20 (premio di volatilità)', def: 1.2 },
  { k: 'rsi', label: 'RSI 14', def: 30 },
  { k: 'ret1', label: 'Variazione giornaliera (%)', def: -2 },
  { k: 'ret5', label: 'Variazione 5 giorni (%)', def: -4 },
  { k: 'dd', label: 'Distanza dal massimo 52 sett. (%)', def: -10 },
  { k: 'sma50', label: 'Prezzo vs SMA 50 (%)', def: 0 },
  { k: 'sma200', label: 'Prezzo vs SMA 200 (%)', def: 0 },
  { k: 'vix', label: 'VIX', def: 25 },
  { k: 'x50up', label: 'Il prezzo incrocia SOPRA la SMA 50', ev: true },
  { k: 'x50dn', label: 'Il prezzo incrocia SOTTO la SMA 50', ev: true },
  { k: 'x200up', label: 'Il prezzo incrocia SOPRA la SMA 200', ev: true },
  { k: 'x200dn', label: 'Il prezzo incrocia SOTTO la SMA 200', ev: true },
  { k: 'newhi', label: 'Nuovo massimo a 52 settimane', ev: true },
  { k: 'newlo', label: 'Nuovo minimo a 52 settimane', ev: true },
];
const METRIC = Object.fromEntries(METRICS.map(m => [m.k, m]));

const BOT_PRESETS = [
  { name: 'Iron condor con IV alta', syms: 'SPY', conds: [{ k: 'ivr', op: '>', v: 50 }], strat: 'iron_condor', dte: 45, width: 5, delta: 0.16,
    tp: 50, sl: 200, xdte: 21, maxOpen: 2, cool: 10, risk: 2 },
  { name: 'Bull put dopo un calo', syms: 'QQQ', conds: [{ k: 'rsi', op: '<', v: 35 }, { k: 'sma200', op: '>', v: 0 }], strat: 'bull_put', dte: 30, width: 3, delta: 0.25,
    tp: 50, sl: 200, xdte: 14, maxOpen: 2, cool: 7, risk: 2 },
  { name: 'Long call su incrocio SMA 50', syms: 'ETF', conds: [{ k: 'x50up', op: '>', v: 0 }], strat: 'long_call', dte: 60, width: 2, delta: 0.3,
    tp: 100, sl: 50, xdte: 14, maxOpen: 3, cool: 10, risk: 1 },
  { name: 'Short strangle su titoli ad alta IV', syms: 'ALL', conds: [{ k: 'ivr', op: '>', v: 75 }, { k: 'ivhv', op: '>', v: 1.15 }], strat: 'short_strangle', dte: 45, width: 2, delta: 0.16,
    tp: 50, sl: 200, xdte: 21, maxOpen: 3, cool: 15, risk: 3 },
  { name: 'Straddle su VIX estremo', syms: 'SPY', conds: [{ k: 'vix', op: '>', v: 30 }], strat: 'short_straddle', dte: 30, width: 2, delta: 0.25,
    tp: 40, sl: 150, xdte: 7, maxOpen: 1, cool: 20, risk: 3 },
];

function newRule(p = {}) {
  return { id: Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36), name: 'Nuova regola', on: true, syms: 'SPY',
    conds: [{ k: 'ivr', op: '>', v: 50 }], strat: 'iron_condor', dte: 45, width: 2, delta: 0.16, sizeMode: 'risk', qty: 1, risk: 2,
    maxOpen: 2, cool: 5, tp: 50, sl: 200, xdte: 21, ...JSON.parse(JSON.stringify(p)) };
}

/* ---------- indicatori ---------- */
const IndCache = {};
function smaArr(c, w) {
  const n = c.length, o = new Float64Array(n).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) { s += c[i]; if (i >= w) s -= c[i - w]; if (i >= w - 1) o[i] = s / w; }
  return o;
}
function rsiArr(c, p = 14) {
  const n = c.length, o = new Float64Array(n).fill(NaN);
  let ag = 0, al = 0;
  for (let i = 1; i < n; i++) {
    const d = c[i] - c[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= p) { ag += g / p; al += l / p; } else { ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + l) / p; }
    if (i >= p) o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return o;
}
function inds(sym) {
  if (IndCache[sym]) return IndCache[sym];
  const s = Market.series[sym], c = s.c, n = c.length;
  const hi = new Float64Array(n).fill(NaN), lo = new Float64Array(n).fill(NaN), ivr = new Float64Array(n).fill(NaN);
  const iv = ivSeries(sym);
  for (let i = 252; i < n; i++) {
    let h = -Infinity, l = Infinity;
    for (let j = i - 252; j < i; j++) { if (c[j] > h) h = c[j]; if (c[j] < l) l = c[j]; }
    hi[i] = h; lo[i] = l;
  }
  for (let i = 60; i < n; i++) {
    let h = -Infinity, l = Infinity;
    for (let j = Math.max(0, i - 251); j <= i; j++) { if (iv[j] > h) h = iv[j]; if (iv[j] < l) l = iv[j]; }
    ivr[i] = h > l ? (iv[i] - l) / (h - l) * 100 : 50;
  }
  return (IndCache[sym] = { s50: smaArr(c, 50), s200: smaArr(c, 200), rsi: rsiArr(c), hi, lo, ivr, iv });
}

function metric(sym, k, date) {
  const s = Market.series[sym], i = atOrBefore(s, date);
  if (i < 1) return NaN;
  const I = inds(sym), c = s.c;
  switch (k) {
    case 'ivr': return I.ivr[i];
    case 'iv': return I.iv[i] * 100;
    case 'ivhv': return I.iv[i] / Math.max(0.01, s.hv20[i]);
    case 'rsi': return I.rsi[i];
    case 'ret1': return (c[i] / c[i - 1] - 1) * 100;
    case 'ret5': return i >= 5 ? (c[i] / c[i - 5] - 1) * 100 : NaN;
    case 'dd': return (c[i] / Math.max(I.hi[i], c[i]) - 1) * 100;
    case 'sma50': return (c[i] / I.s50[i] - 1) * 100;
    case 'sma200': return (c[i] / I.s200[i] - 1) * 100;
    case 'vix': { const v = Market.series['^VIX']; return v.c[Math.max(0, atOrBefore(v, date))]; }
    case 'x50up': return c[i - 1] < I.s50[i - 1] && c[i] >= I.s50[i] ? 1 : 0;
    case 'x50dn': return c[i - 1] > I.s50[i - 1] && c[i] <= I.s50[i] ? 1 : 0;
    case 'x200up': return c[i - 1] < I.s200[i - 1] && c[i] >= I.s200[i] ? 1 : 0;
    case 'x200dn': return c[i - 1] > I.s200[i - 1] && c[i] <= I.s200[i] ? 1 : 0;
    case 'newhi': return c[i] > I.hi[i] ? 1 : 0;
    case 'newlo': return c[i] < I.lo[i] ? 1 : 0;
  }
  return NaN;
}

function condsMet(sym, conds, date) {
  return conds.every(cd => {
    const m = metric(sym, cd.k, date);
    if (!isFinite(m)) return false;
    if (METRIC[cd.k].ev) return m === 1;
    return cd.op === '>' ? m > cd.v : m < cd.v;
  });
}

const condText = cd => METRIC[cd.k].ev ? METRIC[cd.k].label : `${METRIC[cd.k].label} ${cd.op} ${NF2.format(cd.v)}`;
const tradableSyms = () => Market.index.filter(x => !HIDDEN.has(x.symbol)).map(x => x.symbol);
function botUniverse(syms) {
  if (syms === 'ALL') return tradableSyms();
  if (syms === 'ETF') return ETF_LIST.filter(s => Market.series[s]);
  return Market.series[syms] ? [syms] : [];
}
const symsLabel = syms => (syms === 'ALL' ? `Tutti (${tradableSyms().length})` : syms === 'ETF' ? `ETF (${ETF_LIST.length})` : syms);

/* ---------- esecuzione ---------- */
function botLog(rule, sym, msg) {
  const a = App.acct;
  (a.botLog = a.botLog || []).unshift({ d: App.date, rule: rule ? rule.name : 'Uscita', sym, msg });
  if (a.botLog.length > 300) a.botLog.length = 300;
}

function botOpen(rule, sym) {
  const date = App.date, a = App.acct;
  const target = rule.dte;
  const exps = expirations(date).filter(e => daysBetween(date, e) >= Math.max(5, target * 0.6));
  if (!exps.length) return false;
  const exp = exps.reduce((b, e) => (Math.abs(daysBetween(date, e) - target) < Math.abs(daysBetween(date, b) - target) ? e : b));
  const st = STRATEGIES.find(s => s.id === rule.strat);
  if (!st || !st.build) return false;
  const legs1 = st.build(strategyContext(sym, date, exp, rule.width, rule.delta));
  let mid = 0;
  for (const l of legs1) mid += l.qty * legQuote(sym, l).mid;
  const px = Math.round(mid * 100) / 100;
  if (Math.abs(px) < 0.01) return false;
  const an = analyze(sym, date, legs1, px * MULT);
  const unitRisk = isFinite(an.maxLoss) && an.maxLoss < 0 ? -an.maxLoss : marginReq(sym, date, legs1);
  let n = Math.max(1, Math.floor(+rule.qty || 1));
  if (rule.sizeMode === 'risk') {
    n = Math.floor(totals().netLiq * (rule.risk / 100) / Math.max(1, unitRisk));
    if (n < 1) { botLog(rule, sym, `Segnale ignorato: rischio per contratto ${money(unitRisk, 0)} oltre il budget del ${rule.risk}%.`); return false; }
  }
  const legs = legs1.map(l => ({ ...l, qty: l.qty * n, open: legQuote(sym, l).mid }));
  const cost = px * MULT * n;
  const comm = commissionFor(legs.reduce((s, l) => s + Math.abs(l.qty), 0));
  const marginNow = a.positions.reduce((s, g) => s + marginReq(g.sym, date, g.legs), 0);
  const req = marginReq(sym, date, legs);
  if (a.cash - cost - comm - marginNow - req < 0) { botLog(rule, sym, 'Segnale ignorato: buying power insufficiente.'); return false; }
  const g = { id: a.nextId++, sym, name: st.name, openDate: date, legs, n, cost, comm, received: 0, openPx: px,
    bot: rule.id, botName: rule.name, premium: Math.max(Math.abs(cost), 10), exit: { tp: rule.tp, sl: rule.sl, dte: rule.xdte } };
  a.cash -= cost + comm; a.commissions += comm; a.positions.push(g);
  logTrade('Apertura', g, `[${rule.name}] ${st.name} ${n}× ${legsText(legs1)} @ ${NF2.format(Math.abs(px))} ${px >= 0 ? 'DB' : 'CR'}`, -cost, comm);
  const why = rule.conds.map(condText).join(' e ');
  botLog(rule, sym, `Aperto #${g.id} ${st.name} ${n}× @ ${NF2.format(Math.abs(px))} ${px >= 0 ? 'DB' : 'CR'} (${why})`);
  toast('ok', `Bot: ${sym} ${st.name}`, `${rule.name} · ${n}× @ ${NF2.format(Math.abs(px))} ${px >= 0 ? 'debito' : 'credito'}`);
  (a.botState = a.botState || {})[rule.id + sym] = date;
  return true;
}

function botExits() {
  const a = App.acct;
  let acts = 0;
  for (const g of [...a.positions]) {
    if (!g.exit) continue;
    const pnl = groupValue(g) + g.received - g.cost - g.comm;
    const dte = daysBetween(App.date, g.legs.reduce((m, l) => (l.expiry < m ? l.expiry : m), g.legs[0].expiry));
    let how = null;
    if (g.exit.tp > 0 && pnl >= g.exit.tp / 100 * g.premium) how = 'target profit';
    else if (g.exit.sl > 0 && pnl <= -g.exit.sl / 100 * g.premium) how = 'stop loss';
    else if (g.exit.dte > 0 && dte <= g.exit.dte) how = 'uscita DTE';
    if (!how) continue;
    botLog({ name: g.botName }, g.sym, `Chiuso #${g.id} ${g.name} per ${how}, P&L ${money(pnl)}`);
    closePosition(g.id, how);
    acts++;
  }
  return acts;
}

function botScan(rule) {
  const a = App.acct;
  const open = a.positions.filter(g => g.bot === rule.id);
  if (open.length >= rule.maxOpen) return 0;
  const list = botUniverse(rule.syms);
  if (!list.length) return 0;
  const off = calIndex(App.date) % list.length;
  let acts = 0, count = open.length;
  for (let k = 0; k < list.length && count < rule.maxOpen && acts < 3; k++) {
    const sym = list[(k + off) % list.length];
    if (a.positions.some(g => g.bot === rule.id && g.sym === sym)) continue;
    const last = (a.botState || {})[rule.id + sym];
    if (last && daysBetween(last, App.date) < rule.cool) continue;
    if (!condsMet(sym, rule.conds, App.date)) continue;
    if (botOpen(rule, sym)) { acts++; count++; }
  }
  return acts;
}

function runBots() {
  if (!App.botOn) return 0;
  let acts = botExits();
  for (const rule of App.bots) if (rule.on) acts += botScan(rule);
  return acts;
}

/* ---------- interfaccia ---------- */
function renderBotBadge() {
  const b = $('#botToggle');
  if (!b) return;
  b.classList.toggle('on', App.botOn);
  b.textContent = App.botOn ? `Bot: ON (${App.bots.filter(r => r.on).length})` : 'Bot: OFF';
}

function renderBots(body) {
  const a = App.acct;
  const rows = App.bots.map(r => {
    const open = a.positions.filter(g => g.bot === r.id), closed = a.closed.filter(g => g.bot === r.id);
    const real = closed.reduce((s, g) => s + g.pnl, 0);
    const unreal = open.reduce((s, g) => s + groupValue(g) + g.received - g.cost - g.comm, 0);
    const wins = closed.filter(g => g.pnl > 0).length;
    const st = STRATEGIES.find(s => s.id === r.strat);
    return `<tr data-id="${r.id}">
      <td class="l"><label><input type="checkbox" data-bot="on" data-id="${r.id}" ${r.on ? 'checked' : ''} aria-label="Attiva regola"> <b>${esc(r.name)}</b></label>
        <div class="legtxt">SE ${r.conds.map(condText).map(esc).join(' E ')}</div></td>
      <td class="l">${symsLabel(r.syms)}</td>
      <td class="l">${esc(st ? st.name : r.strat)}<div class="legtxt">${r.dte}g · delta ${NF2.format(r.delta)} · ${r.sizeMode === 'risk' ? 'rischio ' + r.risk + '%' : r.qty + ' contr.'}</div></td>
      <td class="l legtxt">TP ${r.tp || '—'}% · SL ${r.sl || '—'}% · DTE ≤ ${r.xdte || '—'}</td>
      <td>${open.length}/${r.maxOpen}</td><td>${closed.length}${closed.length ? ` · ${Math.round(wins / closed.length * 100)}%` : ''}</td>
      <td class="${cls(real)}">${money(real)}</td><td class="${cls(unreal)}">${money(unreal)}</td>
      <td><div class="acts"><button type="button" class="btn sm" data-bot="edit" data-id="${r.id}">Modifica</button><button type="button" class="btn sm danger" data-bot="del" data-id="${r.id}">Elimina</button></div></td></tr>`;
  }).join('');
  const log = (a.botLog || []).slice(0, 60).map(l => `<tr><td class="l">${l.d}</td><td class="l">${esc(l.rule)}</td><td class="l"><b>${l.sym}</b></td><td class="l">${esc(l.msg)}</td></tr>`).join('');
  body.innerHTML = `<div class="bot-head">
      <span class="${App.botOn ? 'up' : 'muted'}"><b>Trader automatico ${App.botOn ? 'attivo' : 'spento'}</b></span>
      <button type="button" class="btn sm" data-bot="master">${App.botOn ? 'Spegni' : 'Accendi'}</button>
      <label class="mini"><input type="checkbox" data-bot="pause" ${App.botPause ? 'checked' : ''}> Ferma il Play a ogni operazione</label>
      <span class="muted bot-note">Le regole girano al close di ogni giorno simulato (anche con avanzamento di settimane o mesi).</span>
      <button type="button" class="btn sm primary" data-bot="new">+ Nuova regola</button></div>` +
    (App.bots.length ? `<table class="pt"><thead><tr><th class="l">Regola</th><th class="l">Titoli</th><th class="l">Strategia</th><th class="l">Uscite</th><th>Aperte</th><th>Chiuse · Win</th><th>P&L real.</th><th>P&L non real.</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="empty-state">Nessuna regola. Crea una regola come <b>“se IV Rank &gt; 50 apri un iron condor su SPY”</b>, accendi il bot e fai avanzare il tempo.</div>`) +
    `<div class="bot-log-h">Registro del bot</div>` +
    (log ? `<table class="pt"><thead><tr><th class="l">Data</th><th class="l">Regola</th><th class="l">Titolo</th><th class="l">Evento</th></tr></thead><tbody>${log}</tbody></table>`
      : `<div class="empty-state">Le aperture e le chiusure automatiche compaiono qui.</div>`);
}

function botClick(e) {
  const b = e.target.closest('[data-bot]'); if (!b) return;
  const act = b.dataset.bot, id = b.dataset.id;
  if (act === 'on') { const r = App.bots.find(x => x.id === id); r.on = b.checked; renderBotBadge(); save(); }
  else if (act === 'pause') { App.botPause = b.checked; save(); }
  else if (act === 'master') toggleBot();
  else if (act === 'new') ruleModal(null);
  else if (act === 'edit') ruleModal(App.bots.find(x => x.id === id));
  else if (act === 'del') {
    const r = App.bots.find(x => x.id === id);
    confirmModal(`Eliminare “${r.name}”?`, 'Le posizioni già aperte restano nel portafoglio e continuano a essere gestite con le loro uscite.', 'Elimina regola',
      () => { App.bots = App.bots.filter(x => x.id !== id); renderBotBadge(); renderPortfolio(); save(); });
  }
}

function toggleBot() {
  App.botOn = !App.botOn;
  if (App.botOn && !App.bots.length) { App.tab = 'bots'; toast('info', 'Bot acceso senza regole', 'Crea una regola nella scheda Automazioni.'); }
  renderBotBadge(); renderPortfolio(); save();
}

function ruleModal(existing) {
  stopPlay();
  const draft = existing ? JSON.parse(JSON.stringify(existing)) : newRule();
  const symOpts = [['ALL', 'Tutti i titoli e ETF'], ['ETF', 'Solo ETF'], ...tradableSyms().map(s => [s, s])];
  const opt = (v, l, cur) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${l}</option>`;
  const condRows = () => draft.conds.map((cd, i) => {
    const ev = METRIC[cd.k].ev;
    return `<div class="cond-row" data-i="${i}">
      <select class="sel" data-f="k" aria-label="Indicatore">${METRICS.map(m => opt(m.k, m.label, cd.k)).join('')}</select>
      ${ev ? '' : `<select class="sel" data-f="op" aria-label="Operatore">${opt('>', 'maggiore di', cd.op)}${opt('<', 'minore di', cd.op)}</select>
      <input class="inp" type="number" step="any" data-f="v" value="${cd.v}" aria-label="Valore">`}
      <button type="button" class="x" data-f="del" aria-label="Rimuovi condizione">×</button></div>`;
  }).join('');
  const html = `
    ${existing ? '' : `<div class="modal-row"><label class="muted" for="rfPreset">Parti da un modello</label><select id="rfPreset" class="sel"><option value="">— regola vuota —</option>${BOT_PRESETS.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}</select></div>`}
    <h3>Regola</h3>
    <div class="fgrid">
      <label class="fw">Nome<input id="rfName" class="inp" style="width:100%" value="${esc(draft.name)}"></label>
      <label class="fw">Titoli da monitorare<select id="rfSyms" class="sel" style="width:100%">${symOpts.map(([v, l]) => opt(v, l, draft.syms)).join('')}</select></label>
    </div>
    <h3>Quando (tutte le condizioni insieme)</h3>
    <div id="rfConds" class="conds">${condRows()}</div>
    <div class="modal-row" style="margin-top:6px"><button type="button" class="btn sm" id="rfAddCond">+ Condizione</button><button type="button" class="btn sm" id="rfCheck">Verifica oggi (${App.date})</button></div>
    <div id="rfCheckOut" class="muted" style="margin-top:6px"></div>
    <h3>Allora apri</h3>
    <div class="fgrid">
      <label>Strategia<select id="rfStrat" class="sel">${STRATEGIES.filter(s => s.build).map(s => opt(s.id, s.name, draft.strat)).join('')}</select></label>
      <label>Scadenza target<select id="rfDte" class="sel">${[7, 14, 21, 30, 45, 60, 90].map(d => opt(d, d + ' giorni', draft.dte)).join('')}</select></label>
      <label>Larghezza<select id="rfWidth" class="sel">${[1, 2, 3, 5, 10].map(d => opt(d, d + ' strike', draft.width)).join('')}</select></label>
      <label>Delta short<select id="rfDelta" class="sel">${[0.1, 0.16, 0.2, 0.25, 0.3, 0.4].map(d => opt(d, NF2.format(d), draft.delta)).join('')}</select></label>
      <label>Dimensione<select id="rfSizeMode" class="sel">${opt('risk', 'Rischio % del capitale', draft.sizeMode)}${opt('fixed', 'Contratti fissi', draft.sizeMode)}</select></label>
      <label id="rfRiskL">Rischio per trade (%)<input id="rfRisk" class="inp" type="number" min="0.1" max="50" step="0.1" value="${draft.risk}"></label>
      <label id="rfQtyL">Contratti<input id="rfQty" class="inp" type="number" min="1" max="500" value="${draft.qty}"></label>
      <label>Max posizioni aperte<input id="rfMax" class="inp" type="number" min="1" max="50" value="${draft.maxOpen}"></label>
      <label>Pausa dopo apertura (giorni)<input id="rfCool" class="inp" type="number" min="0" max="365" value="${draft.cool}"></label>
    </div>
    <h3>Gestione della posizione (0 = disattivato)</h3>
    <div class="fgrid">
      <label>Target profit (% del premio)<input id="rfTp" class="inp" type="number" min="0" value="${draft.tp}"></label>
      <label>Stop loss (% del premio)<input id="rfSl" class="inp" type="number" min="0" value="${draft.sl}"></label>
      <label>Chiudi a DTE ≤<input id="rfXdte" class="inp" type="number" min="0" value="${draft.xdte}"></label>
    </div>
    <p class="muted" style="margin:8px 0 0">Il premio è il credito incassato o il debito pagato all'apertura. Esempio classico per le vendite di premio: target 50%, stop 200%.</p>
    <div class="modal-actions"><button type="button" class="btn" id="mCancel">Annulla</button><button type="button" class="btn primary" id="mSave">Salva regola</button></div>`;
  openModal(existing ? 'Modifica regola' : 'Nuova regola automatica', html);
  $('.modal-box').style.width = 'min(680px, 100%)';

  const syncSize = () => { const r = $('#rfSizeMode').value === 'risk'; $('#rfRiskL').hidden = !r; $('#rfQtyL').hidden = r; };
  syncSize();
  $('#rfSizeMode').onchange = syncSize;
  const redrawConds = () => { $('#rfConds').innerHTML = condRows(); $('#rfCheckOut').textContent = ''; };
  $('#rfConds').addEventListener('change', e => {
    const row = e.target.closest('.cond-row'); if (!row) return;
    const cd = draft.conds[+row.dataset.i], f = e.target.dataset.f;
    if (f === 'k') { cd.k = e.target.value; if (!METRIC[cd.k].ev) cd.v = METRIC[cd.k].def; redrawConds(); }
    else if (f === 'op') cd.op = e.target.value;
    else if (f === 'v') cd.v = parseFloat(e.target.value) || 0;
  });
  $('#rfConds').addEventListener('click', e => {
    if (e.target.dataset.f !== 'del') return;
    draft.conds.splice(+e.target.closest('.cond-row').dataset.i, 1); redrawConds();
  });
  $('#rfAddCond').onclick = () => { draft.conds.push({ k: 'rsi', op: '<', v: 30 }); redrawConds(); };
  $('#rfCheck').onclick = () => {
    if (!draft.conds.length) { $('#rfCheckOut').textContent = 'Aggiungi almeno una condizione.'; return; }
    const list = botUniverse($('#rfSyms').value);
    const hit = list.filter(s => condsMet(s, draft.conds, App.date));
    $('#rfCheckOut').innerHTML = hit.length
      ? `Oggi la regola scatta su <b>${hit.length}</b> di ${list.length}: ${hit.slice(0, 24).join(', ')}${hit.length > 24 ? '…' : ''}`
      : `Oggi la regola non scatta su nessuno dei ${list.length} titoli.`;
  };
  if (!existing) $('#rfPreset').onchange = e => {
    if (e.target.value === '') return;
    const p = BOT_PRESETS[+e.target.value];
    Object.assign(draft, newRule({ ...p, id: draft.id, sizeMode: 'risk', qty: 1 }));
    closeModal(); ruleModalFrom(draft);
  };
  $('#mCancel').onclick = closeModal;
  $('#mSave').onclick = () => {
    if (!draft.conds.length) { $('#rfCheckOut').textContent = 'Aggiungi almeno una condizione.'; return; }
    const num = (id, d, min, max) => Math.min(max, Math.max(min, parseFloat($(id).value) || d));
    Object.assign(draft, {
      name: $('#rfName').value.trim() || 'Regola senza nome', syms: $('#rfSyms').value, strat: $('#rfStrat').value,
      dte: +$('#rfDte').value, width: +$('#rfWidth').value, delta: +$('#rfDelta').value, sizeMode: $('#rfSizeMode').value,
      risk: num('#rfRisk', 2, 0.1, 50), qty: Math.floor(num('#rfQty', 1, 1, 500)), maxOpen: Math.floor(num('#rfMax', 2, 1, 50)),
      cool: Math.floor(num('#rfCool', 5, 0, 365)), tp: num('#rfTp', 0, 0, 10000), sl: num('#rfSl', 0, 0, 10000), xdte: Math.floor(num('#rfXdte', 0, 0, 365)),
    });
    const i = App.bots.findIndex(r => r.id === draft.id);
    if (i >= 0) App.bots[i] = draft; else App.bots.push(draft);
    closeModal(); App.tab = 'bots'; renderBotBadge(); renderPortfolio(); save();
    toast('ok', 'Regola salvata', App.botOn ? draft.name : 'Accendi il bot (pulsante “Bot”) per attivarla.');
  };
}

/* riapre l'editor con una bozza già compilata (usato dai modelli) */
function ruleModalFrom(draft) {
  const fake = JSON.parse(JSON.stringify(draft));
  ruleModal(fake);
  $('#modalTitle').textContent = 'Nuova regola automatica';
}
