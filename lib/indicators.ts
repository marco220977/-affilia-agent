/**
 * Pure technical indicator functions — work on number arrays (close prices).
 */

/** Exponential moving average */
export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = []
  for (let i = 0; i < values.length; i++) {
    if (i === 0) { out.push(values[0]); continue }
    out.push(values[i] * k + out[i - 1] * (1 - k))
  }
  return out
}

/** Simple moving average */
function sma(values: number[], period: number): number[] {
  return values.map((_, i) => {
    if (i < period - 1) return NaN
    const slice = values.slice(i - period + 1, i + 1)
    return slice.reduce((a, b) => a + b, 0) / period
  })
}

/** RSI (14) — returns latest value */
export function rsi(close: number[], period = 14): number {
  const deltas = close.map((v, i) => i === 0 ? 0 : v - close[i - 1])
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    if (deltas[i] > 0) avgGain += deltas[i]
    else avgLoss += Math.abs(deltas[i])
  }
  avgGain /= period
  avgLoss /= period
  for (let i = period + 1; i < close.length; i++) {
    const g = deltas[i] > 0 ? deltas[i] : 0
    const l = deltas[i] < 0 ? Math.abs(deltas[i]) : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
  }
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

export interface MACDResult { macd: number; signal: number; hist: number; prevHist: number }

/** MACD (12/26/9) */
export function macd(close: number[]): MACDResult {
  const fast   = ema(close, 12)
  const slow   = ema(close, 26)
  const line   = fast.map((v, i) => v - slow[i])
  const sig    = ema(line, 9)
  const hist   = line.map((v, i) => v - sig[i])
  const n      = hist.length
  return { macd: line[n - 1], signal: sig[n - 1], hist: hist[n - 1], prevHist: hist[n - 2] }
}

export interface BBResult { upper: number; middle: number; lower: number; pct: number }

/** Bollinger Bands (20, 2σ) */
export function bollingerBands(close: number[], period = 20, stdMult = 2): BBResult {
  const ma  = sma(close, period)
  const n   = close.length
  const mid = ma[n - 1]
  const slice = close.slice(n - period)
  const mean  = slice.reduce((a, b) => a + b, 0) / period
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period
  const sd    = Math.sqrt(variance)
  const upper = mid + stdMult * sd
  const lower = mid - stdMult * sd
  const width = upper - lower
  const pct   = width > 0 ? (close[n - 1] - lower) / width : 0.5
  return { upper, middle: mid, lower, pct }
}

export interface ADXResult { adx: number }

/** ADX (14) — trend strength */
export function adx(high: number[], low: number[], close: number[], period = 14): number {
  const n = close.length
  const tr: number[] = []
  const dmPlus: number[] = []
  const dmMinus: number[] = []

  for (let i = 1; i < n; i++) {
    const h = high[i], l = low[i], pc = close[i - 1]
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))
    const up   = h - high[i - 1]
    const down = low[i - 1] - l
    dmPlus.push(up > down && up > 0 ? up : 0)
    dmMinus.push(down > up && down > 0 ? down : 0)
  }

  function wilderSmooth(arr: number[], p: number): number[] {
    const out: number[] = []
    let init = arr.slice(0, p).reduce((a, b) => a + b, 0)
    out.push(init)
    for (let i = p; i < arr.length; i++) out.push(out[out.length - 1] - out[out.length - 1] / p + arr[i])
    return out
  }

  const aTR = wilderSmooth(tr, period)
  const DP  = wilderSmooth(dmPlus, period)
  const DM  = wilderSmooth(dmMinus, period)
  const dx  = aTR.map((t, i) => {
    const dp = 100 * DP[i] / (t || 1)
    const dm = 100 * DM[i] / (t || 1)
    const s  = dp + dm
    return s ? 100 * Math.abs(dp - dm) / s : 0
  })
  const adxArr = wilderSmooth(dx, period)
  return adxArr[adxArr.length - 1] ?? 20
}
