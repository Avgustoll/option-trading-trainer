# Option Trading Trainer

Simulatore di trading in opzioni su 10 anni di dati storici reali (SPY, QQQ, IWM, AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, AMD, JPM, NFLX, DIS, KO, XOM, GLD, TLT + VIX e tassi T-bill).

## Avvio in locale
```
python3 -m http.server 8000
```
poi apri http://localhost:8000 (serve un server web: aprendo `index.html` come file i dati non si caricano).

## Pubblicazione online
È un sito statico: basta caricare la cartella così com'è su GitHub Pages, Netlify, Vercel o qualsiasi hosting.

## Aggiornare i dati
```
node scripts/fetch-data.mjs
```
Riscarica gli ultimi 10 anni da Yahoo Finance in `data/`. Per aggiungere titoli modifica l'elenco `TICKERS` nello script.

## Modello di prezzo
- Prezzi azionari: close giornalieri reali, rettificati per split e dividendi.
- IV ATM: SPY = VIX; azioni = VIX × (vol realizzata titolo / vol realizzata SPY) mescolata con la HV20 del titolo; GLD/TLT dalla sola vol storica. Solo dati fino al giorno corrente (niente look-ahead).
- Superficie: struttura a termine con ritorno alla vol di lungo periodo + skew put.
- Prezzo: Black-Scholes con tasso T-bill 13 settimane; spread bid/ask simulato.
- Ordini eseguiti al close del giorno. Commissioni $0,65/contratto (min $1).
- Margine: rischio massimo per strategie a rischio definito, Reg-T per posizioni scoperte.
- Scadenza: liquidazione in contanti al valore intrinseco.

## Trader automatico
Scheda **Automazioni** + pulsante **Bot** nella barra del tempo. Ogni regola dice: *se* [condizioni] *allora* apri [strategia].
- Condizioni (tutte insieme): IV Rank, IV, IV/HV, RSI 14, variazione 1/5 giorni, distanza dal massimo a 52 settimane, prezzo vs SMA 50/200, VIX, incroci delle medie, nuovi massimi/minimi.
- Titoli: uno solo, solo ETF, solo small cap, solo large cap oppure tutti.
- Ingresso: strategia, scadenza target, larghezza, delta, dimensione (contratti fissi o % di capitale a rischio), max posizioni, pausa tra aperture.
- Uscita: target profit, stop loss (% del premio) e chiusura a DTE.
- Le regole si valutano al close di ogni giorno simulato, anche con avanzamenti di settimane o mesi. “Verifica oggi” mostra su quali titoli la regola scatterebbe.
