// Indicators live in indicators.json. Each source has one fetch function returning {d1, h4?, marks?}
// with rows [unixSeconds, value]. Yahoo/FRED are fetched by the GitHub Action into data/*.json;
// Binance and alternative.me allow CORS, so the browser fetches them live.
const LWC = LightweightCharts;
const COLORS = ['#58a6ff', '#3fb950', '#f2cc60', '#f0883e', '#bc8cff', '#ff7b72', '#39c5cf', '#e3b341', '#a5d6ff', '#7ee787', '#ffa198', '#d2a8ff', '#56d4dd', '#ffab70', '#b1bac4'];
const RANGES = { '1Y': 1, '5Y': 5, '10Y': 10, 'All': null };
const FED_MARKS = 12; // most recent N target-rate changes marked on the Fed series
const OWN_PANE_PX = 120;
const BINANCE_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];

const state = { range: '5Y', interval: 'd1', data: {}, errors: {}, status: {} };
let chart, indicators;

const json = async (url) => {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${new URL(url, location.href).host}`);
  return r.json();
};

async function binanceKlines(symbol, interval) {
  let lastErr;
  for (const host of BINANCE_HOSTS) {
    try {
      const rows = [];
      for (let start = 0; ; ) {
        const page = await json(`${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${start}&limit=1000`);
        rows.push(...page.map(k => [k[0] / 1000, +k[4]]));
        if (page.length < 1000) return rows;
        start = page[page.length - 1][0] + 1;
      }
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const FETCH = {
  yahoo: (ind) => json(`data/${ind.id}.json`),
  fred: (ind) => json(`data/${ind.id}.json`),
  fng: async () => {
    const r = await json('https://api.alternative.me/fng/?limit=0&format=json');
    return { d1: r.data.map(x => [+x.timestamp, +x.value]).reverse() };
  },
  binance: async (ind) => {
    const backfill = ind.backfill ? json(`data/${ind.id}_backfill.json`).catch(() => ({ d1: [] })) : { d1: [] };
    const live = Promise.all([binanceKlines(ind.symbol, '1d'), binanceKlines(ind.symbol, '4h')]);
    const [bf, [d1, h4]] = await Promise.all([backfill, live.catch(e => {
      if (!ind.backfill) throw e;
      ind.fallback = `Binance unreachable (${e.message}); showing Yahoo ${ind.backfill} daily`;
      return [[], []];
    })]);
    const first = d1.length ? d1[0][0] : Infinity;
    return { d1: [...bf.d1.filter(r => r[0] < first), ...d1], h4 };
  },
};

async function load(ind) {
  if (state.data[ind.id] || state.errors[ind.id]) return;
  try {
    const d = await FETCH[ind.source](ind);
    if (!d.d1?.length) throw new Error('no data');
    state.data[ind.id] = d;
  } catch (e) {
    const s = state.status[ind.id];
    state.errors[ind.id] = (s && !s.ok) ? s.error : String(e.message || e);
  }
}

const fmtDate = (t) => new Date(t * 1000).toISOString().slice(0, 10);

function render() {
  const keep = chart?.timeScale().getVisibleRange();
  if (chart) chart.remove();
  const el = document.getElementById('chart');
  const own = indicators.filter(i => i.on && i.scale === 'own' && state.data[i.id]).length;
  const mainPx = Math.max(360, innerHeight - 170 - OWN_PANE_PX * Math.min(own, 2));
  el.style.height = `${mainPx + OWN_PANE_PX * own + 30}px`;
  chart = LWC.createChart(el, {
    autoSize: true,
    layout: { background: { color: '#0d1117' }, textColor: '#c9d1d9', panes: { separatorColor: '#30363d' } },
    grid: { vertLines: { color: '#161b22' }, horzLines: { color: '#161b22' } },
    rightPriceScale: { borderColor: '#30363d' },
    timeScale: { borderColor: '#30363d', timeVisible: state.interval === 'h4' },
    crosshair: { mode: LWC.CrosshairMode.Normal },
  });
  chart.panes()[0].setPreserveEmptyPane(true);
  const series = [];
  for (const ind of indicators) {
    const d = state.data[ind.id];
    if (!ind.on || !d) continue;
    const rows = (state.interval === 'h4' && d.h4?.length) ? d.h4 : d.d1;
    const pane = ind.scale === 'pct' ? 0 : chart.panes().length;
    const s = chart.addSeries(LWC.LineSeries, {
      color: ind.color, lineWidth: 2, title: ind.name, priceLineVisible: false,
      priceFormat: ind.scale === 'pct' ? undefined : { type: 'price', precision: 2, minMove: 0.01 },
    }, pane);
    s.priceScale().applyOptions({ mode: ind.scale === 'pct' ? LWC.PriceScaleMode.Percentage : LWC.PriceScaleMode.Normal });
    s.setData(rows.map(([time, value]) => ({ time, value })));
    if (d.marks) {
      const times = new Set(rows.map(r => r[0]));
      LWC.createSeriesMarkers(s, d.marks.slice(-FED_MARKS).filter(m => times.has(m[0])).map(([time, ch]) => ({
        time, position: ch > 0 ? 'aboveBar' : 'belowBar', shape: ch > 0 ? 'arrowUp' : 'arrowDown',
        color: ch > 0 ? '#f85149' : '#3fb950', text: `${ch > 0 ? '+' : ''}${Math.round(ch * 100)}bp`,
      })));
    }
    series.push([ind, s]);
  }
  chart.panes().forEach((p, i) => p.setStretchFactor(i ? OWN_PANE_PX : mainPx));
  if (keep && !state.rangeChanged) chart.timeScale().setVisibleRange(keep);
  else applyRange();
  state.rangeChanged = false;

  const legend = document.getElementById('legend');
  const showLegend = (param) => {
    legend.innerHTML = series.map(([ind, s]) => {
      const v = param?.seriesData?.get(s)?.value ?? s.data().at(-1)?.value;
      return `<span style="color:${ind.color}">${ind.name}</span> ${v == null ? '–' : (+v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    }).join(' &nbsp; ');
  };
  chart.subscribeCrosshairMove(showLegend);
  showLegend();
}

function applyRange() {
  const years = RANGES[state.range];
  if (!years) return chart.timeScale().fitContent();
  const to = Date.now() / 1000;
  chart.timeScale().setVisibleRange({ from: to - years * 365.25 * 86400, to });
}

function buttons(id, options, current, onPick) {
  const box = document.getElementById(id);
  box.innerHTML = '';
  for (const [value, label] of options) {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = value === current() ? 'active' : '';
    b.onclick = () => { onPick(value); buttons(id, options, current, onPick); };
    box.appendChild(b);
  }
}

function drawToggles() {
  const box = document.getElementById('toggles');
  box.innerHTML = '';
  const cats = [...new Set(indicators.map(i => i.category))];
  for (const cat of cats) {
    const g = document.createElement('div');
    g.className = 'cat';
    g.innerHTML = `<span>${cat}</span>`;
    for (const ind of indicators.filter(i => i.category === cat)) {
      const b = document.createElement('button');
      const err = state.errors[ind.id];
      const d = state.data[ind.id];
      const note = err ? 'unavailable' : (state.interval === 'h4' && d && !d.h4?.length) ? '1D only' : (ind.scale === 'own' ? 'own axis' : '');
      b.className = 'tog' + (ind.on ? ' active' : '') + (err ? ' bad' : '');
      b.title = err ? `Unavailable: ${err}` : `${ind.source}:${ind.symbol || ind.id}`;
      b.innerHTML = `<span class="dot" style="background:${ind.color}"></span>${ind.name}${note ? `<span class="note">${note}</span>` : ''}`;
      b.onclick = async () => {
        ind.on = !ind.on;
        if (ind.on) { b.textContent = ind.name + ' …'; await load(ind); }
        drawToggles(); render(); drawStatus();
      };
      g.appendChild(b);
    }
    box.appendChild(g);
  }
}

function drawStatus() {
  const s = state.status;
  const rows = indicators.map(ind => {
    const d = state.data[ind.id], err = state.errors[ind.id];
    const last = d ? fmtDate(d.d1.at(-1)[0]) : '';
    const first = d ? fmtDate(d.d1[0][0]) : '';
    const h4 = d?.h4?.length ? `${fmtDate(d.h4[0][0])} → ${fmtDate(d.h4.at(-1)[0])}` : (d ? 'no' : '');
    const where = ['binance', 'fng'].includes(ind.source) ? 'live (browser)' : 'Actions → data/';
    const st = err ? `<span class="bad">unavailable: ${err}</span>` : ind.fallback ? `<span class="bad">${ind.fallback}</span>` : d ? 'ok' : 'not loaded (toggle on to fetch)';
    return `<tr><td>${ind.name}</td><td>${ind.source} ${ind.symbol}</td><td>${where}</td><td>${first} → ${last}</td><td>4H: ${h4}</td><td>${st}</td></tr>`;
  }).join('');
  document.getElementById('statusBody').innerHTML =
    `Actions data fetched ${s._fetched_at || '?'} UTC · FRED via ${s._fred_mode || '?'}<table><tr><th>Indicator</th><th>Source</th><th>Fetched by</th><th>Daily</th><th>4H</th><th>Status</th></tr>${rows}</table>`;
}

(async function main() {
  [indicators, state.status] = await Promise.all([json('indicators.json'), json('data/status.json').catch(() => ({}))]);
  indicators.forEach((ind, i) => { ind.color ||= COLORS[i % COLORS.length]; });
  buttons('ranges', Object.keys(RANGES).map(k => [k, k]), () => state.range, (v) => { state.range = v; applyRange(); });
  buttons('intervals', [['d1', '1D'], ['h4', '4H']], () => state.interval, (v) => { state.interval = v; state.rangeChanged = true; drawToggles(); render(); });
  drawToggles();
  await Promise.all(indicators.filter(i => i.on).map(load));
  drawToggles(); state.rangeChanged = true; render(); drawStatus();
})();
