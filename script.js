const $ = id => document.getElementById(id);
const fmt = (n, d=2) => (n===null||n===undefined||isNaN(n)) ? '—' : Number(n).toFixed(d);

// ---------- INDICATORS ----------
function ema(values, period){
  const k = 2/(period+1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for(let i=0;i<values.length;i++){
    if(i < period-1){ continue; }
    if(i === period-1){
      const slice = values.slice(0, period);
      prev = slice.reduce((a,b)=>a+b,0)/period;
      out[i] = prev;
      continue;
    }
    prev = values[i]*k + prev*(1-k);
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period=14){
  const out = new Array(closes.length).fill(null);
  let gains=0, losses=0;
  for(let i=1;i<=period;i++){
    const diff = closes[i]-closes[i-1];
    if(diff>=0) gains+=diff; else losses-=diff;
  }
  let avgGain = gains/period, avgLoss = losses/period;
  out[period] = avgLoss===0 ? 100 : 100-(100/(1+(avgGain/avgLoss)));
  for(let i=period+1;i<closes.length;i++){
    const diff = closes[i]-closes[i-1];
    const gain = diff>0?diff:0, loss = diff<0?-diff:0;
    avgGain = (avgGain*(period-1)+gain)/period;
    avgLoss = (avgLoss*(period-1)+loss)/period;
    out[i] = avgLoss===0 ? 100 : 100-(100/(1+(avgGain/avgLoss)));
  }
  return out;
}

function atr(highs, lows, closes, period=14){
  const tr = new Array(closes.length).fill(null);
  for(let i=0;i<closes.length;i++){
    if(i===0){ tr[i] = highs[i]-lows[i]; continue; }
    tr[i] = Math.max(
      highs[i]-lows[i],
      Math.abs(highs[i]-closes[i-1]),
      Math.abs(lows[i]-closes[i-1])
    );
  }
  const out = new Array(closes.length).fill(null);
  let prev = null;
  for(let i=0;i<tr.length;i++){
    if(i < period-1) continue;
    if(i === period-1){
      prev = tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
      out[i]=prev; continue;
    }
    prev = (prev*(period-1)+tr[i])/period;
    out[i]=prev;
  }
  return out;
}

// ---------- FETCH ----------
async function fetchOHLC(symbol, interval, apikey){
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=260&apikey=${encodeURIComponent(apikey)}`;
  const res = await fetch(url);
  const data = await res.json();
  if(data.status === 'error' || data.code){
    throw new Error(data.message || 'Gagal mengambil data dari Twelvedata.');
  }
  if(!data.values){ throw new Error('Data tidak ditemukan untuk symbol/timeframe ini.'); }
  const rows = data.values.slice().reverse(); // chronological ascending
  return rows.map(r=>({
    time: r.datetime,
    open: parseFloat(r.open),
    high: parseFloat(r.high),
    low: parseFloat(r.low),
    close: parseFloat(r.close),
    volume: r.volume!==undefined ? parseFloat(r.volume) : null
  }));
}

// ---------- ANALYSIS PIPELINE ----------
function runAnalysis(candles){
  const n = candles.length;
  const closes = candles.map(c=>c.close);
  const highs = candles.map(c=>c.high);
  const lows = candles.map(c=>c.low);
  const opens = candles.map(c=>c.open);
  const vols = candles.map(c=>c.volume);

  const ema50 = ema(closes,50);
  const ema200 = ema(closes,200);
  const rsiArr = rsi(closes,14);
  const atrArr = atr(highs,lows,closes,14);

  const last = n-1;          // candle terakhir tertutup (trigger candle)
  const cand = n-2;          // kandidat swing
  const prior = n-3;         // pembanding kandidat

  const result = {
    valid:false, direction:'NONE', reasons:[],
    trendOK:false, trendLabel:'No Trend / Crossing',
    rsiOK:false, atrOK:false, sweepOK:false, swingOK:false, volOK:false,
    confidence:0
  };

  if(ema50[last]==null || ema200[last]==null || ema50[prior]==null || ema200[prior]==null){
    result.reasons.push('Data belum cukup untuk menghitung EMA200 (butuh minimal 200+ candle).');
    return {result, series:{ema50,ema200,rsiArr,atrArr}, indices:{last,cand,prior}};
  }

  // 1. TREND FILTER
  // Bandingkan 2 candle TERTUTUP TERAKHIR yang berurutan (last vs cand),
  // bukan melompati satu candle, supaya deteksi crossing akurat.
  const diffNow = ema50[last]-ema200[last];
  const diffPrev = ema50[cand]-ema200[cand];
  const crossing = (diffNow>0) !== (diffPrev>0);
  let trendDir = null;
  if(!crossing){
    trendDir = diffNow>0 ? 'BUY' : 'SELL';
    result.trendOK = true;
    result.trendLabel = trendDir==='BUY' ? 'Bullish (EMA50 > EMA200)' : 'Bearish (EMA50 < EMA200)';
  } else {
    result.trendLabel = 'EMA Crossing — No Entry Zone';
  }

  if(!trendDir){
    result.reasons.push('EMA50 dan EMA200 sedang berpotongan, tidak ada entry valid saat ini.');
    return {result, series:{ema50,ema200,rsiArr,atrArr}, indices:{last,cand,prior}};
  }
  result.direction = trendDir;

  // body / wick helpers
  const body = i => Math.abs(closes[i]-opens[i]);
  const upperWick = i => highs[i]-Math.max(closes[i],opens[i]);
  const lowerWick = i => Math.min(closes[i],opens[i])-lows[i];

  let swingType = null, swingIdx = null;

  if(trendDir==='SELL'){
    // candidate swing high
    const condHigh = highs[cand]>highs[prior];
    const condBody = body(cand) < body(prior);
    const condWick = upperWick(cand) > body(cand);
    const condRSI = rsiArr[cand]!=null && rsiArr[cand] > 68;
    const condATR = atrArr[cand]!=null && atrArr[prior]!=null && atrArr[cand] < atrArr[prior];
    result.rsiOK = condRSI; result.atrOK = condATR;
    if(condHigh && condBody && condWick && condRSI && condATR){
      swingType='HIGH'; swingIdx=cand;
    }
  } else {
    const condLow = lows[cand]<lows[prior];
    const condBody = body(cand) < body(prior);
    const condWick = lowerWick(cand) > body(cand);
    const condRSI = rsiArr[cand]!=null && rsiArr[cand] < 32;
    const condATR = atrArr[cand]!=null && atrArr[prior]!=null && atrArr[cand] < atrArr[prior];
    result.rsiOK = condRSI; result.atrOK = condATR;
    if(condLow && condBody && condWick && condRSI && condATR){
      swingType='LOW'; swingIdx=cand;
    }
  }

  if(!swingType){
    result.reasons.push(`Belum ada Candidate Swing ${trendDir==='SELL'?'High':'Low'} yang valid pada candle terakhir.`);
    return {result, series:{ema50,ema200,rsiArr,atrArr}, indices:{last,cand,prior}};
  }
  result.swingOK = true;

  // 2. VALIDASI (1 candle setelah kandidat = candle 'last')
  let confirmed = false;
  if(swingType==='HIGH'){
    confirmed = !(highs[last] > highs[cand]); // gagal buat high baru -> confirmed
  } else {
    confirmed = !(lows[last] < lows[cand]);
  }

  // 3. LIQUIDITY SWEEP (dicek di candle 'last') — wajib terjadi sebelum lanjut ke Zone Entry,
  // sesuai alur: Candidate Swing -> Liquidity Sweep -> Zone Entry.
  let sweep = false;
  if(swingType==='HIGH'){
    sweep = highs[last] > highs[cand] && closes[last] < highs[cand];
  } else {
    sweep = lows[last] < lows[cand] && closes[last] > lows[cand];
  }
  result.sweepOK = sweep;
  result.confirmed = confirmed;

  if(!sweep){
    if(!confirmed){
      result.reasons.push('Swing candidate dibatalkan: candle berikutnya membuat extreme baru tanpa liquidity sweep yang valid.');
    } else {
      result.reasons.push('Candidate Swing terkonfirmasi, tetapi belum terjadi liquidity sweep — menunggu stop hunt sebelum entry.');
    }
    return {result, series:{ema50,ema200,rsiArr,atrArr}, indices:{last,cand,prior}};
  }

  // 4. ZONE ENTRY via fibonacci retracement
  const lookback = 30;
  const startLB = Math.max(0, cand-lookback);
  let A, B, entryLow, entryHigh, slPrice;
  const atrForSL = atrArr[last] != null ? atrArr[last] : atrArr[cand];

  if(swingType==='HIGH'){
    B = highs[cand];
    A = Math.min(...lows.slice(startLB, cand));
    entryHigh = B - (B-A)*0.5;
    entryLow  = B - (B-A)*0.618;
    slPrice = Math.max(B, highs[last]) + atrForSL*0.5;
  } else {
    B = lows[cand];
    A = Math.max(...highs.slice(startLB, cand));
    entryLow  = B + (A-B)*0.5;
    entryHigh = B + (A-B)*0.618;
    slPrice = Math.min(B, lows[last]) - atrForSL*0.5;
  }
  const entryMid = (entryLow+entryHigh)/2;
  const risk = Math.abs(entryMid - slPrice);
  const tpPrice = trendDir==='SELL' ? entryMid - risk*2 : entryMid + risk*2;

  // 5. VOLUME (jika tersedia)
  let volIncrease = false;
  if(vols[last]!=null && vols[cand]!=null && !isNaN(vols[last]) && !isNaN(vols[cand])){
    volIncrease = vols[last] > vols[cand];
    result.volOK = volIncrease;
    result.volAvailable = true;
  } else {
    result.volAvailable = false;
  }

  // 6. CONFIDENCE SCORE
  let score = 0;
  if(result.trendOK) score += 25;
  if(result.rsiOK) score += 15;
  if(result.atrOK) score += 10;
  if(result.sweepOK) score += 20;
  if(result.swingOK) score += 20;
  if(result.volOK) score += 10;
  result.confidence = score;

  result.valid = true;
  result.swingType = swingType;
  result.swingIdx = swingIdx;
  result.swingPrice = B;
  result.fibAnchor = A;
  result.entryLow = Math.min(entryLow, entryHigh);
  result.entryHigh = Math.max(entryLow, entryHigh);
  result.entryMid = entryMid;
  result.sl = slPrice;
  result.tp = tpPrice;
  result.confirmed = confirmed;
  result.lastTime = candles[last].time;

  return {result, series:{ema50,ema200,rsiArr,atrArr}, indices:{last,cand,prior}};
}

// ---------- CHART ----------
function drawChart(candles, series, indices, result){
  const W = 1000, H = 320, pad = 36;
  const n = candles.length;
  const showFrom = Math.max(0, n-90);
  const closes = candles.map(c=>c.close).slice(showFrom);
  const ema50 = series.ema50.slice(showFrom);
  const ema200 = series.ema200.slice(showFrom);

  let allVals = closes.slice();
  if(result.valid){ allVals = allVals.concat([result.entryMid, result.sl, result.tp]); }
  ema50.forEach(v=>{ if(v!=null) allVals.push(v); });
  ema200.forEach(v=>{ if(v!=null) allVals.push(v); });

  const min = Math.min(...allVals), max = Math.max(...allVals);
  const range = (max-min) || 1;
  const x = i => pad + (i/(closes.length-1)) * (W-pad*2);
  const y = v => H-pad - ((v-min)/range) * (H-pad*2);

  const path = arr => arr.map((v,i)=> v==null ? null : `${x(i)},${y(v)}`).filter(Boolean).join(' L ');

  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto; display:block;">`;
  // grid
  for(let g=0; g<=4; g++){
    const gy = pad + g*(H-pad*2)/4;
    svg += `<line x1="${pad}" y1="${gy}" x2="${W-pad}" y2="${gy}" stroke="#1c232b" stroke-width="1"/>`;
  }
  svg += `<polyline points="${path(closes)}" fill="none" stroke="#f0b429" stroke-width="1.6"/>`;
  svg += `<polyline points="${path(ema50)}" fill="none" stroke="#3da9fc" stroke-width="1.3"/>`;
  svg += `<polyline points="${path(ema200)}" fill="none" stroke="#b06bf2" stroke-width="1.3"/>`;

  if(result.valid){
    const drawHLine = (val, color, label) => {
      const yy = y(val);
      svg += `<line x1="${pad}" y1="${yy}" x2="${W-pad}" y2="${yy}" stroke="${color}" stroke-width="1" stroke-dasharray="4,3"/>`;
      svg += `<text x="${W-pad+4}" y="${yy+3}" font-size="9" fill="${color}" font-family="JetBrains Mono">${label}</text>`;
    };
    drawHLine(result.entryMid, '#28d97c', 'ENTRY');
    drawHLine(result.sl, '#ff5470', 'SL');
    drawHLine(result.tp, '#28d97c', 'TP');
  }

  svg += `</svg>`;
  $('chartHolder').innerHTML = svg;
}

// ---------- RENDER ----------
function render(symbol, interval, candles, analysis){
  const {result} = analysis;
  $('result').classList.add('show');

  $('hSymbol').textContent = symbol.toUpperCase();
  $('hTf').textContent = interval;
  $('hTime').textContent = result.lastTime || candles[candles.length-1].time;

  const dirClass = result.valid ? (result.direction==='BUY'?'buy':'sell') : 'none';
  const headline = $('headline');
  headline.className = 'headline ' + dirClass;
  $('hDir').className = 'direction ' + dirClass;
  $('hDir').textContent = result.valid ? result.direction : 'NO ENTRY';
  $('hSub').textContent = result.valid
    ? (result.direction==='SELL' ? 'Liquidity sweep di atas swing high — entry pada zona retracement.' : 'Liquidity sweep di bawah swing low — entry pada zona retracement.')
    : (result.reasons[0] || 'Tidak ada setup valid saat ini.');

  const conf = result.confidence;
  $('confNum').textContent = result.valid ? conf+'%' : '—';
  let confColor = '#7e8b97';
  if(conf>=90) confColor='#28d97c'; else if(conf>=80) confColor='#3da9fc'; else if(conf>=70) confColor='#f0b429'; else confColor='#ff5470';
  $('confFill').style.background = confColor;
  $('confFill').style.width = result.valid ? conf+'%' : '0%';

  let statusText, statusColor, statusBg;
  if(!result.valid){ statusText='NO SETUP'; statusColor='#f0b429'; statusBg='#2a2410'; }
  else if(conf>=90){ statusText=`HIGH PROBABILITY ${result.direction}`; statusColor='#28d97c'; statusBg='var(--buy-dim)'; }
  else if(conf>=80){ statusText=`STRONG ${result.direction}`; statusColor='#3da9fc'; statusBg='#0f2a3a'; }
  else if(conf>=70){ statusText=`MODERATE ${result.direction}`; statusColor='#f0b429'; statusBg='#2a2410'; }
  else { statusText='LOW PROBABILITY — ABAIKAN'; statusColor='#ff5470'; statusBg='var(--sell-dim)'; }
  const tag = $('hStatus');
  tag.textContent = statusText; tag.style.color = statusColor; tag.style.background = statusBg;

  $('cTrend').textContent = result.trendOK ? result.direction : 'NONE';
  $('cTrend').className = 'v ' + (result.trendOK ? (result.direction==='BUY'?'buy':'sell') : 'amber');
  $('cTrendSub').textContent = result.trendLabel;

  $('cStruct').textContent = result.valid ? (result.direction==='BUY'?'Bullish':'Bearish') : '—';
  $('cStruct').className = 'v ' + (result.valid ? (result.direction==='BUY'?'buy':'sell') : 'amber');
  $('cStructSub').textContent = result.swingOK ? `Candidate Swing ${result.swingType||''} terdeteksi` : 'Belum ada struktur swing valid';

  const lastRSI = analysis.series.rsiArr[analysis.indices.cand];
  const lastATR = analysis.series.atrArr[analysis.indices.cand];
  $('cMom').textContent = `${fmt(lastRSI,1)} / ${fmt(lastATR,3)}`;
  $('cMom').className = 'v ' + (result.rsiOK && result.atrOK ? (result.direction==='BUY'?'buy':'sell') : 'amber');
  $('cMomSub').textContent = result.rsiOK && result.atrOK ? 'RSI & ATR mendukung setup' : 'RSI/ATR belum memenuhi syarat';

  $('lZone').textContent = result.valid ? `${fmt(result.entryLow)}–${fmt(result.entryHigh)}` : '—';
  $('lSL').textContent = result.valid ? fmt(result.sl) : '—';
  $('lTP').textContent = result.valid ? fmt(result.tp) : '—';
  $('lRR').textContent = '1 : 2';

  // checklist
  const items = [
    ['Trend sesuai (EMA50 vs EMA200)', result.trendOK, 25],
    ['RSI sesuai', result.rsiOK, 15],
    ['ATR menurun', result.atrOK, 10],
    ['Liquidity Sweep terkonfirmasi', result.sweepOK, 20],
    ['Candidate Swing valid', result.swingOK, 20],
    ['Volume meningkat' + (result.volAvailable? '' : ' (data tidak tersedia)'), result.volOK, 10],
  ];
  $('checklistItems').innerHTML = items.map(([label, ok, pts])=>`
    <div class="chk-item">
      <div class="chk-badge ${ok?'yes':'no'}">${ok?'✓':'✕'}</div>
      <div>${label}</div>
      <div class="chk-score">${ok?'+':''}${ok?pts:0} pts</div>
    </div>
  `).join('');

  // raw output block
  const raw = `======== AI ANALYSIS ========
<span class="t">Symbol</span>      <span class="b">${symbol.toUpperCase()}</span>
<span class="t">Timeframe</span>   <span class="b">${interval}</span>
<span class="t">Trend</span>       <span class="${result.direction==='BUY'?'buyc':result.direction==='SELL'?'sellc':'b'}">${result.trendOK?result.direction:'NONE'}</span>
<span class="t">Market Structure</span>  <span class="b">${result.valid ? (result.direction==='BUY'?'Bullish':'Bearish') : '—'}</span>
<span class="t">Candidate Swing</span>   <span class="b">${result.swingOK?'YES':'NO'}</span>
<span class="t">Liquidity Sweep</span>  <span class="b">${result.sweepOK?'YES':'NO'}</span>
<span class="t">Zone Entry</span>  <span class="b">${result.valid?fmt(result.entryLow)+'–'+fmt(result.entryHigh):'—'}</span>
<span class="t">Stop Loss</span>  <span class="b">${result.valid?fmt(result.sl):'—'}</span>
<span class="t">Take Profit</span>  <span class="b">${result.valid?fmt(result.tp):'—'}</span>
<span class="t">Risk Reward</span>  <span class="b">1 : 2</span>
<span class="t">Confidence</span>  <span class="b">${result.valid?conf+'%':'—'}</span>
<span class="t">Status</span>      <span class="${dirClass==='buy'?'buyc':dirClass==='sell'?'sellc':'b'}">${statusText}</span>`;
  $('rawOutput').innerHTML = raw;

  drawChart(candles, analysis.series, analysis.indices, result);
}

// ---------- MAIN ----------
async function main(){
  const apikey = $('apiKey').value.trim();
  const symbol = $('symbol').value.trim();
  const interval = $('interval').value;
  const errBox = $('errBox'), loadBox = $('loadBox'), btn = $('runBtn');

  errBox.classList.remove('show');
  $('result').classList.remove('show');

  if(!apikey){ errBox.textContent='Masukkan Twelvedata API key terlebih dahulu.'; errBox.classList.add('show'); return; }
  if(!symbol){ errBox.textContent='Masukkan symbol, contoh: XAU/USD, EUR/USD, BTC/USD.'; errBox.classList.add('show'); return; }

  btn.disabled = true; loadBox.classList.add('show');
  $('liveDot').classList.remove('live'); $('liveText').textContent='fetching…';

  try{
    const candles = await fetchOHLC(symbol, interval, apikey);
    if(candles.length < 210){
      throw new Error(`Data terlalu sedikit (${candles.length} candle). Butuh minimal ~210 candle untuk EMA200. Coba timeframe lebih kecil atau symbol lain.`);
    }
    const analysis = runAnalysis(candles);
    render(symbol, interval, candles, analysis);
    $('liveDot').classList.add('live'); $('liveText').textContent='analysis complete';
  } catch(err){
    errBox.textContent = '⚠ ' + (err.message || 'Terjadi kesalahan saat mengambil/menganalisis data.');
    errBox.classList.add('show');
    $('liveDot').classList.remove('live'); $('liveText').textContent='error';
  } finally{
    btn.disabled = false; loadBox.classList.remove('show');
  }
}

$('runBtn').addEventListener('click', main);
$('apiKey').addEventListener('keydown', e=>{ if(e.key==='Enter') main(); });
$('symbol').addEventListener('keydown', e=>{ if(e.key==='Enter') main(); });
