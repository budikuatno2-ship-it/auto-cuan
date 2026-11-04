(function (root) {
  var EMPTY = "";
  function esc(v) {
    var s = String(v == null ? EMPTY : v);
    var A = String.fromCharCode(38);
    var SC = String.fromCharCode(59);
    var o = EMPTY;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === A) { o = o + A + "amp" + SC; }
      else {
        if (c === "<") { o = o + A + "lt" + SC; }
        else {
          if (c === ">") { o = o + A + "gt" + SC; }
          else { o = o + c; }
        }
      }
    }
    return o;
  }
  function fmtRp(num) {
    var n = Number(num);
    if (!Number.isFinite(n)) return "Rp 0";
    if (n <= 0) return "Rp 0";
    if (n >= 1e12) return "Rp " + (n / 1e12).toFixed(2) + " T";
    if (n >= 1e9) return "Rp " + (n / 1e9).toFixed(2) + " M";
    if (n >= 1e6) return "Rp " + (n / 1e6).toFixed(1) + " Jt";
    return "Rp " + Math.round(n);
  }
  function badgeFor(liq) {
    if (!liq) return { text: "-", cls: "b3-liq--unknown", title: "Profil likuiditas belum tersedia" };
    if (liq.tier === "LIKUID") return { text: "Likuid", cls: "b3-liq--likuid", title: liq.tooltip };
    if (liq.tier === "NON_LIKUID") return { text: "Non-Likuid", cls: "b3-liq--nonlikuid", title: liq.tooltip };
    return { text: "Tidak Lolos", cls: "b3-liq--reject", title: liq.tooltip };
  }
  function badgeHtml(liq) {
    var b = badgeFor(liq);
    var q = String.fromCharCode(34);
    return "<span class=" + q + "b3-liq " + b.cls + q + " title=" + q + esc(b.title) + q + ">" + esc(b.text) + "</span>";
  }
  function screenerCellHtml(liq) { return badgeHtml(liq); }
  function headerHtml(ticker, liq) {
    var q = String.fromCharCode(34);
    return "<span class=" + q + "b3-liq-head" + q + ">" + badgeHtml(liq) + "</span>";
  }
  root.B3LiquidityBadge = { badgeFor: badgeFor, badgeHtml: badgeHtml, screenerCellHtml: screenerCellHtml, headerHtml: headerHtml, fmtRp: fmtRp };
  if (typeof module === "object") { if (module.exports) { module.exports = root.B3LiquidityBadge; } }
})(typeof window !== "undefined" ? window : globalThis);
