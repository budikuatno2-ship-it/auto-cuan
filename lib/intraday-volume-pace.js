'use strict';

const VERSION = 'INTRADAY_VOLUME_PACE_V1';
const MIN_EFFECTIVE_PROGRESS = 0.08;
const MAX_PACE_RATIO = 6;

function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round2(value) {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function toMinutes(value) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))) return null;
  const [hour, minute] = String(value).split(':').map(Number);
  return hour * 60 + minute;
}

function tradingSchedule(sampleDate) {
  if (!validDate(sampleDate)) return null;
  const day = new Date(`${sampleDate}T00:00:00Z`).getUTCDay();
  if (day === 0 || day === 6) return { day, total: 0, windows: [] };
  if (day === 5) {
    return {
      day,
      total: 270,
      windows: [
        { start: 540, end: 690 },
        { start: 840, end: 960 }
      ]
    };
  }
  return {
    day,
    total: 330,
    windows: [
      { start: 540, end: 720 },
      { start: 810, end: 960 }
    ]
  };
}

function sessionProgress(sampleDate, scheduledTime) {
  const schedule = tradingSchedule(sampleDate);
  const minute = toMinutes(scheduledTime);
  if (!schedule || minute == null) {
    return {
      session_progress_fraction: null,
      effective_session_progress: null,
      active_trading_minutes: null,
      total_trading_minutes: schedule ? schedule.total : null,
      market_state: 'INVALID_TIME',
      volume_pace_confidence: 'LOW'
    };
  }
  if (!schedule.windows.length) {
    return {
      session_progress_fraction: 0,
      effective_session_progress: null,
      active_trading_minutes: 0,
      total_trading_minutes: 0,
      market_state: 'NON_TRADING_DAY',
      volume_pace_confidence: 'LOW'
    };
  }

  let active = 0;
  let marketState = 'BEFORE_OPEN';
  for (let index = 0; index < schedule.windows.length; index += 1) {
    const window = schedule.windows[index];
    if (minute < window.start) {
      marketState = index === 0 ? 'BEFORE_OPEN' : 'MARKET_BREAK';
      break;
    }
    if (minute >= window.end) {
      active += window.end - window.start;
      marketState = index === schedule.windows.length - 1 ? 'AFTER_CLOSE' : 'MARKET_BREAK';
      continue;
    }
    active += minute - window.start;
    marketState = 'ACTIVE_SESSION';
    break;
  }

  const progress = schedule.total > 0 ? clamp(active / schedule.total, 0, 1) : 0;
  const effective = progress > 0 ? (progress >= 1 ? 1 : Math.max(progress, MIN_EFFECTIVE_PROGRESS)) : null;
  return {
    session_progress_fraction: round2(progress),
    effective_session_progress: round2(effective),
    active_trading_minutes: active,
    total_trading_minutes: schedule.total,
    market_state: marketState,
    volume_pace_confidence: progress >= MIN_EFFECTIVE_PROGRESS ? 'HIGH' : 'LOW'
  };
}

function candleDate(candle) {
  if (!candle || typeof candle !== 'object') return null;
  const direct = candle.date || candle.price_date;
  if (typeof direct === 'string' && /^\d{4}-\d{2}-\d{2}/.test(direct)) return direct.slice(0, 10);
  const raw = candle.time ?? candle.timestamp;
  if (raw == null) return null;
  const millis = Number(raw) > 1e12 ? Number(raw) : Number(raw) * 1000;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function completedCandles(candles, sampleDate) {
  if (!Array.isArray(candles) || !validDate(sampleDate)) return [];
  return candles
    .map((candle, index) => ({ candle, index, date: candleDate(candle), volume: finite(candle && candle.volume) }))
    .filter(row => row.date && row.date < sampleDate && row.volume != null && row.volume > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index);
}

function average(values) {
  const valid = values.filter(value => value != null && Number.isFinite(value) && value > 0);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function deriveBaselines(input) {
  const data = input || {};
  const history = completedCandles(data.candles, data.sample_date);
  let previousDayVolume = finite(data.previous_day_volume);
  let averageExToday = finite(data.avg_volume_20d_ex_today);
  let source = [];

  if (previousDayVolume == null && history.length) {
    previousDayVolume = history[history.length - 1].volume;
    source.push('completed_candles_previous_day');
  } else if (previousDayVolume != null) {
    source.push('explicit_previous_day');
  }

  if (averageExToday == null && history.length) {
    averageExToday = average(history.slice(-20).map(row => row.volume));
    source.push('completed_candles_20d');
  } else if (averageExToday != null) {
    source.push('explicit_20d_ex_today');
  }

  if (averageExToday == null) {
    const legacyAverage = finite(data.avg_volume_20d ?? data.average_volume);
    const currentVolume = finite(data.volume_today ?? data.volume);
    const count = Math.max(2, Math.min(20, Math.trunc(finite(data.avg_volume_sample_count) || 20)));
    if (legacyAverage != null && legacyAverage > 0 && currentVolume != null && currentVolume >= 0) {
      const derived = ((legacyAverage * count) - currentVolume) / (count - 1);
      if (derived > 0) {
        averageExToday = derived;
        source.push('derived_legacy_average_ex_today');
      }
    }
  }

  return {
    previous_day_volume: round2(previousDayVolume),
    avg_volume_20d_ex_today: round2(averageExToday),
    volume_baseline_source: source.length ? source.join('+') : 'unavailable'
  };
}

function calculateVolumePace(input) {
  const data = input || {};
  const progress = sessionProgress(data.sample_date, data.scheduled_time);
  const baselines = deriveBaselines(data);
  const volumeToday = finite(data.volume_today ?? data.volume);
  const effective = progress.effective_session_progress;
  const projected = volumeToday != null && volumeToday >= 0 && effective != null && effective > 0
    ? volumeToday / effective
    : null;
  const vs20 = projected != null && baselines.avg_volume_20d_ex_today != null && baselines.avg_volume_20d_ex_today > 0
    ? projected / baselines.avg_volume_20d_ex_today
    : null;
  const vsPrevious = projected != null && baselines.previous_day_volume != null && baselines.previous_day_volume > 0
    ? projected / baselines.previous_day_volume
    : null;

  let pace = null;
  if (vs20 != null && vsPrevious != null) pace = (0.75 * vs20) + (0.25 * vsPrevious);
  else if (vs20 != null) pace = vs20;
  else if (vsPrevious != null) pace = vsPrevious;
  if (pace != null) pace = clamp(pace, 0, MAX_PACE_RATIO);

  let confidence = progress.volume_pace_confidence;
  if (pace == null) confidence = 'LOW';
  else if (confidence !== 'LOW' && (vs20 == null || vsPrevious == null)) confidence = 'MEDIUM';

  return Object.assign({}, progress, baselines, {
    volume_pace_version: VERSION,
    projected_full_day_volume: round2(projected),
    volume_pace_vs_20d: round2(vs20),
    volume_pace_vs_prev_day: round2(vsPrevious),
    intraday_volume_pace_ratio: round2(pace),
    volume_pace_confidence: confidence
  });
}

function enrichObservation(observation, context) {
  const obs = observation && typeof observation === 'object' ? observation : {};
  const ctx = context || {};
  const structural = obs.structural_context && typeof obs.structural_context === 'object' ? obs.structural_context : {};
  const candles = ctx.candles || obs.candles || obs.last_30_candles || structural.last_30_candles || null;
  const pace = calculateVolumePace({
    sample_date: ctx.sampleDate || obs.sample_date || obs.date || null,
    scheduled_time: ctx.scheduledTime || obs.scheduled_time || obs.observation_time || obs.time || null,
    volume_today: obs.volume_today ?? obs.volume,
    previous_day_volume: obs.previous_day_volume,
    avg_volume_20d_ex_today: obs.avg_volume_20d_ex_today,
    avg_volume_20d: obs.avg_volume_20d ?? obs.average_volume,
    avg_volume_sample_count: obs.avg_volume_sample_count,
    candles
  });
  return Object.assign({}, obs, pace, {
    effective_volume_ratio: pace.intraday_volume_pace_ratio
      ?? finite(obs.effective_volume_ratio)
      ?? finite(obs.relative_volume)
      ?? finite(obs.volume_ratio_20d)
  });
}

module.exports = {
  VERSION,
  MIN_EFFECTIVE_PROGRESS,
  MAX_PACE_RATIO,
  finite,
  round2,
  validDate,
  toMinutes,
  tradingSchedule,
  sessionProgress,
  candleDate,
  completedCandles,
  deriveBaselines,
  calculateVolumePace,
  enrichObservation
};
