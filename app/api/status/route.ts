/**
 * GET /api/status — returns current bot state.
 */
import { NextResponse } from 'next/server'
import { loadState } from '@/lib/state'
import { isTradingHalted } from '@/lib/risk-manager'
import { config } from '@/lib/config'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const state = await loadState()
    const [halted, haltReason] = isTradingHalted(state)
    const drawdownPct = state.peakCapital > 0
      ? (state.peakCapital - state.capital) / state.peakCapital * 100
      : 0

    return NextResponse.json({
      capital:      Math.round(state.capital * 10000) / 10000,
      peakCapital:  Math.round(state.peakCapital * 10000) / 10000,
      dailyPnl:     Math.round(state.dailyPnl * 10000) / 10000,
      drawdownPct:  Math.round(drawdownPct * 100) / 100,
      positions:    state.positions,
      tradeHistory: state.tradeHistory.slice(-20),
      halted,
      haltReason,
      config: {
        symbols:         config.symbols,
        profitTargetPct: config.profitTargetPct,
        stopLossPct:     config.stopLossPct,
        dryRun:          config.dryRun,
        exchange:        config.exchange,
      },
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
