"""
Configuration loader — reads from environment / .env file.
"""
import os
from dotenv import load_dotenv

load_dotenv()

def _float(key: str, default: float) -> float:
    return float(os.getenv(key, default))

def _int(key: str, default: int) -> int:
    return int(os.getenv(key, default))

def _bool(key: str, default: bool) -> bool:
    val = os.getenv(key, str(default)).lower()
    return val in ("1", "true", "yes")

def _list(key: str, default: str) -> list[str]:
    return [s.strip() for s in os.getenv(key, default).split(",") if s.strip()]


# ── Exchange ──────────────────────────────────────────────────────────────────
EXCHANGE        = os.getenv("EXCHANGE", "binance")
API_KEY         = os.getenv("API_KEY", "")
API_SECRET      = os.getenv("API_SECRET", "")
DRY_RUN         = _bool("DRY_RUN", True)

# ── Universe ──────────────────────────────────────────────────────────────────
SYMBOLS         = _list("SYMBOLS", "BTC/USDT,ETH/USDT,BNB/USDT")
TIMEFRAME       = os.getenv("TIMEFRAME", "5m")

# ── Capital ───────────────────────────────────────────────────────────────────
TOTAL_CAPITAL           = _float("TOTAL_CAPITAL", 1000.0)
MAX_POSITION_SIZE_PCT   = _float("MAX_POSITION_SIZE_PCT", 2.0)   # % of capital per trade
MAX_DAILY_LOSS_PCT      = _float("MAX_DAILY_LOSS_PCT", 3.0)      # halt if daily P&L < -X%
MAX_CONCURRENT_POSITIONS= _int("MAX_CONCURRENT_POSITIONS", 3)
MAX_DRAWDOWN_PCT        = _float("MAX_DRAWDOWN_PCT", 10.0)       # halt entire bot

# ── Trade targets ─────────────────────────────────────────────────────────────
PROFIT_TARGET_PCT           = _float("PROFIT_TARGET_PCT", 1.0)
STOP_LOSS_PCT               = _float("STOP_LOSS_PCT", 0.5)
TRAILING_STOP_ACTIVATE_PCT  = _float("TRAILING_STOP_ACTIVATE_PCT", 0.7)
TRAILING_STOP_TRAIL_PCT     = _float("TRAILING_STOP_TRAIL_PCT", 0.3)

# ── Analysis ──────────────────────────────────────────────────────────────────
MIN_CONFIDENCE          = _float("MIN_CONFIDENCE", 65.0)   # minimum signal score (0-100)
LOOP_INTERVAL_SECONDS   = _int("LOOP_INTERVAL_SECONDS", 30)

# ── Sanity checks ─────────────────────────────────────────────────────────────
assert STOP_LOSS_PCT < PROFIT_TARGET_PCT, "Stop-loss must be smaller than profit target"
assert MAX_POSITION_SIZE_PCT <= 100.0
assert 0 < MIN_CONFIDENCE <= 100
