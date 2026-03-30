/**
 * MarketAnalyzer — fetches OHLCV and runs multi-indicator analysis.
 *
 * Indicators & weights:
 *   RSI(14)           0.25  — momentum
 *   MACD(12/26/9)     0.25  — trend + crossover
 *   Bollinger(20,2σ)  0.20  — mean-reversion
 *   EMA(9/21/50)      0.20  — trend alignment
 *   Volume ratio      0.10  — move confirmation
 *
 * ADX acts as a confidence multiplier (trending market → stronger signal).
 */
import ccxt from 'ccxt'
import { config } from './config'
import { rsi, macd, bollingerBands, ema, adx } from './indicators'

export interface AnalysisResult {
  symbol: string
  signal: number        // -1 .. +1
  confidence: number    // 0 .. 100
  action: 'BUY' | 'SELL' | 'HOLD'
  details: {
    rsi: number
    macdCross: 'bull' | 'bear' | 'none'
    bbPct: number
    emaTrend: 'bull' | 'bear' | 'neutral'
    adx: number
    volumeRatio: number
  }
}

const WEIGHTS = { rsi: 0.25, macd: 0.25, bb: 0.20, ema: 0.20, volume: 0.10 }

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

// ── Signal functions ──────────────────────────────────────────────────────────

function rsiSignal(r: number): number {
  if (r < 30) return 1.0
  if (r < 40) return 0.6
  if (r < 45) return 0.3
  if (r > 70) return -1.0
  if (r > 60) return -0.6
  if (r > 55) return -0.3
  return 0
}

function macdSignal(histNow: number, histPrev: number): [number, 'bull' | 'bear' | 'none'] {
  if (histPrev <= 0 && histNow > 0) return [1.0, 'bull']
  if (histPrev >= 0 && histNow < 0) return [-1.0, 'bear']
  const slope = histNow - histPrev
  const score = clamp(slope / (Math.abs(histNow) + 1e-9), -1, 1) * 0.5
  return [score, histNow > 0 ? 'bull' : 'bear']
}

function bbSignal(pct: number): number {
  if (pct < 0.1) return 1.0
  if (pct < 0.3) return 0.5
  if (pct > 0.9) return -1.0
  if (pct > 0.7) return -0.5
  return (0.5 - pct) * 0.4
}

function emaSignal(close: number[], e9: number[], e21: number[], e50: number[]): [number, 'bull' | 'bear' | 'neutral'] {
  const price  = close[close.length - 1]
  const v9     = e9[e9.length - 1]
  const v21    = e21[e21.length - 1]
  const v50    = e50[e50.length - 1]
  const bulls  = [v9 > v21, v21 > v50, price > v9].filter(Boolean).length
  const bears  = [v9 < v21, v21 < v50, price < v9].filter(Boolean).length
  if (bulls === 3) return [1.0, 'bull']
  if (bulls === 2) return [0.5, 'bull']
  if (bears === 3) return [-1.0, 'bear']
  if (bears === 2) return [-0.5, 'bear']
  return [0, 'neutral']
}

function volumeSignal(volumes: number[], window = 20): number {
  const recent  = volumes.slice(-window)
  const avg     = recent.reduce((a, b) => a + b, 0) / recent.length
  const cur     = volumes[volumes.length - 1]
  if (!avg) return 0
  return clamp((cur / avg - 1) * 0.5, -0.5, 1.0)
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function analyzeSymbol(
  exchange: ccxt.Exchange,
  symbol: string,
  minConf = config.minConfidence,
): Promise<AnalysisResult> {
  let ohlcv: number[][]
  try {
    ohlcv = await exchange.fetchOHLCV(symbol, config.timeframe, undefined, 200) as number[][]
  } catch (e) {
    console.error(`OHLCV fetch error [${symbol}]:`, e)
    return { symbol, signal: 0, confidence: 0, action: 'HOLD', details: { rsi: 50, macdCross: 'none', bbPct: 0.5, emaTrend: 'neutral', adx: 20, volumeRatio: 1 } }
  }

  if (ohlcv.length < 60) {
    return { symbol, signal: 0, confidence: 0, action: 'HOLD', details: { rsi: 50, macdCross: 'none', bbPct: 0.5, emaTrend: 'neutral', adx: 20, volumeRatio: 1 } }
  }

  const close   = ohlcv.map(c => c[4])
  const high    = ohlcv.map(c => c[2])
  const low     = ohlcv.map(c => c[3])
  const volumes = ohlcv.map(c => c[5])

  // Compute indicators
  const rsiVal   = rsi(close)
  const macdRes  = macd(close)
  const bb       = bollingerBands(close)
  const e9       = ema(close, 9)
  const e21      = ema(close, 21)
  const e50      = ema(close, 50)
  const adxVal   = adx(high, low, close)
  const volRatio = volumeRatio(volumes)

  // Signals
  const rsiS           = rsiSignal(rsiVal)
  const [macdS, cross] = macdSignal(macdRes.hist, macdRes.prevHist)
  const bbS            = bbSignal(bb.pct)
  const [emaS, trend]  = emaSignal(close, e9, e21, e50)
  const volS           = volumeSignal(volumes)

  // ADX multiplier: trending market amplifies signal
  const adxMult = Math.min(adxVal / 25, 1.5)

  const rawSignal = clamp(
    (WEIGHTS.rsi * rsiS + WEIGHTS.macd * macdS + WEIGHTS.bb * bbS + WEIGHTS.ema * emaS + WEIGHTS.volume * volS) * adxMult,
    -1, 1,
  )
  const confidence = Math.abs(rawSignal) * 100

  let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD'
  if (rawSignal >= 0 && confidence >= minConf) action = 'BUY'
  else if (rawSignal < 0 && confidence >= minConf) action = 'SELL'

  return {
    symbol,
    signal: rawSignal,
    confidence,
    action,
    details: {
      rsi: rsiVal,
      macdCross: cross,
      bbPct: bb.pct,
      emaTrend: trend,
      adx: adxVal,
      volumeRatio: volRatio,
    },
  }
}

function volumeRatio(volumes: number[], window = 20): number {
  const recent = volumes.slice(-window)
  const avg    = recent.reduce((a, b) => a + b, 0) / recent.length
  return avg ? volumes[volumes.length - 1] / avg : 1
}

/** Analyze all configured symbols */
export async function analyzeAll(exchange: ccxt.Exchange): Promise<AnalysisResult[]> {
  return Promise.all(config.symbols.map(s => analyzeSymbol(exchange, s)))
}
