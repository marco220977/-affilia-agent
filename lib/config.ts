/**
 * Configuration — reads from environment variables (Vercel dashboard or .env.local)
 */

function float(key: string, fallback: number): number {
  const v = process.env[key]
  return v ? parseFloat(v) : fallback
}
function int(key: string, fallback: number): number {
  const v = process.env[key]
  return v ? parseInt(v, 10) : fallback
}
function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key]
  if (!v) return fallback
  return ['1', 'true', 'yes'].includes(v.toLowerCase())
}
function list(key: string, fallback: string): string[] {
  return (process.env[key] || fallback).split(',').map(s => s.trim()).filter(Boolean)
}

export const config = {
  // Exchange
  exchange:   process.env.EXCHANGE   ?? 'binance',
  apiKey:     process.env.API_KEY    ?? '',
  apiSecret:  process.env.API_SECRET ?? '',
  dryRun:     bool('DRY_RUN', true),

  // Universe
  symbols:    list('SYMBOLS', 'BTC/USDT,ETH/USDT,BNB/USDT'),
  timeframe:  process.env.TIMEFRAME ?? '5m',

  // Capital management
  totalCapital:          float('TOTAL_CAPITAL', 1000),
  maxPositionSizePct:    float('MAX_POSITION_SIZE_PCT', 2),
  maxDailyLossPct:       float('MAX_DAILY_LOSS_PCT', 3),
  maxConcurrentPos:      int('MAX_CONCURRENT_POSITIONS', 3),
  maxDrawdownPct:        float('MAX_DRAWDOWN_PCT', 10),

  // Trade targets
  profitTargetPct:           float('PROFIT_TARGET_PCT', 1),
  stopLossPct:               float('STOP_LOSS_PCT', 0.5),
  trailingStopActivatePct:   float('TRAILING_STOP_ACTIVATE_PCT', 0.7),
  trailingStopTrailPct:      float('TRAILING_STOP_TRAIL_PCT', 0.3),

  // Analysis
  minConfidence:     float('MIN_CONFIDENCE', 65),
  loopIntervalSecs:  int('LOOP_INTERVAL_SECONDS', 60),

  // Vercel cron secret
  cronSecret: process.env.CRON_SECRET ?? '',
} as const
