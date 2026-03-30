'use client'

import { useEffect, useState, useCallback } from 'react'

interface Position {
  symbol: string
  side: string
  entryPrice: number
  stopLoss: number
  takeProfit: number
  openedAt: string
}

interface TradeRecord {
  symbol: string
  side: string
  pnl: number
  pnlPct: number
  reason: string
  closedAt: string
}

interface StatusData {
  capital: number
  peakCapital: number
  dailyPnl: number
  drawdownPct: number
  positions: Record<string, Position>
  tradeHistory: TradeRecord[]
  halted: boolean
  haltReason: string
  config: {
    symbols: string[]
    profitTargetPct: number
    stopLossPct: number
    dryRun: boolean
    exchange: string
  }
}

interface AnalysisItem {
  symbol: string
  action: string
  confidence: number
  signal: number
  details: { rsi: number; macdCross: string; emaTrend: string; adx: number; bbPct: number }
}

function Badge({ text, color }: { text: string; color: 'green' | 'red' | 'yellow' | 'gray' }) {
  const classes = {
    green:  'bg-green-900/50 text-green-400 border border-green-700',
    red:    'bg-red-900/50 text-red-400 border border-red-700',
    yellow: 'bg-yellow-900/50 text-yellow-400 border border-yellow-700',
    gray:   'bg-gray-800 text-gray-400 border border-gray-600',
  }
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${classes[color]}`}>{text}</span>
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 uppercase tracking-widest mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

export default function Dashboard() {
  const [status, setStatus]     = useState<StatusData | null>(null)
  const [analyses, setAnalyses] = useState<AnalysisItem[]>([])
  const [loading, setLoading]   = useState(false)
  const [tickMsg, setTickMsg]   = useState('')
  const [lastUpdate, setLastUpdate] = useState('')

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/status')
      if (r.ok) setStatus(await r.json())
      setLastUpdate(new Date().toLocaleTimeString())
    } catch (e) { console.error(e) }
  }, [])

  const fetchAnalyze = useCallback(async () => {
    try {
      const r = await fetch('/api/analyze')
      if (r.ok) setAnalyses(await r.json())
    } catch (e) { console.error(e) }
  }, [])

  useEffect(() => {
    fetchStatus()
    fetchAnalyze()
    const id = setInterval(() => { fetchStatus(); fetchAnalyze() }, 30_000)
    return () => clearInterval(id)
  }, [fetchStatus, fetchAnalyze])

  const runTick = async () => {
    setLoading(true)
    setTickMsg('')
    try {
      const r = await fetch('/api/tick', { method: 'POST' })
      const data = await r.json()
      const e = data.entries?.length ?? 0
      const x = data.exits?.length ?? 0
      setTickMsg(`Tick effectué — ${e} entrée(s), ${x} sortie(s)`)
      fetchStatus()
      fetchAnalyze()
    } catch { setTickMsg('Erreur lors du tick') }
    finally { setLoading(false) }
  }

  const drawdown    = status ? ((status.peakCapital - status.capital) / status.peakCapital * 100).toFixed(2) : '0'
  const dailyColor  = status && status.dailyPnl >= 0 ? 'text-green-400' : 'text-red-400'
  const posCount    = status ? Object.keys(status.positions).length : 0

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-white">Trading Boss</h1>
          <p className="text-gray-500 text-sm mt-1">
            Objectif +{status?.config.profitTargetPct ?? 1}% / SL -{status?.config.stopLossPct ?? 0.5}%
            {status?.config.dryRun && <span className="ml-2 text-yellow-400 font-semibold">[DRY RUN]</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {status?.halted && <Badge text="HALTED" color="red" />}
          {!status?.halted && <Badge text="ACTIF" color="green" />}
          <button
            onClick={runTick}
            disabled={loading}
            className="bg-green-600 hover:bg-green-500 disabled:bg-gray-700 text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
          >
            {loading ? 'En cours…' : 'Forcer un Tick'}
          </button>
        </div>
      </div>

      {status?.halted && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 mb-6 text-red-300 text-sm">
          Circuit-breaker actif : {status.haltReason}
        </div>
      )}
      {tickMsg && (
        <div className="bg-blue-900/30 border border-blue-700 rounded-xl p-3 mb-6 text-blue-300 text-sm">
          {tickMsg}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Capital"
          value={`${status?.capital.toFixed(2) ?? '–'} USDT`}
          sub={`Pic : ${status?.peakCapital.toFixed(2) ?? '–'}`}
        />
        <StatCard
          label="P&L Journalier"
          value={`${status?.dailyPnl !== undefined ? (status.dailyPnl >= 0 ? '+' : '') + status.dailyPnl.toFixed(4) : '–'} USDT`}
          color={dailyColor}
        />
        <StatCard
          label="Drawdown"
          value={`${drawdown}%`}
          color={parseFloat(drawdown) > 5 ? 'text-red-400' : 'text-white'}
          sub={`Max : ${status?.config ? '10' : '–'}%`}
        />
        <StatCard
          label="Positions ouvertes"
          value={String(posCount)}
          sub={`Max : ${status?.config ? '3' : '–'}`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Market Analysis */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-white">Analyse du marché</h2>
            <span className="text-xs text-gray-500">Mis à jour : {lastUpdate}</span>
          </div>
          {analyses.length === 0 ? (
            <p className="text-gray-500 text-sm">Chargement de l&apos;analyse…</p>
          ) : (
            <div className="space-y-3">
              {analyses.map(a => (
                <div key={a.symbol} className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-3">
                  <div>
                    <span className="font-semibold text-white text-sm">{a.symbol}</span>
                    <div className="flex gap-2 mt-1 text-xs text-gray-400">
                      <span>RSI {a.details.rsi.toFixed(0)}</span>
                      <span>MACD {a.details.macdCross}</span>
                      <span>EMA {a.details.emaTrend}</span>
                      <span>ADX {a.details.adx.toFixed(0)}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <Badge
                      text={a.action}
                      color={a.action === 'BUY' ? 'green' : a.action === 'SELL' ? 'red' : 'gray'}
                    />
                    <p className="text-xs text-gray-500 mt-1">{a.confidence.toFixed(1)}% conf.</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Open Positions */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="font-semibold text-white mb-4">Positions ouvertes</h2>
          {posCount === 0 ? (
            <p className="text-gray-500 text-sm">Aucune position ouverte.</p>
          ) : (
            <div className="space-y-3">
              {Object.entries(status!.positions).map(([sym, pos]) => (
                <div key={sym} className="bg-gray-800 rounded-lg px-4 py-3">
                  <div className="flex justify-between">
                    <span className="font-semibold text-white text-sm">{sym}</span>
                    <Badge text={pos.side.toUpperCase()} color={pos.side === 'long' ? 'green' : 'red'} />
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-2 text-xs text-gray-400">
                    <span>Entrée : {pos.entryPrice.toFixed(4)}</span>
                    <span className="text-red-400">SL : {pos.stopLoss.toFixed(4)}</span>
                    <span className="text-green-400">TP : {pos.takeProfit.toFixed(4)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Trade History */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="font-semibold text-white mb-4">Historique des trades</h2>
        {!status?.tradeHistory?.length ? (
          <p className="text-gray-500 text-sm">Aucun trade effectué pour le moment.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase border-b border-gray-800">
                  <th className="pb-2 pr-4">Symbole</th>
                  <th className="pb-2 pr-4">Côté</th>
                  <th className="pb-2 pr-4">P&L</th>
                  <th className="pb-2 pr-4">Raison</th>
                  <th className="pb-2">Heure</th>
                </tr>
              </thead>
              <tbody>
                {[...status.tradeHistory].reverse().map((t, i) => (
                  <tr key={i} className="border-b border-gray-800/50">
                    <td className="py-2 pr-4 font-medium text-white">{t.symbol}</td>
                    <td className="py-2 pr-4">
                      <Badge text={t.side} color={t.side === 'long' ? 'green' : 'red'} />
                    </td>
                    <td className={`py-2 pr-4 font-semibold ${t.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(4)} ({t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(2)}%)
                    </td>
                    <td className="py-2 pr-4 text-gray-400 text-xs">{t.reason}</td>
                    <td className="py-2 text-gray-500 text-xs">
                      {new Date(t.closedAt).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-center text-xs text-gray-600 mt-8">
        Exchange : {status?.config.exchange ?? '–'} · Symboles : {status?.config.symbols.join(', ') ?? '–'}
      </p>
    </div>
  )
}
