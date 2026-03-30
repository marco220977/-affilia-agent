/**
 * TradingBoss — serverless-friendly orchestrator.
 *
 * Each call to `runTick()` performs:
 *   1. Load state (Vercel KV / memory)
 *   2. Circuit-breaker check
 *   3. Manage exits on open positions
 *   4. Scan for new entries (analyze → risk-check → execute)
 *   5. Save state
 *   6. Return tick report
 */
import ccxt from 'ccxt'
import { config } from './config'
import { analyzeAll, AnalysisResult } from './market-analyzer'
import { loadState, saveState, BotState } from './state'
import {
  isTradingHalted,
  evaluateEntry,
  evaluateExit,
  closePosition,
  registerPosition,
} from './risk-manager'

export interface TickReport {
  timestamp: string
  halted: boolean
  haltReason: string
  analyses: AnalysisResult[]
  entries: EntryEvent[]
  exits: ExitEvent[]
  state: BotState
}

interface EntryEvent {
  symbol: string
  side: string
  price: number
  quantity: number
  stopLoss: number
  takeProfit: number
  confidence: number
  simulated: boolean
}

interface ExitEvent {
  symbol: string
  exitPrice: number
  reason: string
  pnl: number
}

// ── Exchange factory ──────────────────────────────────────────────────────────

export function buildExchange(): ccxt.Exchange {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExClass = (ccxt as any)[config.exchange] as new (o: object) => ccxt.Exchange
  return new ExClass({
    apiKey: config.apiKey,
    secret: config.apiSecret,
    enableRateLimit: true,
    options: { defaultType: 'spot' },
  })
}

async function getPrice(exchange: ccxt.Exchange, symbol: string): Promise<number | null> {
  try {
    const t = await exchange.fetchTicker(symbol)
    return typeof t.last === 'number' ? t.last : null
  } catch { return null }
}

async function placeOrder(
  exchange: ccxt.Exchange,
  side: 'buy' | 'sell',
  symbol: string,
  quantity: number,
  price: number,
  dryRun: boolean,
): Promise<{ price: number; orderId: string }> {
  if (dryRun) {
    return { price, orderId: `SIM-${Date.now()}` }
  }
  try {
    const order = await exchange.createMarketOrder(symbol, side, quantity)
    return {
      price:   parseFloat(String(order.average ?? order.price ?? price)),
      orderId: String(order.id),
    }
  } catch (e) {
    console.error(`Order failed [${side} ${symbol}]:`, e)
    return { price, orderId: 'ERR' }
  }
}

// ── Main tick ─────────────────────────────────────────────────────────────────

export async function runTick(): Promise<TickReport> {
  const exchange = buildExchange()
  const state    = await loadState()
  const report: TickReport = {
    timestamp: new Date().toISOString(),
    halted: false,
    haltReason: '',
    analyses: [],
    entries: [],
    exits: [],
    state,
  }

  // ── Circuit breakers ────────────────────────────────────────────────────────
  const [halted, haltReason] = isTradingHalted(state)
  report.halted     = halted
  report.haltReason = haltReason

  // ── Manage exits (even when halted) ────────────────────────────────────────
  for (const symbol of Object.keys(state.positions)) {
    const price = await getPrice(exchange, symbol)
    if (price == null) continue

    const { exit, reason } = evaluateExit(state, symbol, price)
    if (exit) {
      const pos = state.positions[symbol]
      const side: 'buy' | 'sell' = pos.side === 'long' ? 'sell' : 'buy'
      await placeOrder(exchange, side, symbol, pos.quantity, price, config.dryRun)
      const pnl = closePosition(state, symbol, price, reason)
      report.exits.push({ symbol, exitPrice: price, reason, pnl })
      console.log(`[EXIT] ${symbol} ${reason} pnl=${pnl.toFixed(4)}`)
    }
  }

  if (halted) {
    await saveState(state)
    report.state = state
    return report
  }

  // ── Analyze all symbols ─────────────────────────────────────────────────────
  const analyses = await analyzeAll(exchange)
  report.analyses = analyses

  // ── Scan entries ────────────────────────────────────────────────────────────
  for (const analysis of analyses) {
    if (analysis.action === 'HOLD') continue
    if (state.positions[analysis.symbol]) continue

    const price = await getPrice(exchange, analysis.symbol)
    if (price == null) continue

    const side: 'long' | 'short' = analysis.action === 'BUY' ? 'long' : 'short'
    const decision = evaluateEntry(state, analysis.symbol, price, side)

    if (!decision.allowed) {
      console.log(`[RISK DENIED] ${analysis.symbol}: ${decision.reason}`)
      continue
    }

    console.log(
      `[ENTRY] ${analysis.symbol} ${side.toUpperCase()} @ ${price} ` +
      `SL=${decision.stopLoss.toFixed(4)} TP=${decision.takeProfit.toFixed(4)} ` +
      `conf=${analysis.confidence.toFixed(1)}%`
    )

    const orderSide: 'buy' | 'sell' = side === 'long' ? 'buy' : 'sell'
    const order = await placeOrder(exchange, orderSide, analysis.symbol, decision.quantity, price, config.dryRun)

    if (order.orderId !== 'ERR') {
      registerPosition(state, analysis.symbol, side, order.price, decision.quantity, decision.stopLoss, decision.takeProfit)
      report.entries.push({
        symbol: analysis.symbol,
        side,
        price: order.price,
        quantity: decision.quantity,
        stopLoss: decision.stopLoss,
        takeProfit: decision.takeProfit,
        confidence: analysis.confidence,
        simulated: config.dryRun,
      })
    }
  }

  await saveState(state)
  report.state = state
  return report
}
