/**
 * GET /api/analyze — runs live market analysis without placing orders.
 */
import { NextResponse } from 'next/server'
import { buildExchange } from '@/lib/trading-boss'
import { analyzeAll } from '@/lib/market-analyzer'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET() {
  try {
    const exchange = buildExchange()
    const analyses = await analyzeAll(exchange)
    return NextResponse.json(analyses)
  } catch (err) {
    console.error('[ANALYZE ERROR]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
