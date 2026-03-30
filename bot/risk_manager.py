"""
RiskManager — enforces all risk rules before any trade is executed.

Rules:
  1. Max position size      — never risk more than X% of capital per trade
  2. Stop-loss              — hard stop at entry × (1 - SL%)
  3. Trailing stop          — activates after +TRAIL_ACTIVATE%, trails by TRAIL_PCT%
  4. Profit target          — close at entry × (1 + TARGET%)
  5. Max concurrent positions
  6. Daily loss circuit-breaker   — halt if daily P&L < -MAX_DAILY_LOSS%
  7. Max drawdown circuit-breaker — halt if peak→current drawdown > MAX_DRAWDOWN%
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Optional
from loguru import logger

import config


@dataclass
class Position:
    symbol: str
    side: str                  # "long" | "short"
    entry_price: float
    quantity: float
    capital_at_risk: float     # USDT committed
    stop_loss: float
    take_profit: float
    trailing_active: bool = False
    trailing_stop: float = 0.0
    opened_at: datetime = field(default_factory=datetime.utcnow)

    @property
    def current_pnl_pct(self) -> float:
        """Placeholder — updated by the boss with live price."""
        return 0.0


@dataclass
class RiskDecision:
    allowed: bool
    reason: str
    quantity: float = 0.0
    stop_loss: float = 0.0
    take_profit: float = 0.0


class RiskManager:
    def __init__(self):
        self.capital = config.TOTAL_CAPITAL
        self.peak_capital = config.TOTAL_CAPITAL

        # Daily tracking
        self._day: date = date.today()
        self._daily_pnl: float = 0.0

        # Open positions
        self.positions: dict[str, Position] = {}

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _reset_daily_if_needed(self) -> None:
        today = date.today()
        if today != self._day:
            self._day = today
            self._daily_pnl = 0.0
            logger.info("Daily P&L counter reset for new day.")

    @property
    def drawdown_pct(self) -> float:
        if self.peak_capital <= 0:
            return 0.0
        return (self.peak_capital - self.capital) / self.peak_capital * 100.0

    @property
    def daily_loss_pct(self) -> float:
        return (-self._daily_pnl / self.capital * 100.0) if self._daily_pnl < 0 else 0.0

    # ── Circuit breakers ──────────────────────────────────────────────────────

    def is_trading_halted(self) -> tuple[bool, str]:
        self._reset_daily_if_needed()
        if self.daily_loss_pct >= config.MAX_DAILY_LOSS_PCT:
            return True, f"Daily loss limit reached ({self.daily_loss_pct:.2f}% >= {config.MAX_DAILY_LOSS_PCT}%)"
        if self.drawdown_pct >= config.MAX_DRAWDOWN_PCT:
            return True, f"Max drawdown reached ({self.drawdown_pct:.2f}% >= {config.MAX_DRAWDOWN_PCT}%)"
        return False, ""

    # ── Entry decision ────────────────────────────────────────────────────────

    def evaluate_entry(self, symbol: str, price: float, side: str = "long") -> RiskDecision:
        """
        Returns a RiskDecision indicating whether a new position is allowed
        and, if so, the quantity to buy plus SL/TP levels.
        """
        # Circuit breakers
        halted, reason = self.is_trading_halted()
        if halted:
            return RiskDecision(allowed=False, reason=reason)

        # Max concurrent positions
        if len(self.positions) >= config.MAX_CONCURRENT_POSITIONS:
            return RiskDecision(
                allowed=False,
                reason=f"Max concurrent positions ({config.MAX_CONCURRENT_POSITIONS}) reached",
            )

        # Already in this symbol
        if symbol in self.positions:
            return RiskDecision(allowed=False, reason=f"Already holding position in {symbol}")

        # Position sizing — risk only MAX_POSITION_SIZE_PCT of capital
        capital_at_risk = self.capital * (config.MAX_POSITION_SIZE_PCT / 100.0)
        quantity = capital_at_risk / price

        # Stop-loss & take-profit
        if side == "long":
            stop_loss   = price * (1.0 - config.STOP_LOSS_PCT / 100.0)
            take_profit = price * (1.0 + config.PROFIT_TARGET_PCT / 100.0)
        else:  # short
            stop_loss   = price * (1.0 + config.STOP_LOSS_PCT / 100.0)
            take_profit = price * (1.0 - config.PROFIT_TARGET_PCT / 100.0)

        logger.info(
            f"[RISK] Entry approved — {symbol} {side.upper()}  "
            f"qty={quantity:.6f}  SL={stop_loss:.4f}  TP={take_profit:.4f}  "
            f"capital_at_risk={capital_at_risk:.2f}"
        )
        return RiskDecision(
            allowed=True,
            reason="OK",
            quantity=quantity,
            stop_loss=stop_loss,
            take_profit=take_profit,
        )

    # ── Position registration ─────────────────────────────────────────────────

    def register_position(
        self,
        symbol: str,
        side: str,
        entry_price: float,
        quantity: float,
        stop_loss: float,
        take_profit: float,
    ) -> Position:
        pos = Position(
            symbol=symbol,
            side=side,
            entry_price=entry_price,
            quantity=quantity,
            capital_at_risk=entry_price * quantity,
            stop_loss=stop_loss,
            take_profit=take_profit,
        )
        self.positions[symbol] = pos
        logger.info(f"[RISK] Position registered: {symbol} {side.upper()} @ {entry_price:.4f}")
        return pos

    # ── Exit evaluation ───────────────────────────────────────────────────────

    def evaluate_exit(self, symbol: str, current_price: float) -> tuple[bool, str]:
        """
        Returns (should_exit, reason).
        Updates trailing stop if applicable.
        """
        pos = self.positions.get(symbol)
        if pos is None:
            return False, "no position"

        if pos.side == "long":
            pnl_pct = (current_price - pos.entry_price) / pos.entry_price * 100.0

            # Take profit
            if current_price >= pos.take_profit:
                return True, f"TAKE_PROFIT +{pnl_pct:.2f}%"

            # Update trailing stop
            if pnl_pct >= config.TRAILING_STOP_ACTIVATE_PCT:
                new_trail = current_price * (1.0 - config.TRAILING_STOP_TRAIL_PCT / 100.0)
                if not pos.trailing_active or new_trail > pos.trailing_stop:
                    pos.trailing_active = True
                    pos.trailing_stop = new_trail
                    logger.debug(f"[TRAIL] {symbol} trailing stop updated → {new_trail:.4f}")

            # Trailing stop hit
            if pos.trailing_active and current_price <= pos.trailing_stop:
                return True, f"TRAILING_STOP pnl={pnl_pct:.2f}%"

            # Hard stop-loss
            if current_price <= pos.stop_loss:
                return True, f"STOP_LOSS {pnl_pct:.2f}%"

        else:  # short
            pnl_pct = (pos.entry_price - current_price) / pos.entry_price * 100.0

            if current_price <= pos.take_profit:
                return True, f"TAKE_PROFIT +{pnl_pct:.2f}%"
            if current_price >= pos.stop_loss:
                return True, f"STOP_LOSS {pnl_pct:.2f}%"

        return False, ""

    # ── P&L accounting ────────────────────────────────────────────────────────

    def close_position(self, symbol: str, exit_price: float) -> float:
        """Records P&L and removes the position. Returns realized P&L in USDT."""
        pos = self.positions.pop(symbol, None)
        if pos is None:
            return 0.0

        if pos.side == "long":
            pnl = (exit_price - pos.entry_price) * pos.quantity
        else:
            pnl = (pos.entry_price - exit_price) * pos.quantity

        self.capital += pnl
        self._daily_pnl += pnl
        if self.capital > self.peak_capital:
            self.peak_capital = self.capital

        pct = pnl / pos.capital_at_risk * 100.0
        level = "info" if pnl >= 0 else "warning"
        getattr(logger, level)(
            f"[PNL] {symbol} closed @ {exit_price:.4f}  "
            f"pnl={pnl:+.4f} USDT ({pct:+.2f}%)  "
            f"capital={self.capital:.2f}  daily_pnl={self._daily_pnl:+.2f}"
        )
        return pnl

    # ── Status ────────────────────────────────────────────────────────────────

    def status_report(self) -> dict:
        self._reset_daily_if_needed()
        return {
            "capital": round(self.capital, 4),
            "peak_capital": round(self.peak_capital, 4),
            "drawdown_pct": round(self.drawdown_pct, 2),
            "daily_pnl": round(self._daily_pnl, 4),
            "daily_loss_pct": round(self.daily_loss_pct, 2),
            "open_positions": len(self.positions),
            "positions": list(self.positions.keys()),
        }
