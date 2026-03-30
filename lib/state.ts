/**
 * Persistent state via Vercel KV.
 * Falls back to a module-level in-memory store when KV is not configured
 * (useful for local development / DRY_RUN).
 */
import { config } from './config'

export interface Position {
  symbol: string
  side: 'long' | 'short'
  entryPrice: number
  quantity: number
  capitalAtRisk: number
  stopLoss: number
  takeProfit: number
  trailingActive: boolean
  trailingStop: number
  openedAt: string   // ISO date
}

export interface BotState {
  capital: number
  peakCapital: number
  dailyPnl: number
  dailyResetDate: string   // YYYY-MM-DD
  positions: Record<string, Position>
  tradeHistory: TradeRecord[]
}

export interface TradeRecord {
  symbol: string
  side: 'long' | 'short'
  entryPrice: number
  exitPrice: number
  pnl: number
  pnlPct: number
  reason: string
  closedAt: string
}

// ── In-memory fallback ────────────────────────────────────────────────────────
const _memory: BotState = {
  capital: config.totalCapital,
  peakCapital: config.totalCapital,
  dailyPnl: 0,
  dailyResetDate: new Date().toISOString().slice(0, 10),
  positions: {},
  tradeHistory: [],
}

async function kvAvailable(): Promise<boolean> {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

async function getKV() {
  if (!(await kvAvailable())) return null
  try {
    const { kv } = await import('@vercel/kv')
    return kv
  } catch { return null }
}

export async function loadState(): Promise<BotState> {
  const kv = await getKV()
  if (!kv) return { ..._memory, positions: { ..._memory.positions } }
  const stored = await kv.get<BotState>('bot:state')
  if (!stored) return _memory
  return stored
}

export async function saveState(state: BotState): Promise<void> {
  // Keep only last 50 trades in history
  if (state.tradeHistory.length > 50) {
    state.tradeHistory = state.tradeHistory.slice(-50)
  }
  Object.assign(_memory, state)
  const kv = await getKV()
  if (kv) await kv.set('bot:state', state)
}

export function freshState(): BotState {
  return {
    capital: config.totalCapital,
    peakCapital: config.totalCapital,
    dailyPnl: 0,
    dailyResetDate: new Date().toISOString().slice(0, 10),
    positions: {},
    tradeHistory: [],
  }
}
