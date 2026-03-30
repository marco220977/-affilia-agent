"""
Entry point — Trading Boss
Usage:
    cp .env.example .env          # edit with your keys
    pip install -r requirements.txt
    python main.py
"""
import sys
import ccxt
from loguru import logger

import config
from bot.trading_boss import TradingBoss


def setup_logger() -> None:
    logger.remove()
    logger.add(
        sys.stdout,
        format="<green>{time:HH:mm:ss}</green> | <level>{level:<8}</level> | {message}",
        level="DEBUG" if config.DRY_RUN else "INFO",
        colorize=True,
    )
    logger.add(
        "logs/trading_boss.log",
        rotation="10 MB",
        retention="7 days",
        level="DEBUG",
        encoding="utf-8",
    )


def build_exchange() -> ccxt.Exchange:
    exchange_class = getattr(ccxt, config.EXCHANGE)
    exchange = exchange_class({
        "apiKey":    config.API_KEY,
        "secret":    config.API_SECRET,
        "enableRateLimit": True,
        "options": {
            "defaultType": "spot",
        },
    })

    if config.DRY_RUN:
        exchange.set_sandbox_mode(False)   # use real market data, simulated orders
        logger.warning("DRY RUN active — no real orders will be placed.")

    # Verify connectivity
    try:
        exchange.load_markets()
        logger.info(f"Connected to {config.EXCHANGE.upper()} — {len(exchange.markets)} markets loaded.")
    except Exception as exc:
        logger.error(f"Exchange connection failed: {exc}")
        sys.exit(1)

    return exchange


def main() -> None:
    import os
    os.makedirs("logs", exist_ok=True)
    setup_logger()

    logger.info("Starting Trading Boss…")
    logger.info(
        f"Config: exchange={config.EXCHANGE}  symbols={config.SYMBOLS}  "
        f"tf={config.TIMEFRAME}  capital={config.TOTAL_CAPITAL}  dry_run={config.DRY_RUN}"
    )

    exchange = build_exchange()
    boss = TradingBoss(exchange)

    try:
        boss.run()
    except KeyboardInterrupt:
        logger.info("Interrupted by user. Goodbye.")
        status = boss.risk.status_report()
        logger.info(f"Final status: {status}")


if __name__ == "__main__":
    main()
