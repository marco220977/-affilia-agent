/**
 * POST /api/tick — called by Vercel cron every minute.
 * Protected by CRON_SECRET header when running in production.
 */
import { NextRequest, NextResponse } from 'next/server'
import { runTick } from '@/lib/trading-boss'
import { config } from '@/lib/config'

export const maxDuration = 300   // 5-minute timeout for Vercel Pro / serverless

export async function POST(req: NextRequest) {
  // Verify cron secret in production
  if (config.cronSecret) {
    const authHeader = req.headers.get('authorization')
    if (authHeader !== `Bearer ${config.cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const report = await runTick()
    return NextResponse.json({
      timestamp: report.timestamp,
      halted:    report.halted,
      haltReason: report.haltReason,
      entries:   report.entries,
      exits:     report.exits,
      analyses:  report.analyses.map(a => ({
        symbol:     a.symbol,
        action:     a.action,
        confidence: Math.round(a.confidence * 10) / 10,
        signal:     Math.round(a.signal * 1000) / 1000,
      })),
      capital: report.state.capital,
    })
  } catch (err) {
    console.error('[TICK ERROR]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
