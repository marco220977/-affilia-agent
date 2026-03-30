"""
MarketAnalyzer — technical analysis engine.

Indicators computed:
  • RSI (14)          — momentum: oversold/overbought
  • MACD (12/26/9)    — trend direction & crossover
  • Bollinger Bands (20, 2σ) — volatility & mean-reversion
  • EMA 9 / 21 / 50   — short / medium / long trend
  • ADX (14)          — trend strength
  • Volume ratio      — confirms moves with above-average volume

Each indicator emits a signal score in [-1, +1]:
  +1 = strong buy, -1 = strong sell, 0 = neutral

Final `confidence` is the weighted average mapped to [0, 100].
A positive score means bullish; negative means bearish.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from dataclasses import dataclass, field
from typing import Optional
from loguru import logger


# ─── Signal weights (must sum to 1.0) ────────────────────────────────────────
WEIGHTS = {
    "rsi":      0.25,
    "macd":     0.25,
    "bb":       0.20,
    "ema":      0.20,
    "volume":   0.10,
}
assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9, "Weights must sum to 1.0"


@dataclass
class AnalysisResult:
    symbol: str
    signal: float          # -1.0 .. +1.0  (positive = buy, negative = sell)
    confidence: float      # 0 .. 100
    action: str            # "BUY" | "SELL" | "HOLD"
    details: dict = field(default_factory=dict)

    def __str__(self) -> str:
        arrow = "▲" if self.signal > 0 else ("▼" if self.signal < 0 else "–")
        return (
            f"[{self.symbol}] {arrow} {self.action}  "
            f"signal={self.signal:+.3f}  confidence={self.confidence:.1f}%  "
            f"RSI={self.details.get('rsi', 0):.1f}  "
            f"MACD={'↑' if self.details.get('macd_cross') == 'bull' else '↓'}  "
            f"trend={'↑' if self.details.get('ema_trend') == 'bull' else '↓'}"
        )


class MarketAnalyzer:
    """
    Fetches OHLCV candles and runs multi-indicator analysis.
    Works with a ccxt exchange instance (sync or async proxy).
    """

    def __init__(self, exchange, timeframe: str = "5m", candle_limit: int = 200):
        self.exchange = exchange
        self.timeframe = timeframe
        self.candle_limit = candle_limit

    # ── Public API ────────────────────────────────────────────────────────────

    def analyze(self, symbol: str, min_confidence: float = 65.0) -> AnalysisResult:
        """Full analysis pipeline for one symbol."""
        df = self._fetch_ohlcv(symbol)
        if df is None or len(df) < 60:
            logger.warning(f"Not enough candles for {symbol}")
            return AnalysisResult(symbol=symbol, signal=0.0, confidence=0.0, action="HOLD")

        signals: dict[str, float] = {}
        details: dict = {}

        # ── RSI ───────────────────────────────────────────────────────────────
        rsi_val = self._rsi(df["close"])
        signals["rsi"] = self._rsi_signal(rsi_val)
        details["rsi"] = rsi_val

        # ── MACD ──────────────────────────────────────────────────────────────
        macd_sig, macd_cross = self._macd_signal(df["close"])
        signals["macd"] = macd_sig
        details["macd_cross"] = macd_cross

        # ── Bollinger Bands ───────────────────────────────────────────────────
        bb_sig, bb_pct = self._bb_signal(df["close"])
        signals["bb"] = bb_sig
        details["bb_pct"] = bb_pct

        # ── EMA trend ─────────────────────────────────────────────────────────
        ema_sig, ema_trend = self._ema_signal(df["close"])
        signals["ema"] = ema_sig
        details["ema_trend"] = ema_trend

        # ── Volume confirmation ───────────────────────────────────────────────
        vol_sig = self._volume_signal(df["volume"])
        signals["volume"] = vol_sig
        details["volume_ratio"] = vol_sig

        # ── ADX (trend strength — used as a confidence multiplier) ───────────
        adx_val = self._adx(df)
        details["adx"] = adx_val
        adx_mult = min(adx_val / 25.0, 1.5)   # >25 = trending market

        # ── Aggregate ─────────────────────────────────────────────────────────
        raw_signal = sum(WEIGHTS[k] * signals[k] for k in WEIGHTS)
        raw_signal = float(np.clip(raw_signal * adx_mult, -1.0, 1.0))

        # Convert to 0–100 confidence (absolute value → how sure we are)
        confidence = abs(raw_signal) * 100.0

        # Decide action
        if raw_signal >= 0 and confidence >= min_confidence:
            action = "BUY"
        elif raw_signal < 0 and confidence >= min_confidence:
            action = "SELL"
        else:
            action = "HOLD"

        result = AnalysisResult(
            symbol=symbol,
            signal=raw_signal,
            confidence=confidence,
            action=action,
            details=details,
        )
        logger.debug(str(result))
        return result

    # ── OHLCV fetch ───────────────────────────────────────────────────────────

    def _fetch_ohlcv(self, symbol: str) -> Optional[pd.DataFrame]:
        try:
            raw = self.exchange.fetch_ohlcv(symbol, self.timeframe, limit=self.candle_limit)
            df = pd.DataFrame(raw, columns=["ts", "open", "high", "low", "close", "volume"])
            df["ts"] = pd.to_datetime(df["ts"], unit="ms")
            df = df.set_index("ts").astype(float)
            return df
        except Exception as exc:
            logger.error(f"OHLCV fetch error [{symbol}]: {exc}")
            return None

    # ── Indicators ────────────────────────────────────────────────────────────

    @staticmethod
    def _ema(series: pd.Series, period: int) -> pd.Series:
        return series.ewm(span=period, adjust=False).mean()

    @staticmethod
    def _rsi(close: pd.Series, period: int = 14) -> float:
        delta = close.diff()
        gain = delta.clip(lower=0).rolling(period).mean()
        loss = (-delta.clip(upper=0)).rolling(period).mean()
        rs = gain / loss.replace(0, np.nan)
        rsi = 100 - (100 / (1 + rs))
        return float(rsi.iloc[-1])

    def _rsi_signal(self, rsi: float) -> float:
        """
        RSI signal:
          <30 → strong buy (+1), >70 → strong sell (-1)
          30-45 → mild buy, 55-70 → mild sell, 45-55 → neutral
        """
        if rsi < 30:
            return 1.0
        if rsi < 40:
            return 0.6
        if rsi < 45:
            return 0.3
        if rsi > 70:
            return -1.0
        if rsi > 60:
            return -0.6
        if rsi > 55:
            return -0.3
        return 0.0

    def _macd_signal(self, close: pd.Series) -> tuple[float, str]:
        ema_fast = self._ema(close, 12)
        ema_slow = self._ema(close, 26)
        macd_line = ema_fast - ema_slow
        signal_line = self._ema(macd_line, 9)
        hist = macd_line - signal_line

        h_now  = float(hist.iloc[-1])
        h_prev = float(hist.iloc[-2])

        # Crossover detection
        if h_prev <= 0 and h_now > 0:
            return 1.0, "bull"      # bullish crossover
        if h_prev >= 0 and h_now < 0:
            return -1.0, "bear"     # bearish crossover

        # No crossover — use histogram slope
        slope = h_now - h_prev
        score = float(np.clip(slope / (abs(h_now) + 1e-9), -1.0, 1.0)) * 0.5
        trend = "bull" if h_now > 0 else "bear"
        return score, trend

    def _bb_signal(self, close: pd.Series, period: int = 20, std: float = 2.0) -> tuple[float, float]:
        ma  = close.rolling(period).mean()
        sd  = close.rolling(period).std()
        upper = ma + std * sd
        lower = ma - std * sd

        price = float(close.iloc[-1])
        u = float(upper.iloc[-1])
        l = float(lower.iloc[-1])
        m = float(ma.iloc[-1])

        band_width = u - l
        if band_width < 1e-9:
            return 0.0, 0.5

        pct = (price - l) / band_width   # 0 = at lower band, 1 = at upper band

        if pct < 0.1:
            score = 1.0
        elif pct < 0.3:
            score = 0.5
        elif pct > 0.9:
            score = -1.0
        elif pct > 0.7:
            score = -0.5
        else:
            # Trend-following inside the band
            score = (0.5 - pct) * 0.4   # small score toward mean

        return score, pct

    def _ema_signal(self, close: pd.Series) -> tuple[float, str]:
        e9  = self._ema(close, 9)
        e21 = self._ema(close, 21)
        e50 = self._ema(close, 50)

        v9  = float(e9.iloc[-1])
        v21 = float(e21.iloc[-1])
        v50 = float(e50.iloc[-1])
        price = float(close.iloc[-1])

        bullish_count = sum([
            v9 > v21,
            v21 > v50,
            price > v9,
        ])
        bearish_count = sum([
            v9 < v21,
            v21 < v50,
            price < v9,
        ])

        if bullish_count == 3:
            return 1.0, "bull"
        if bullish_count == 2:
            return 0.5, "bull"
        if bearish_count == 3:
            return -1.0, "bear"
        if bearish_count == 2:
            return -0.5, "bear"
        return 0.0, "neutral"

    @staticmethod
    def _volume_signal(volume: pd.Series, window: int = 20) -> float:
        avg_vol = float(volume.rolling(window).mean().iloc[-1])
        cur_vol = float(volume.iloc[-1])
        if avg_vol < 1e-9:
            return 0.0
        ratio = cur_vol / avg_vol
        # High volume confirms the move — amplify; low volume is neutral
        return float(np.clip((ratio - 1.0) * 0.5, -0.5, 1.0))

    @staticmethod
    def _adx(df: pd.DataFrame, period: int = 14) -> float:
        high  = df["high"]
        low   = df["low"]
        close = df["close"]

        tr = pd.concat([
            high - low,
            (high - close.shift()).abs(),
            (low  - close.shift()).abs(),
        ], axis=1).max(axis=1)

        dm_plus  = (high - high.shift()).clip(lower=0)
        dm_minus = (low.shift() - low).clip(lower=0)

        # Zero out where the other is larger
        dm_plus  = dm_plus.where(dm_plus > dm_minus, 0)
        dm_minus = dm_minus.where(dm_minus > dm_plus, 0)

        atr  = tr.rolling(period).mean()
        dp   = 100 * dm_plus.rolling(period).mean()  / atr.replace(0, np.nan)
        dm   = 100 * dm_minus.rolling(period).mean() / atr.replace(0, np.nan)
        dx   = (100 * (dp - dm).abs() / (dp + dm).replace(0, np.nan))
        adx  = dx.rolling(period).mean()
        return float(adx.iloc[-1]) if not np.isnan(adx.iloc[-1]) else 20.0
