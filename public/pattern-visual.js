(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanPatternVisual = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Pattern geometry is drawn here, in the page, as inline SVG.
  //
  // The previous implementation POSTed the ticker, its full close series and
  // every pattern level to quickchart.io and rendered the returned PNG. That
  // shipped admin-only Pattern geometry to a third party on every card open,
  // added a network round trip to the one visual the feature exists for, and
  // — as reproduced on a restricted network — left the card showing
  // "Visual pattern belum dapat dimuat" with nothing to look at.
  //
  // Everything below is a pure string builder: same input, same markup, no I/O.

  var VERSION = '20260813-pattern-visual-v1';
  var NS = 'http://www.w3.org/2000/svg';

  var COLORS = {
    price: '#94a3b8',
    priceFill: 'rgba(148,163,184,0.10)',
    structure: '#38bdf8',
    confirmation: '#34d399',
    invalidation: '#f87171',
    target: '#fbbf24',
    prz: '#c084fc',
    current: '#e2e8f0',
    grid: 'rgba(148,163,184,0.14)',
    axis: '#64748b'
  };

  // null, undefined and '' all coerce to 0 through Number(), which would turn a
  // missing level into a printed "0". Missing stays missing.
  function finite(value) {
    if (value == null || value === '') return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function round(value, digits) {
    var f = Math.pow(10, digits == null ? 2 : digits);
    return Math.round(value * f) / f;
  }

  // Price text uses the same rule as the cards: Indonesian grouping, and never
  // more precision than the underlying number actually carries.
  function priceText(value) {
    var n = finite(value);
    if (n == null) return '—';
    var digits = Math.abs(n - Math.round(n)) < 0.005 ? 0 : 2;
    try {
      return n.toLocaleString('id-ID', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    } catch (_) {
      return String(round(n, digits));
    }
  }

  function closeSeries(candles) {
    return (Array.isArray(candles) ? candles : [])
      .map(function (c) { return { time: c && c.time, close: finite(c && c.close), high: finite(c && c.high), low: finite(c && c.low) }; })
      .filter(function (c) { return c.close != null; });
  }

  // The window is chosen so the whole pattern stays visible with breathing room
  // on both sides, instead of cropping a fixed tail that can cut point X off.
  function windowFor(series, indices, minBars) {
    var total = series.length;
    var want = Math.max(minBars || 60, 40);
    if (!indices.length) return { from: Math.max(0, total - want), to: total };
    var lo = Math.min.apply(Math, indices);
    var hi = Math.max.apply(Math, indices);
    var pad = Math.max(6, Math.round((hi - lo) * 0.18));
    var from = Math.max(0, lo - pad);
    var to = Math.min(total, hi + pad + 1);
    if (to - from < want) {
      var deficit = want - (to - from);
      from = Math.max(0, from - Math.ceil(deficit / 2));
      to = Math.min(total, to + Math.floor(deficit / 2));
    }
    return { from: from, to: to };
  }

  function scaleFactory(box, from, to, min, max) {
    var span = Math.max(1, to - from - 1);
    var range = max - min;
    if (!(range > 0)) range = Math.max(1, Math.abs(max) * 0.02);
    return {
      x: function (index) { return round(box.left + ((index - from) / span) * box.width, 2); },
      y: function (value) { return round(box.top + (1 - (value - min) / range) * box.height, 2); },
      min: min, max: max
    };
  }

  function levelRows(candidate, direction) {
    if (!candidate) return [];
    var up = direction !== 'bearish';
    return [
      { key: 'confirmation', value: finite(candidate.confirmation), color: COLORS.confirmation, label: up ? 'Konfirmasi' : 'Konfirmasi turun' },
      { key: 'invalidation', value: finite(candidate.invalidation), color: COLORS.invalidation, label: 'Invalidasi' },
      { key: 'tp1', value: finite(candidate.tp1), color: COLORS.target, label: 'Target 1' },
      { key: 'tp2', value: finite(candidate.tp2), color: COLORS.target, label: 'Target 2' }
    ].filter(function (row) { return row.value != null; });
  }

  function przBand(candidate) {
    var low = finite(candidate && candidate.prz && candidate.prz.low);
    var high = finite(candidate && candidate.prz && candidate.prz.high);
    if (low == null || high == null) return null;
    return { low: Math.min(low, high), high: Math.max(low, high) };
  }

  function structurePoints(candidate, series) {
    if (!candidate || !candidate.points) return [];
    var byTime = Object.create(null);
    series.forEach(function (c, i) { if (c.time) byTime[c.time] = i; });
    return ['X', 'A', 'B', 'C', 'D'].map(function (name) {
      var point = candidate.points[name];
      var value = finite(point && point.value);
      if (!point || value == null) return null;
      var index = byTime[point.time];
      if (index == null && Number.isFinite(Number(point.candleIndex))) index = Number(point.candleIndex);
      if (index == null || index < 0 || index >= series.length) return null;
      return { name: name, index: index, value: value, field: point.priceField };
    }).filter(Boolean);
  }

  // Classic formations have no server geometry, so the outline is drawn from the
  // same swing pivots the card's description refers to. Nothing is invented: when
  // no pivot can be identified the outline is simply omitted.
  function classicPoints(series, type) {
    var kind = String(type || '').toUpperCase();
    var highs = swings(series, true);
    var lows = swings(series, false);
    if (kind.indexOf('DOUBLE_TOP') >= 0) return withMiddle(highs.slice(-2), lows);
    if (kind.indexOf('DOUBLE_BOTTOM') >= 0) return withMiddle(lows.slice(-2), highs);
    if (kind.indexOf('INVERSE_HEAD') >= 0 || kind.indexOf('INVERTED_HEAD') >= 0) return interleave(lows.slice(-3), highs);
    if (kind.indexOf('HEAD_AND_SHOULDERS') >= 0) return interleave(highs.slice(-3), lows);
    return [];
  }

  // Inserts the opposite-side pivot that sits between two same-side pivots, so
  // the outline traces the shape the pattern is named after.
  function between(pool, a, b) {
    var inner = pool.filter(function (p) { return p.index > a.index && p.index < b.index; });
    if (!inner.length) return null;
    return inner.reduce(function (best, p) {
      return !best || Math.abs(p.index - (a.index + b.index) / 2) < Math.abs(best.index - (a.index + b.index) / 2) ? p : best;
    }, null);
  }
  function withMiddle(pair, pool) {
    if (pair.length < 2) return pair;
    var mid = between(pool, pair[0], pair[1]);
    return mid ? [pair[0], mid, pair[1]] : pair;
  }
  function interleave(points, pool) {
    if (points.length < 2) return points;
    var out = [points[0]];
    for (var i = 1; i < points.length; i += 1) {
      var mid = between(pool, points[i - 1], points[i]);
      if (mid) out.push(mid);
      out.push(points[i]);
    }
    return out;
  }

  function swings(series, useHigh) {
    var out = [];
    for (var i = 2; i < series.length - 2; i += 1) {
      var value = useHigh ? series[i].high : series[i].low;
      if (value == null) continue;
      var ok = true;
      for (var j = 1; j <= 2; j += 1) {
        var left = useHigh ? series[i - j].high : series[i - j].low;
        var right = useHigh ? series[i + j].high : series[i + j].low;
        if (left == null || right == null) { ok = false; break; }
        if (useHigh ? (value < left || value < right) : (value > left || value > right)) { ok = false; break; }
      }
      if (ok) out.push({ name: '', index: i, value: value });
    }
    return out;
  }

  // Simple one-pass spreader: sort by y, then push each label down until it
  // clears the previous one. Anything forced past the bottom of the plot is
  // dropped rather than drawn over the axis.
  var LABEL_GAP = 10.5;
  function placeGutterLabels(labels, top, bottom) {
    var sorted = labels.slice().sort(function (a, b) { return a.y - b.y || a.priority - b.priority; });
    var placed = [];
    var cursor = top;
    sorted.forEach(function (label) {
      var y = Math.max(label.y, cursor);
      if (y > bottom) return;
      placed.push({ y: y, text: label.text, color: label.color, weight: label.weight });
      cursor = y + LABEL_GAP;
    });
    return placed;
  }

  function pathFrom(series, scale, from, to) {
    var d = '';
    for (var i = from; i < to; i += 1) {
      d += (d ? 'L' : 'M') + scale.x(i) + ' ' + scale.y(series[i].close);
    }
    return d;
  }

  /**
   * Builds a complete, self-contained SVG for one Pattern row.
   * Returns '' when the row carries too little data to draw honestly.
   */
  function buildPatternSvg(row, options) {
    options = options || {};
    var width = Math.max(280, Math.round(options.width || 640));
    var height = Math.max(160, Math.round(options.height || 260));
    var candidate = row && row.candidate;
    var series = closeSeries(row && row.context && row.context.candles);
    // Five is the same floor PatternMap.validateCandidate enforces on a bound
    // candidate, so anything the renderer is allowed to trust can be drawn.
    if (series.length < 5) return '';

    var primary = (row.classicPatterns && row.classicPatterns[0]) || {};
    var name = (candidate && candidate.name) || primary.label || 'Chart pattern';
    var direction = String((candidate && candidate.name) || primary.bias || '').toLowerCase().indexOf('bear') >= 0 ? 'bearish' : 'bullish';

    var points = candidate ? structurePoints(candidate, series) : classicPoints(series, primary.type);
    var win = windowFor(series, points.map(function (p) { return p.index; }), options.minBars || 70);
    var visible = series.slice(win.from, win.to);
    if (visible.length < 5) return '';

    var levels = levelRows(candidate, direction);
    var band = przBand(candidate);
    var current = finite(candidate && candidate.currentPrice);
    if (current == null) current = series[series.length - 1].close;

    var values = visible.map(function (c) { return c.close; });
    levels.forEach(function (l) { values.push(l.value); });
    if (band) { values.push(band.low, band.high); }
    points.forEach(function (p) { values.push(p.value); });
    if (current != null) values.push(current);

    var min = Math.min.apply(Math, values);
    var max = Math.max.apply(Math, values);
    var pad = (max - min) * 0.08 || Math.max(1, Math.abs(max) * 0.02);
    min -= pad; max += pad;

    // The right-hand gutter holds every level name, so it is sized from the
    // longest label rather than a fixed fraction of the width.
    var labelChars = levels.reduce(function (longest, level) { return Math.max(longest, level.label.length); }, 4);
    var gutter = Math.min(Math.round(width * 0.34), Math.max(56, Math.round(labelChars * 5.1) + 12));
    var box = { left: 10, top: 14, width: width - gutter - 14, height: height - 34 };
    var scale = scaleFactory(box, win.from, win.to, min, max);

    var parts = [];
    var gutterLabels = [];
    // Sizing is left to CSS (.ps-figure svg { width:100%; height:auto }). An SVG
    // `height="auto"` attribute is not a valid length and Chrome reports it as a
    // console error on every card.
    parts.push('<svg xmlns="' + NS + '" viewBox="0 0 ' + width + ' ' + height + '"' +
      ' class="pv-svg" role="img"' +
      ' aria-label="' + esc(name + ' pada ' + (row.ticker || '') + ', data T-1 ' + (row.dataDate || '')) + '">');
    parts.push('<title>' + esc(name + ' · ' + (row.ticker || '')) + '</title>');

    // Horizontal guides at the extremes, so the vertical scale is readable.
    [min + pad, max - pad].forEach(function (value) {
      var y = scale.y(value);
      parts.push('<line x1="' + box.left + '" y1="' + y + '" x2="' + (box.left + box.width) + '" y2="' + y +
        '" stroke="' + COLORS.grid + '" stroke-width="1"/>');
      gutterLabels.push({ y: y, text: priceText(value), color: COLORS.axis, weight: '400', priority: 3 });
    });

    // PRZ band: the zone D was expected to complete in.
    if (band) {
      var yHigh = scale.y(band.high);
      var yLow = scale.y(band.low);
      parts.push('<rect x="' + box.left + '" y="' + Math.min(yHigh, yLow) + '" width="' + box.width +
        '" height="' + Math.max(1.5, Math.abs(yLow - yHigh)) + '" fill="' + COLORS.prz + '" fill-opacity="0.10"/>');
      gutterLabels.push({ y: (yHigh + yLow) / 2, text: 'PRZ', color: COLORS.prz, weight: '700', priority: 2 });
    }

    // Close-price line for the visible window.
    var d = pathFrom(series, scale, win.from, win.to);
    if (d) {
      parts.push('<path d="' + d + 'L' + scale.x(win.to - 1) + ' ' + (box.top + box.height) + 'L' + scale.x(win.from) + ' ' +
        (box.top + box.height) + 'Z" fill="' + COLORS.priceFill + '"/>');
      parts.push('<path d="' + d + '" fill="none" stroke="' + COLORS.price + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>');
    }

    // Level lines, drawn dashed so they never read as price history.
    levels.forEach(function (level) {
      var y = scale.y(level.value);
      if (y < box.top - 2 || y > box.top + box.height + 2) return;
      parts.push('<line x1="' + box.left + '" y1="' + y + '" x2="' + (box.left + box.width) + '" y2="' + y +
        '" stroke="' + level.color + '" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.85"/>');
      gutterLabels.push({ y: y, text: level.label, color: level.color, weight: '700', priority: 1 });
    });

    // Pattern outline.
    if (points.length >= 2) {
      var poly = points.map(function (p) { return scale.x(p.index) + ',' + scale.y(p.value); }).join(' ');
      parts.push('<polyline points="' + poly + '" fill="none" stroke="' + COLORS.structure +
        '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
      points.forEach(function (p) {
        var x = scale.x(p.index);
        var y = scale.y(p.value);
        parts.push('<circle cx="' + x + '" cy="' + y + '" r="3.4" fill="#0b1220" stroke="' + COLORS.structure + '" stroke-width="2"/>');
        if (p.name) {
          var above = p.field === 'high';
          parts.push('<text x="' + x + '" y="' + (above ? y - 8 : y + 15) + '" fill="' + COLORS.structure +
            '" font-size="10" font-weight="800" text-anchor="middle" font-family="inherit">' + esc(p.name) + '</text>');
        }
      });
    }

    // Where price actually is now, relative to all of the above.
    if (current != null) {
      var cy = scale.y(current);
      parts.push('<line x1="' + box.left + '" y1="' + cy + '" x2="' + (box.left + box.width) + '" y2="' + cy +
        '" stroke="' + COLORS.current + '" stroke-width="1" opacity="0.55"/>');
      parts.push('<circle cx="' + scale.x(win.to - 1) + '" cy="' + cy + '" r="3" fill="' + COLORS.current + '"/>');
      gutterLabels.push({ y: cy, text: 'Kini', color: COLORS.current, weight: '800', priority: 0 });
    }

    // Levels that sit close together produce labels that sit on top of each
    // other. Spread them apart, keeping the more important ones nearest to the
    // line they name, and drop any that no longer fit in the plot height.
    placeGutterLabels(gutterLabels, box.top, box.top + box.height).forEach(function (label) {
      parts.push('<text x="' + (box.left + box.width + 5) + '" y="' + round(label.y + 3.2, 2) + '" fill="' + label.color +
        '" font-size="9.5" font-weight="' + label.weight + '" font-family="inherit">' + esc(label.text) + '</text>');
    });

    parts.push('</svg>');
    return parts.join('');
  }

  return {
    version: VERSION,
    buildPatternSvg: buildPatternSvg,
    priceText: priceText,
    __test: {
      windowFor: windowFor,
      placeGutterLabels: placeGutterLabels,
      closeSeries: closeSeries,
      structurePoints: structurePoints,
      classicPoints: classicPoints,
      swings: swings,
      levelRows: levelRows,
      przBand: przBand
    }
  };
});
