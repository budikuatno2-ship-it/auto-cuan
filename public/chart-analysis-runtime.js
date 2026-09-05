// Auto-Cuan Chart Analysis (AI Vision BYOK) Client Runtime
(function (root) {
  'use strict';

  var API_ENDPOINT = '/api/analyze?surface=chart-analysis';

  function escapeHtml(text) {
    return String(text || '').replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }

  function formatAnalysisText(rawText) {
    if (!rawText) return '<p class="text-gray-400">Tidak ada hasil analisis.</p>';
    var lines = String(rawText).split('\n');
    var html = '';
    var inSection = false;

    lines.forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) {
        if (inSection) html += '</div>';
        inSection = false;
        return;
      }
      if (trimmed.startsWith('## ')) {
        if (inSection) html += '</div>';
        var title = trimmed.replace(/^##\s*/, '');
        var icon = '📌';
        if (/tren/i.test(title)) icon = '📈';
        else if (/level/i.test(title)) icon = '🎯';
        else if (/pola|candle/i.test(title)) icon = '🕯️';
        else if (/volume/i.test(title)) icon = '📊';
        else if (/risiko/i.test(title)) icon = '⚠️';

        html += '<div style="margin-top:12px;margin-bottom:8px;padding:10px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px">';
        html += '<div style="font-weight:700;font-size:12px;color:#93c5fd;margin-bottom:4px">' + icon + ' ' + escapeHtml(title) + '</div>';
        inSection = true;
      } else {
        if (!inSection) {
          html += '<div style="font-size:11px;color:#d1d5db;line-height:1.6;margin-bottom:6px">' + escapeHtml(trimmed) + '</div>';
        } else {
          html += '<div style="font-size:11px;color:#d1d5db;line-height:1.6">' + escapeHtml(trimmed) + '</div>';
        }
      }
    });
    if (inSection) html += '</div>';
    return html;
  }

  root.openAiApiKeyModal = function () {
    var modal = document.getElementById('aiApiKeyModal');
    if (modal) {
      modal.classList.remove('hidden');
      var statusEl = document.getElementById('aiApiKeyStatusText');
      if (statusEl) statusEl.textContent = 'Memeriksa status API key...';
      fetch(API_ENDPOINT + '&action=status', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var input = document.getElementById('aiApiKeyInput');
          if (data && data.hasKey) {
            if (statusEl) statusEl.innerHTML = 'Status: <span style="color:#6ee7b7;font-weight:600">Terpasang</span> (' + escapeHtml(data.maskedKey) + ') · Sisa kuota: <strong>' + escapeHtml(data.remainingQuota) + '</strong> hari ini.';
            if (input) input.placeholder = 'Ganti key terpasang (' + escapeHtml(data.maskedKey) + ')';
            var btnDel = document.getElementById('btnDeleteAiApiKey');
            if (btnDel) btnDel.style.display = 'inline-block';
          } else {
            if (statusEl) statusEl.innerHTML = 'Status: <span style="color:#fbbf24;font-weight:600">Belum diisi</span>. Dapatkan gratis di <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" style="color:#60a5fa;text-decoration:underline">Google AI Studio</a>.';
            if (input) input.placeholder = 'Tempel Google Gemini API key di sini (AIza... atau AQ...)';
            var btnDel2 = document.getElementById('btnDeleteAiApiKey');
            if (btnDel2) btnDel2.style.display = 'none';
          }
        })
        .catch(function () {
          if (statusEl) statusEl.textContent = 'Gagal memuat status key.';
        });
    }
  };

  root.closeAiApiKeyModal = function () {
    var modal = document.getElementById('aiApiKeyModal');
    if (modal) modal.classList.add('hidden');
  };

  root.saveUserAiApiKey = function () {
    var input = document.getElementById('aiApiKeyInput');
    var rawKey = input ? input.value.trim() : '';
    if (!rawKey) {
      if (typeof showToast === 'function') showToast('Masukkan API key terlebih dahulu.', 'warning');
      else alert('Masukkan API key terlebih dahulu.');
      return;
    }

    var btn = document.getElementById('btnSaveAiApiKey');
    if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }

    fetch(API_ENDPOINT + '&action=set-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ apiKey: rawKey })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (btn) { btn.disabled = false; btn.textContent = 'Simpan Key'; }
        if (data && data.success) {
          if (input) input.value = '';
          if (typeof showToast === 'function') showToast('API key berhasil disimpan terenkripsi.', 'good');
          root.openAiApiKeyModal(); // Refresh view
        } else {
          if (typeof showToast === 'function') showToast(data.error || 'Gagal menyimpan API key.', 'danger');
          else alert(data.error || 'Gagal menyimpan API key.');
        }
      })
      .catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Simpan Key'; }
        if (typeof showToast === 'function') showToast('Gagal menghubungi server.', 'danger');
      });
  };

  root.deleteUserAiApiKey = function () {
    if (!confirm('Apakah Anda yakin ingin menghapus API key Gemini tersimpan?')) return;
    fetch(API_ENDPOINT + '&action=delete-key', {
      method: 'POST',
      credentials: 'same-origin'
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.success) {
          if (typeof showToast === 'function') showToast('API key berhasil dihapus.', 'good');
          root.openAiApiKeyModal();
        } else {
          if (typeof showToast === 'function') showToast('Gagal menghapus API key.', 'danger');
        }
      })
      .catch(function () {
        if (typeof showToast === 'function') showToast('Gagal menghubungi server.', 'danger');
      });
  };

  root.triggerAiChartAnalysis = function (ticker) {
    if (!ticker) {
      var input = document.getElementById('chartTickerInput') || document.getElementById('analisisInput');
      ticker = input ? (input.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    }
    if (!ticker && root.UnifiedCockpit && typeof root.UnifiedCockpit.getActiveTicker === 'function') {
      ticker = root.UnifiedCockpit.getActiveTicker();
    }
    if (!ticker && root._chartPageData && root._chartPageData.ticker) {
      ticker = root._chartPageData.ticker;
    }
    if (!ticker) {
      if (typeof showToast === 'function') showToast('Ketik ticker chart terlebih dahulu (misal: BBCA, BBRI).', 'warning');
      else alert('Ketik ticker chart terlebih dahulu (misal: BBCA, BBRI).');
      return;
    }

    var pageAnalisis = document.getElementById('page-analisis');
    var isAnalisisPage = pageAnalisis && !pageAnalisis.classList.contains('hidden');
    var wrap = isAnalisisPage
      ? (document.getElementById('unifiedAiChartResultWrap') || document.getElementById('aiChartAnalysisResultWrap'))
      : (document.getElementById('aiChartAnalysisResultWrap') || document.getElementById('unifiedAiChartResultWrap'));
    if (!wrap) return;

    if (isAnalisisPage && root.UnifiedCockpit && typeof root.UnifiedCockpit.switchAnalysisSubTab === 'function') {
      root.UnifiedCockpit.switchAnalysisSubTab('vision');
    }

    wrap.style.display = 'block';
    if (typeof wrap.scrollIntoView === 'function') {
      try { wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
    }

    wrap.innerHTML = '<div style="padding:14px;background:rgba(15,23,42,0.6);border:1px solid rgba(59,130,246,0.25);border-radius:12px;text-align:center">' +
      '<div style="font-size:12px;color:#93c5fd;font-weight:600;margin-bottom:6px">Memeriksa konfigurasi AI...</div>' +
      '<div style="font-size:11px;color:#9ca3af">Menyiapkan chart dan kredensial BYOK.</div>' +
      '</div>';

    fetch(API_ENDPOINT + '&action=status&ticker=' + encodeURIComponent(ticker), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (statusData) {
        if (!statusData || !statusData.hasKey) {
          wrap.innerHTML = '<div style="padding:14px;background:rgba(234,179,8,0.06);border:1px solid rgba(234,179,8,0.25);border-radius:12px">' +
            '<div style="color:#fde047;font-weight:700;font-size:12px;margin-bottom:4px">🔑 API Key Gemini Belum Diisi</div>' +
            '<div style="font-size:11px;color:#d1d5db;line-height:1.5;margin-bottom:10px">Fitur Analisis Chart AI menggunakan API key pribadi Anda (Bring Your Own Key) agar Anda bisa menikmati analisis visual tanpa biaya platform.</div>' +
            '<button type="button" onclick="openAiApiKeyModal()" style="padding:8px 14px;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;font-size:11px;border:none;cursor:pointer">Isi API Key Gemini Sekarang</button>' +
            '</div>';
          return;
        }

        // Key is available, start analysis
        wrap.innerHTML = '<div style="padding:16px;background:rgba(15,23,42,0.6);border:1px solid rgba(59,130,246,0.3);border-radius:12px;text-align:center">' +
          '<div style="font-size:13px;color:#60a5fa;font-weight:700;margin-bottom:6px">🤖 Menghubungi AI Vision & Membaca Pola Chart ' + escapeHtml(ticker) + '...</div>' +
          '<div style="font-size:11px;color:#9ca3af;margin-bottom:4px">Merender chart candlestick, indikator MA/RSI, dan memanggil Google Gemini.</div>' +
          '<div style="font-size:10px;color:#6b7280">Proses biasanya memakan waktu 3–8 detik.</div>' +
          '</div>';

        return fetch(API_ENDPOINT + '&action=analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ ticker: ticker })
        })
          .then(function (res) { return res.json(); })
          .then(function (result) {
            if (!result || !result.success) {
              var errTitle = '⚠️ Analisis Belum Berhasil';
              var errMsg = result ? result.error : 'Terjadi kesalahan tidak terduga.';
              if (result && result.code === 'QUOTA_EXCEEDED') errTitle = '⏳ Batas Kuota Harian Tercapai';
              wrap.innerHTML = '<div style="padding:14px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.25);border-radius:12px">' +
                '<div style="color:#fca5a5;font-weight:700;font-size:12px;margin-bottom:4px">' + errTitle + '</div>' +
                '<div style="font-size:11px;color:#d1d5db;line-height:1.5">' + escapeHtml(errMsg) + '</div>' +
                '</div>';
              return;
            }

            var analysisData = result.data || {};
            var quota = result.quota || {};
            var quotaText = quota.remaining != null ? ('Sisa ' + quota.remaining + ' dari ' + quota.maxDaily + ' analisis hari ini (reset 00:00 WIB)') : 'Kuota: Unlimited';

            var cardHtml = '<div style="margin-top:8px;padding:16px;background:#111827;border:1px solid #1f2937;border-radius:14px;box-shadow:0 10px 25px rgba(0,0,0,0.5)">';
            cardHtml += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.08)">';
            cardHtml += '<div><span style="font-size:13px;font-weight:800;color:#fff;display:flex;align-items:center;gap:6px"><span>🤖</span> Analisis Chart (AI) — ' + escapeHtml(ticker) + '</span><span style="font-size:10px;color:#94a3b8">Model: ' + escapeHtml(analysisData.model || 'Gemini 3 Flash') + (result.cached ? ' · (Cache Hari Ini)' : '') + '</span></div>';
            cardHtml += '<span style="font-size:10px;padding:3px 8px;border-radius:6px;background:rgba(16,185,129,0.1);color:#6ee7b7;font-weight:600">' + escapeHtml(quotaText) + '</span>';
            cardHtml += '</div>';

            cardHtml += formatAnalysisText(analysisData.analysisText);

            cardHtml += '<div style="margin-top:14px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);font-size:10px;color:#6b7280;line-height:1.4">';
            cardHtml += '🛡️ <em>Hasil analisis di atas merupakan pembacaan visual AI menggunakan API key pribadi Anda, bukan bagian dari sinyal resmi screener Auto-Cuan. Bukan rekomendasi beli/jual. Konfirmasi manual wajib.</em>';
            cardHtml += '</div>';
            cardHtml += '</div>';

            wrap.innerHTML = cardHtml;
          });
      })
      .catch(function (err) {
        wrap.innerHTML = '<div style="padding:14px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.25);border-radius:12px">' +
          '<div style="color:#fca5a5;font-weight:700;font-size:12px;margin-bottom:4px">⚠️ Gagal Memuat Analisis</div>' +
          '<div style="font-size:11px;color:#d1d5db">Terjadi kendala jaringan saat menghubungi server. Silakan coba lagi.</div>' +
          '</div>';
      });
  };
})(typeof window !== 'undefined' ? window : globalThis);
