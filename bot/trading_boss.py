"""
TradingBoss — the main orchestrator.

The Boss:
  1. Analyzes every symbol in the watchlist before touching anything
  2. Evaluates risk for every potential trade
  3. Opens, manages, and closes positions based on strict rules
  4. Never acts without analysis confidence >= MIN_CONFIDENCE
  5. Respects all circuit-breakers (daily loss, drawdown, max positions)

Flow per loop tick:
  ┌──────────────────────────────────────────────────────────┐
  │  For every symbol                                        │
  │    ① Check exits on existing positions (price, SL, TP)  │
  │    ② Analyze market (RSI + MACD + BB + EMA + Volume)    │
  │    ③ Risk check (circuit breakers, sizing)               │
  │    ④ Execute entry if approved                           │
  └──────────────────────────────────────────────────────────┘
"""
from __future__ import annotations

import time
from typing import Optional
from loguru import logger
from colorama import Fore, Style, init as colorama_init

import config
from bot.market_analyzer import MarketAnalyzer, AnalysisResult
from bot.risk_manager import RiskManager
from bot.order_manager import OrderManager

colorama_init(autoreset=True)


class TradingBoss:
    """
    The Boss: thinks before acting, always manages risk.
    """

    BANNER = f"""
{Fore.CYAN}╔══════════════════════════════════════════════════════╗
║          T R A D I N G   B O S S   v1.0             ║
║  Analysis → Risk Check → Execute  |  Target: +1%    ║
╚══════════════════════════════════════════════════════╝{Style.RESET_ALL}
"""

    def __init__(self, exchange):
        self.exchange = exchange
        self.analyzer = MarketAnalyzer(exchange, timeframe=config.TIMEFRAME)
        self.risk     = RiskManager()
        self.orders   = OrderManager(exchange)
        self._loop_count = 0

    # ── Main loop ─────────────────────────────────────────────────────────────

    def run(self) -> None:
        print(self.BANNER)
        logger.info(
            f"Boss starting  symbols={config.SYMBOLS}  tf={config.TIMEFRAME}  "
            f"target=+{config.PROFIT_TARGET_PCT}%  SL=-{config.STOP_LOSS_PCT}%  "
            f"dry_run={config.DRY_RUN}"
        )

        while True:
            self._loop_count += 1
            logger.info(f"{'─'*60}  Loop #{self._loop_count}")
            self._tick()
            self._print_status()
            logger.info(f"Sleeping {config.LOOP_INTERVAL_SECONDS}s…")
            time.sleep(config.LOOP_INTERVAL_SECONDS)

    def _tick(self) -> None:
        # ── Global circuit-breaker check ──────────────────────────────────────
        halted, reason = self.risk.is_trading_halted()
        if halted:
            logger.warning(f"{Fore.RED}[HALTED] {reason}")
            # Still manage existing positions even when halted
            self._manage_open_positions()
            return

        self._manage_open_positions()
        self._scan_entries()

    # ── Exit management ───────────────────────────────────────────────────────

    def _manage_open_positions(self) -> None:
        """Check all open positions for TP / SL / trailing stop."""
        for symbol in list(self.risk.positions.keys()):
            price = self.orders.get_current_price(symbol)
            if price is None:
                continue

            should_exit, reason = self.risk.evaluate_exit(symbol, price)
            if should_exit:
                self._execute_exit(symbol, price, reason)

    def _execute_exit(self, symbol: str, price: float, reason: str) -> None:
        pos = self.risk.positions.get(symbol)
        if pos is None:
            return

        side = "sell" if pos.side == "long" else "buy"
        result = self.orders.sell(symbol, pos.quantity, price) if pos.side == "long" \
                 else self.orders.buy(symbol, pos.quantity, price)

        if result.status in ("filled", "simulated"):
            pnl = self.risk.close_position(symbol, result.price)
            color = Fore.GREEN if pnl >= 0 else Fore.RED
            logger.info(
                f"{color}[EXIT] {symbol}  reason={reason}  "
                f"price={result.price:.4f}  pnl={pnl:+.4f} USDT"
            )
        else:
            logger.error(f"[EXIT FAILED] {symbol} — order rejected")

    # ── Entry scanning ────────────────────────────────────────────────────────

    def _scan_entries(self) -> None:
        """
        For each symbol not already in a position:
          1. Run full market analysis
          2. If confidence >= threshold → risk check → enter
        """
        for symbol in config.SYMBOLS:
            if symbol in self.risk.positions:
                continue   # already managing this one

            # ── STEP 1: Analyze ───────────────────────────────────────────────
            logger.info(f"[ANALYSIS] Scanning {symbol}…")
            analysis: AnalysisResult = self.analyzer.analyze(symbol, config.MIN_CONFIDENCE)
            self._print_analysis(analysis)

            if analysis.action == "HOLD":
                logger.debug(f"[SKIP] {symbol} — confidence too low ({analysis.confidence:.1f}%)")
                continue

            # ── STEP 2: Determine side ────────────────────────────────────────
            side = "long" if analysis.action == "BUY" else "short"

            # Get current price
            price = self.orders.get_current_price(symbol)
            if price is None:
                logger.warning(f"[SKIP] {symbol} — could not fetch price")
                continue

            # ── STEP 3: Risk check ────────────────────────────────────────────
            decision = self.risk.evaluate_entry(symbol, price, side)
            if not decision.allowed:
                logger.info(f"[RISK DENIED] {symbol} — {decision.reason}")
                continue

            # ── STEP 4: Execute ───────────────────────────────────────────────
            self._execute_entry(
                symbol=symbol,
                side=side,
                price=price,
                quantity=decision.quantity,
                stop_loss=decision.stop_loss,
                take_profit=decision.take_profit,
                analysis=analysis,
            )

    def _execute_entry(
        self,
        symbol: str,
        side: str,
        price: float,
        quantity: float,
        stop_loss: float,
        take_profit: float,
        analysis: AnalysisResult,
    ) -> None:
        logger.info(
            f"{Fore.YELLOW}[ENTRY] {symbol} {side.upper()}  "
            f"price={price:.4f}  qty={quantity:.6f}  "
            f"SL={stop_loss:.4f}  TP={take_profit:.4f}  "
            f"confidence={analysis.confidence:.1f}%"
        )

        result = (
            self.orders.buy(symbol, quantity, price)
            if side == "long"
            else self.orders.sell(symbol, quantity, price)
        )

        if result.status in ("filled", "simulated"):
            self.risk.register_position(
                symbol=symbol,
                side=side,
                entry_price=result.price,
                quantity=result.quantity,
                stop_loss=stop_loss,
                take_profit=take_profit,
            )
        else:
            logger.error(f"[ENTRY FAILED] {symbol} — order rejected by exchange")

    # ── Display helpers ───────────────────────────────────────────────────────

    def _print_analysis(self, a: AnalysisResult) -> None:
        color = Fore.GREEN if a.action == "BUY" else (Fore.RED if a.action == "SELL" else Fore.WHITE)
        rsi  = a.details.get("rsi", 0)
        bb   = a.details.get("bb_pct", 0.5)
        adx  = a.details.get("adx", 0)
        trend = a.details.get("ema_trend", "?")
        macd  = a.details.get("macd_cross", "?")
        logger.info(
            f"{color}[MARKET] {a.symbol}  action={a.action}  "
            f"conf={a.confidence:.1f}%  "
            f"RSI={rsi:.1f}  BB={bb:.2f}  ADX={adx:.1f}  "
            f"EMA={trend}  MACD={macd}"
        )

    def _print_status(self) -> None:
        s = self.risk.status_report()
        logger.info(
            f"[STATUS] capital={s['capital']} USDT  "
            f"daily_pnl={s['daily_pnl']:+.4f}  "
            f"drawdown={s['drawdown_pct']:.2f}%  "
            f"positions={s['open_positions']}/{config.MAX_CONCURRENT_POSITIONS}  "
            f"{s['positions']}"
        )
