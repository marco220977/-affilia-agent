/**
 * RiskManager — enforces all risk rules on a mutable BotState.
 *
 * Rules:
 *   1. Max position size (% of capital)
 *   2. Hard stop-loss (-SL%)
 *   3. Trailing stop (activates at +TRAIL_ACTIVATE%, trails TRAIL_PCT%)
 *   4. Take-profit (+TARGET%)
 *   5. Max concurrent positions
 *   6. Daily loss circuit-breaker
 *   7. Max drawdown circuit-breaker
 */
import { config } from './config'
import { BotState, Position, TradeRecord } from './state'

export interface RiskDecision {
  allowed: boolean
  reason: string
  quantity: number
  stopLoss: number
  takeProfit: number
}

export interface ExitDecision {
  exit: boolean
  reason: string
}

// ── Circuit breakers ──────────────────────────────────────────────────────────

function resetDailyIfNeeded(state: BotState): void {
  const today = new Date().toISOString().slice(0, 10)
  if (state.dailyResetDate !== today) {
    state.dailyPnl = 0
    state.dailyResetDate = today
  }
}

export function isTradingHalted(state: BotState): [boolean, string] {
  resetDailyIfNeeded(state)
  const dailyLossPct = state.dailyPnl < 0
    ? (-state.dailyPnl / state.capital) * 100
    : 0
  if (dailyLossPct >= config.maxDailyLossPct)
    return [true, `Daily loss limit reached (${dailyLossPct.toFixed(2)}% >= ${config.maxDailyLossPct}%)`]

  const drawdown = state.peakCapital > 0
    ? ((state.peakCapital - state.capital) / state.peakCapital) * 100
    : 0
  if (drawdown >= config.maxDrawdownPct)
    return [true, `Max drawdown reached (${drawdown.toFixed(2)}% >= ${config.maxDrawdownPct}%)`]

  return [false, '']
}

// ── Entry ─────────────────────────────────────────────────────────────────────

export function evaluateEntry(
  state: BotState,
  symbol: string,
  price: number,
  side: 'long' | 'short' = 'long',
): RiskDecision {
  const denied = (reason: string): RiskDecision => ({ allowed: false, reason, quantity: 0, stopLoss: 0, takeProfit: 0 })

  const [halted, haltReason] = isTradingHalted(state)
  if (halted) return denied(haltReason)

  if (Object.keys(state.positions).length >= config.maxConcurrentPos)
    return denied(`Max concurrent positions (${config.maxConcurrentPos}) reached`)

  if (state.positions[symbol])
    return denied(`Already holding position in ${symbol}`)

  const capitalAtRisk = state.capital * (config.maxPositionSizePct / 100)
  const quantity      = capitalAtRisk / price

  const stopLoss   = side === 'long'
    ? price * (1 - config.stopLossPct / 100)
    : price * (1 + config.stopLossPct / 100)
  const takeProfit = side === 'long'
    ? price * (1 + config.profitTargetPct / 100)
    : price * (1 - config.profitTargetPct / 100)

  return { allowed: true, reason: 'OK', quantity, stopLoss, takeProfit }
}

// ── Exit ──────────────────────────────────────────────────────────────────────

export function evaluateExit(state: BotState, symbol: string, price: number): ExitDecision {
  const pos = state.positions[symbol]
  if (!pos) return { exit: false, reason: 'no position' }

  if (pos.side === 'long') {
    const pnlPct = (price - pos.entryPrice) / pos.entryPrice * 100

    if (price >= pos.takeProfit)
      return { exit: true, reason: `TAKE_PROFIT +${pnlPct.toFixed(2)}%` }

    // Update trailing stop
    if (pnlPct >= config.trailingStopActivatePct) {
      const newTrail = price * (1 - config.trailingStopTrailPct / 100)
      if (!pos.trailingActive || newTrail > pos.trailingStop) {
        pos.trailingActive = true
        pos.trailingStop   = newTrail
      }
    }
    if (pos.trailingActive && price <= pos.trailingStop)
      return { exit: true, reason: `TRAILING_STOP pnl=${pnlPct.toFixed(2)}%` }

    if (price <= pos.stopLoss)
      return { exit: true, reason: `STOP_LOSS ${pnlPct.toFixed(2)}%` }

  } else {
    const pnlPct = (pos.entryPrice - price) / pos.entryPrice * 100
    if (price <= pos.takeProfit)
      return { exit: true, reason: `TAKE_PROFIT +${pnlPct.toFixed(2)}%` }
    if (price >= pos.stopLoss)
      return { exit: true, reason: `STOP_LOSS ${pnlPct.toFixed(2)}%` }
  }

  return { exit: false, reason: '' }
}

// ── P&L accounting ────────────────────────────────────────────────────────────

export function closePosition(state: BotState, symbol: string, exitPrice: number, reason: string): number {
  const pos = state.positions[symbol]
  if (!pos) return 0

  const pnl = pos.side === 'long'
    ? (exitPrice - pos.entryPrice) * pos.quantity
    : (pos.entryPrice - exitPrice) * pos.quantity

  state.capital  += pnl
  state.dailyPnl += pnl
  if (state.capital > state.peakCapital) state.peakCapital = state.capital

  const record: TradeRecord = {
    symbol,
    side: pos.side,
    entryPrice: pos.entryPrice,
    exitPrice,
    pnl: Math.round(pnl * 10000) / 10000,
    pnlPct: Math.round((pnl / pos.capitalAtRisk) * 10000) / 100,
    reason,
    closedAt: new Date().toISOString(),
  }
  state.tradeHistory.push(record)
  delete state.positions[symbol]
  return pnl
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerPosition(
  state: BotState,
  symbol: string,
  side: 'long' | 'short',
  entryPrice: number,
  quantity: number,
  stopLoss: number,
  takeProfit: number,
): Position {
  const pos: Position = {
    symbol, side, entryPrice, quantity,
    capitalAtRisk: entryPrice * quantity,
    stopLoss, takeProfit,
    trailingActive: false, trailingStop: 0,
    openedAt: new Date().toISOString(),
  }
  state.positions[symbol] = pos
  return pos
}
