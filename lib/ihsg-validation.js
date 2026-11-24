'use strict';

// Price alone cannot establish a split or corruption. Date selection and OHLC
// integrity belong to the canonical reader, not an unsupported index range.
function isValidIhsgCandle(candle) {
  return !!candle && candle.close != null && candle.close !== '' &&
    Number.isFinite(Number(candle.close)) && Number(candle.close) > 0;
}

module.exports = {
  isValidIhsgCandle,
  // Deprecated compatibility fields: no evidence-supported fixed range exists.
  IHSG_MODERN_CUTOFF: null,
  IHSG_MODERN_MIN_CLOSE: null,
  IHSG_MODERN_MAX_CLOSE: null,
  IHSG_HISTORICAL_MIN_CLOSE: null,
  IHSG_MIN_VALID_CLOSE: null
};
