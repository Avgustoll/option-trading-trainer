'use strict';
/* Modelli di strategia: ogni build restituisce i leg per 1 unità (qty con segno). */

const STRATEGIES = [
  { id: 'custom', name: 'Personalizzata', group: 'Base', desc: 'Clicca Bid (vendi) o Ask (compra) nella catena per aggiungere leg.' },
  { id: 'long_call', name: 'Long Call', group: 'Base', build: c => [leg('C', c.atm, c.exp, 1)] },
  { id: 'long_put', name: 'Long Put', group: 'Base', build: c => [leg('P', c.atm, c.exp, 1)] },
  { id: 'short_call', name: 'Short Call', group: 'Base', build: c => [leg('C', c.byDelta('C', c.delta), c.exp, -1)] },
  { id: 'short_put', name: 'Short Put', group: 'Base', build: c => [leg('P', c.byDelta('P', c.delta), c.exp, -1)] },

  { id: 'bull_call', name: 'Bull Call (debit)', group: 'Vertical',
    build: c => [leg('C', c.atm, c.exp, 1), leg('C', c.off(c.atm, c.width), c.exp, -1)] },
  { id: 'bear_put', name: 'Bear Put (debit)', group: 'Vertical',
    build: c => [leg('P', c.atm, c.exp, 1), leg('P', c.off(c.atm, -c.width), c.exp, -1)] },
  { id: 'bull_put', name: 'Bull Put (credit)', group: 'Vertical',
    build: c => { const k = c.byDelta('P', c.delta); return [leg('P', k, c.exp, -1), leg('P', c.off(k, -c.width), c.exp, 1)]; } },
  { id: 'bear_call', name: 'Bear Call (credit)', group: 'Vertical',
    build: c => { const k = c.byDelta('C', c.delta); return [leg('C', k, c.exp, -1), leg('C', c.off(k, c.width), c.exp, 1)]; } },

  { id: 'long_straddle', name: 'Long Straddle', group: 'Volatilità',
    build: c => [leg('C', c.atm, c.exp, 1), leg('P', c.atm, c.exp, 1)] },
  { id: 'short_straddle', name: 'Short Straddle', group: 'Volatilità',
    build: c => [leg('C', c.atm, c.exp, -1), leg('P', c.atm, c.exp, -1)] },
  { id: 'long_strangle', name: 'Long Strangle', group: 'Volatilità',
    build: c => [leg('C', c.byDelta('C', c.delta), c.exp, 1), leg('P', c.byDelta('P', c.delta), c.exp, 1)] },
  { id: 'short_strangle', name: 'Short Strangle', group: 'Volatilità',
    build: c => [leg('C', c.byDelta('C', c.delta), c.exp, -1), leg('P', c.byDelta('P', c.delta), c.exp, -1)] },

  { id: 'iron_condor', name: 'Iron Condor', group: 'Condor',
    build: c => {
      const kp = c.byDelta('P', c.delta), kc = c.byDelta('C', c.delta);
      return [leg('P', c.off(kp, -c.width), c.exp, 1), leg('P', kp, c.exp, -1),
        leg('C', kc, c.exp, -1), leg('C', c.off(kc, c.width), c.exp, 1)];
    } },
  { id: 'iron_fly', name: 'Iron Butterfly', group: 'Condor',
    build: c => [leg('P', c.off(c.atm, -c.width), c.exp, 1), leg('P', c.atm, c.exp, -1),
      leg('C', c.atm, c.exp, -1), leg('C', c.off(c.atm, c.width), c.exp, 1)] },
  { id: 'reverse_ic', name: 'Reverse Iron Condor', group: 'Condor',
    build: c => {
      const kp = c.byDelta('P', c.delta), kc = c.byDelta('C', c.delta);
      return [leg('P', c.off(kp, -c.width), c.exp, -1), leg('P', kp, c.exp, 1),
        leg('C', kc, c.exp, 1), leg('C', c.off(kc, c.width), c.exp, -1)];
    } },
];

function leg(type, K, expiry, qty) { return { type, K, expiry, qty }; }

function strategyContext(sym, date, exp, width, delta) {
  const S = closeOn(sym, date);
  const step = strikeStep(sym, S);
  return {
    exp, width, delta,
    atm: roundStrike(S, step),
    off: (k, n) => roundStrike(k + n * step, step),
    byDelta: (t, d) => strikeByDelta(sym, date, t, exp, d),
  };
}

/* riconosce il nome di una combinazione di leg arbitraria (per le posizioni personalizzate) */
function describeLegs(legs) {
  const sig = legs.map(l => `${l.qty > 0 ? '+' : '-'}${l.type}`).sort().join('');
  const map = { '+C': 'Long Call', '+P': 'Long Put', '-C': 'Short Call', '-P': 'Short Put',
    '+C-C': 'Vertical Call', '+P-P': 'Vertical Put', '+C+P': 'Long Strangle/Straddle', '-C-P': 'Short Strangle/Straddle',
    '+C+P-C-P': 'Iron Condor/Fly' };
  const exps = new Set(legs.map(l => l.expiry));
  if (legs.length === 2 && exps.size === 2 && legs[0].type === legs[1].type && legs[0].K === legs[1].K) return 'Calendar';
  return map[sig] || 'Combo';
}
