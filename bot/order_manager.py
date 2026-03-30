"""
OrderManager — abstracts all exchange order operations.

In DRY_RUN mode, orders are simulated locally so the bot
can be tested without real money.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional
from loguru import logger

import config


@dataclass
class OrderResult:
    symbol: str
    side: str           # "buy" | "sell"
    quantity: float
    price: float
    order_id: str
    status: str         # "filled" | "open" | "rejected" | "simulated"
    timestamp: datetime = None
    fee_usdt: float = 0.0

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()


class OrderManager:
    """
    Wraps ccxt market orders with DRY_RUN simulation support.
    Always uses market orders for immediate execution.
    """

    def __init__(self, exchange):
        self.exchange = exchange
        self.dry_run = config.DRY_RUN
        self._order_counter = 0

        if self.dry_run:
            logger.warning("OrderManager running in DRY_RUN mode — no real orders will be placed.")

    # ── Public API ────────────────────────────────────────────────────────────

    def buy(self, symbol: str, quantity: float, price: float) -> OrderResult:
        """Place a market buy order."""
        if self.dry_run:
            return self._simulate("buy", symbol, quantity, price)
        return self._place_market_order("buy", symbol, quantity, price)

    def sell(self, symbol: str, quantity: float, price: float) -> OrderResult:
        """Place a market sell order."""
        if self.dry_run:
            return self._simulate("sell", symbol, quantity, price)
        return self._place_market_order("sell", symbol, quantity, price)

    def get_current_price(self, symbol: str) -> Optional[float]:
        """Fetch latest ticker price."""
        try:
            ticker = self.exchange.fetch_ticker(symbol)
            return float(ticker["last"])
        except Exception as exc:
            logger.error(f"Price fetch error [{symbol}]: {exc}")
            return None

    # ── Internal ──────────────────────────────────────────────────────────────

    def _place_market_order(self, side: str, symbol: str, quantity: float, price: float) -> OrderResult:
        try:
            order = self.exchange.create_market_order(symbol, side, quantity)
            filled_price = float(order.get("average") or order.get("price") or price)
            fee = float((order.get("fee") or {}).get("cost") or filled_price * quantity * 0.001)
            result = OrderResult(
                symbol=symbol,
                side=side,
                quantity=quantity,
                price=filled_price,
                order_id=str(order["id"]),
                status="filled",
                fee_usdt=fee,
            )
            logger.success(
                f"[ORDER] {side.upper()} {quantity:.6f} {symbol} @ {filled_price:.4f}  "
                f"fee={fee:.4f} USDT  id={result.order_id}"
            )
            return result
        except Exception as exc:
            logger.error(f"Order failed [{side} {symbol}]: {exc}")
            return OrderResult(
                symbol=symbol, side=side, quantity=quantity,
                price=price, order_id="ERR", status="rejected",
            )

    def _simulate(self, side: str, symbol: str, quantity: float, price: float) -> OrderResult:
        self._order_counter += 1
        fee = price * quantity * 0.001   # typical 0.1% taker fee
        order_id = f"SIM-{self._order_counter:05d}"
        logger.info(
            f"[DRY RUN] {side.upper()} {quantity:.6f} {symbol} @ {price:.4f}  "
            f"fee={fee:.4f} USDT  id={order_id}"
        )
        return OrderResult(
            symbol=symbol,
            side=side,
            quantity=quantity,
            price=price,
            order_id=order_id,
            status="simulated",
            fee_usdt=fee,
        )
