(function (root) {
  'use strict';

  var parts = [
    '/core-parts/portfolio-v1-core.part1.txt?v=1',
    '/core-parts/portfolio-v1-core.part2.txt?v=1',
    '/core-parts/portfolio-v1-core.part3.txt?v=1',
    '/core-parts/portfolio-v1-core.part4.txt?v=1',
    '/core-parts/portfolio-v1-core.part5.txt?v=1',
    '/runtime-parts/portfolio-v1-runtime.part1.txt?v=1',
    '/runtime-parts/portfolio-v1-runtime.part2.txt?v=1',
    '/runtime-parts/portfolio-v1-runtime.part3.txt?v=1',
    '/runtime-parts/portfolio-v1-runtime.part4.txt?v=1',
    '/runtime-parts/portfolio-v1-runtime.part5.txt?v=1',
    '/runtime-parts/portfolio-v1-runtime.part6.txt?v=1',
    '/runtime-parts/portfolio-v1-runtime.part7.txt?v=1',
    '/runtime-parts/portfolio-v1-runtime.part8.txt?v=1',
    '/runtime-parts/portfolio-v1-runtime.part9.txt?v=1',
    '/runtime-parts/portfolio-v1-runtime.part10.txt?v=1'
  ];

  function enhancementSource() {
    return '(' + function (win) {
      'use strict';
      var doc = win.document;
      var api = win.AutoCuanPortfolioV1;
      if (!doc || !api) return;

      function money(value) {
        if (value == null || !Number.isFinite(Number(value))) return '—';
        var amount = Math.round(Number(value));
        return (amount < 0 ? '-Rp ' : 'Rp ') + Math.abs(amount).toLocaleString('id-ID');
      }

      function percent(value) {
        return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2) + '%';
      }

      function toast(message, type) {
        if (typeof win.showToast === 'function') win.showToast(message, type || 'success');
        else win.alert(message);
      }

      function currentPositions() {
        return typeof win.loadPortfolio === 'function' ? win.loadPortfolio() : [];
      }

      function profileLabel(profile) {
        return profile === 'rendah' ? 'Rendah' : (profile === 'tinggi' ? 'Tinggi' : 'Sedang');
      }

      function ensureExplanationBox() {
        var result = doc.getElementById('pfCalcResult');
        if (!result) return null;
        var box = doc.getElementById('pfCalcExplain');
        if (!box) {
          box = doc.createElement('div');
          box.id = 'pfCalcExplain';
          box.className = 'hidden rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 text-sm text-gray-300 space-y-2';
          result.insertAdjacentElement('afterend', box);
        }
        return box;
      }

      function renderCalculatorExplanation() {
        var box = ensureExplanationBox();
        if (!box) return;
        var result = api.calculatePositionSize({
          ticker: (doc.getElementById('pfTicker') || {}).value,
          budget: (doc.getElementById('pfBudget') || {}).value,
          buyPrice: (doc.getElementById('pfBuy') || {}).value,
          stop: (doc.getElementById('pfStop') || {}).value,
          target: (doc.getElementById('pfTarget') || {}).value,
          profile: (doc.getElementById('pfRisk') || {}).value
        });
        if (!result.ok) { box.classList.add('hidden'); return; }

        var riskIsTighter = result.riskLimitedLots <= result.affordableLots;
        var reason = riskIsTighter
          ? 'Budget Anda cukup untuk ' + result.affordableLots + ' lot, tetapi profil Risiko ' + profileLabel(result.profile) + ' (' + percent(result.riskRate * 100) + ') membatasi kerugian maksimal menjadi ' + money(result.riskAmount) + '. Jarak harga beli ke stop menyebabkan rugi ' + money(result.lossPerLot) + ' per lot, sehingga batas risiko menjadi ' + result.riskLimitedLots + ' lot. Sistem memilih batas yang lebih kecil: ' + result.suggestedLots + ' lot.'
          : 'Profil Risiko ' + profileLabel(result.profile) + ' masih mengizinkan sampai ' + result.riskLimitedLots + ' lot, tetapi budget hanya cukup untuk ' + result.affordableLots + ' lot. Sistem selalu mengambil batas yang lebih kecil, sehingga saran akhirnya ' + result.suggestedLots + ' lot.';

        var warning = '';
        if (result.target && result.riskReward > 10) {
          warning = '<p class="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-amber-200"><strong>Periksa kembali target.</strong> Risk/reward ' + result.riskReward.toFixed(2) + 'x sangat tinggi. Pastikan target bukan salah ketik dan tetap realistis menurut analisis Anda.</p>';
        }
        box.innerHTML = '<p class="font-semibold text-blue-200">Mengapa ' + result.suggestedLots + ' lot?</p><p>' + api.escapeHtml(reason) + '</p>' + warning + '<p class="text-xs text-gray-500">Perhitungan ini memakai rumus tetap dari input Anda, bukan AI dan bukan rekomendasi transaksi.</p>';
        box.classList.remove('hidden');
      }

      function statusExplanation(status) {
        var map = {
          'Harga belum tersedia': 'Harga terakhir belum berhasil diperoleh. Posisi tetap ditampilkan, tetapi nilai berjalan dan P/L belum dapat dihitung.',
          'Di atas harga rata-rata': 'Harga terakhir berada di atas average buy, sehingga posisi sedang mencatat unrealized profit.',
          'Di bawah harga rata-rata': 'Harga terakhir berada di bawah average buy, sehingga posisi sedang mencatat unrealized loss.',
          'Mendekati target': 'Harga terakhir sudah berada dekat target yang Anda masukkan. Sistem hanya memberi tanda, tidak menjual otomatis.',
          'Mendekati stop loss': 'Jarak harga terakhir ke batas invalidasi semakin kecil. Periksa risiko dan keputusan Anda secara manual.',
          'Stop loss terlewati': 'Harga terakhir sama dengan atau di bawah batas invalidasi yang Anda masukkan. Average down tidak disarankan.'
        };
        return map[status] || 'Status dihitung secara deterministik dari harga terakhir, average buy, target, dan stop yang Anda masukkan.';
      }

      function openAverageUp(card, index) {
        var position = currentPositions()[index];
        var addButton = card && card.querySelector('button[data-action="add"]');
        if (!position || !addButton) return;
        addButton.click();
        win.setTimeout(function () {
          var title = doc.getElementById('pfModalTitle');
          var body = doc.getElementById('pfModalBody');
          var confirm = doc.getElementById('pfModalConfirm');
          var lotsInput = doc.getElementById('pfAddLots');
          var priceInput = doc.getElementById('pfAddPrice');
          var preview = doc.getElementById('pfAddPreview');
          if (!title || !body || !confirm || !lotsInput || !priceInput || !preview) return;

          title.textContent = 'Average Up ' + position.ticker;
          body.insertAdjacentHTML('afterbegin', '<p class="text-sm text-gray-300">Average up berarti menambah posisi pada harga di atas average buy. Average buy, modal, dan risiko posisi akan meningkat. Ini perhitungan matematika, bukan rekomendasi membeli.</p><div class="rounded-lg border border-dark-600/40 p-3 text-sm text-gray-300">Average saat ini: <strong>' + money(position.averageBuy) + '</strong> · Posisi: <strong>' + position.lots + ' lot</strong></div>');

          var originalConfirm = confirm.onclick;
          function updatePreview() {
            var lots = api.positiveInteger(lotsInput.value, api.MAX_LOTS);
            var price = api.finitePositive(priceInput.value, api.MAX_PRICE);
            if (!lots || !price) { preview.innerHTML = '<p class="text-gray-500">Isi lot dan harga tambahan.</p>'; return false; }
            if (price <= position.averageBuy) {
              preview.innerHTML = '<p class="text-red-300">Harga Average Up harus di atas average buy saat ini.</p>';
              return false;
            }
            var avg = api.weightedAverage(position.averageBuy, position.lots, price, lots);
            var totalLots = position.lots + lots;
            var additionalCapital = price * lots * api.LOT_SIZE;
            var estimatedLoss = Math.max(0, (avg - position.stop) * totalLots * api.LOT_SIZE);
            preview.innerHTML = '<p>Avg lama: <strong>' + money(position.averageBuy) + '</strong> → Avg baru: <strong>' + money(avg) + '</strong></p><p>Total posisi: <strong>' + totalLots + ' lot</strong> · Modal tambahan: <strong>' + money(additionalCapital) + '</strong></p><p>Estimasi risiko ke stop: <strong>' + money(estimatedLoss) + '</strong></p>';
            return true;
          }
          lotsInput.addEventListener('input', updatePreview);
          priceInput.addEventListener('input', updatePreview);
          confirm.onclick = function () {
            if (!updatePreview()) { toast('Harga Average Up harus di atas average buy dan input harus valid.', 'error'); return; }
            if (typeof originalConfirm === 'function') originalConfirm();
          };
          updatePreview();
        }, 0);
      }

      function enhanceExitModal(card, index) {
        var position = currentPositions()[index];
        if (!position) return;
        win.setTimeout(function () {
          var title = doc.getElementById('pfModalTitle');
          var body = doc.getElementById('pfModalBody');
          var lotsInput = doc.getElementById('pfSellLots');
          var priceInput = doc.getElementById('pfSellPrice');
          if (!title || !body || !lotsInput || !priceInput) return;

          title.textContent = 'Cut Loss / Take Profit ' + position.ticker;
          body.insertAdjacentHTML('afterbegin', '<p class="text-sm text-gray-300">Harga jual di bawah average buy akan tercatat sebagai <strong class="text-red-300">Cut Loss</strong>. Harga jual di atas average buy akan tercatat sebagai <strong class="text-emerald-300">Take Profit</strong>. Sistem hanya mencatat; tidak ada transaksi otomatis ke broker.</p><div class="rounded-lg border border-dark-600/40 p-3 text-sm text-gray-300">Average buy: <strong>' + money(position.averageBuy) + '</strong> · Tersedia: <strong>' + position.lots + ' lot</strong></div>');

          var preview = doc.createElement('div');
          preview.className = 'rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-sm text-gray-300';
          body.appendChild(preview);
          function updatePreview() {
            var sale = api.calculatePartialSale(position, lotsInput.value, priceInput.value);
            if (!sale.ok) { preview.innerHTML = '<p class="text-red-300">' + api.escapeHtml(sale.error) + '</p>'; return; }
            var action = sale.realizedPL < 0 ? 'Cut Loss' : (sale.realizedPL > 0 ? 'Take Profit' : 'Impas');
            var tone = sale.realizedPL < 0 ? 'text-red-300' : (sale.realizedPL > 0 ? 'text-emerald-300' : 'text-gray-300');
            preview.innerHTML = '<p>Jenis pencatatan: <strong class="' + tone + '">' + action + '</strong></p><p>Realized P/L: <strong class="' + tone + '">' + money(sale.realizedPL) + '</strong></p><p>Sisa posisi: <strong>' + sale.remainingLots + ' lot</strong>. Average buy sisa posisi tetap <strong>' + money(sale.remainingAverage) + '</strong>.</p><p class="text-xs text-gray-500">Rumus: (harga jual − average buy) × lot dijual × 100 saham.</p>';
          }
          lotsInput.addEventListener('input', updatePreview);
          priceInput.addEventListener('input', updatePreview);
          updatePreview();
        }, 0);
      }

      function decorateCards() {
        var container = doc.getElementById('pfPositions');
        if (!container) return;
        Array.prototype.forEach.call(container.querySelectorAll('article[data-index]'), function (card) {
          var statusEl = card.querySelector('h4 + p');
          var status = statusEl ? statusEl.textContent.trim() : '';
          var averageDown = card.querySelector('button[data-action="average"]');
          if (averageDown) averageDown.textContent = 'Average Down';
          var sell = card.querySelector('button[data-action="sell"]');
          if (sell) sell.textContent = 'Cut Loss / Take Profit';
          var close = card.querySelector('button[data-action="close"]');
          if (close) close.textContent = 'Tutup Semua';
          var addButton = card.querySelector('button[data-action="add"]');
          var actionRow = addButton ? addButton.parentElement : null;
          if (actionRow && !actionRow.querySelector('[data-pf-action="average-up"]')) {
            var up = doc.createElement('button');
            up.type = 'button';
            up.className = 'pf-action';
            up.setAttribute('data-pf-action', 'average-up');
            up.textContent = 'Average Up';
            actionRow.insertBefore(up, sell || close || null);
          }
          if (!card.querySelector('[data-pf-explanation]')) {
            var detail = doc.createElement('details');
            detail.setAttribute('data-pf-explanation', 'true');
            detail.className = 'mt-3 rounded-lg border border-dark-600/40 bg-dark-800/30 p-3';
            detail.innerHTML = '<summary class="cursor-pointer text-xs font-semibold text-blue-300">Apa arti status dan angka ini?</summary><p class="mt-2 text-xs leading-relaxed text-gray-400">' + api.escapeHtml(statusExplanation(status)) + '</p><p class="mt-2 text-[11px] text-gray-500">Semua status dan perhitungan menggunakan rumus tetap dari data posisi Anda, bukan AI.</p>';
            if (actionRow) actionRow.insertAdjacentElement('beforebegin', detail);
            else card.appendChild(detail);
          }
        });
      }

      function init(attempt) {
        var calculate = doc.getElementById('pfCalculate');
        var positions = doc.getElementById('pfPositions');
        if (!calculate || !positions) {
          if ((attempt || 0) < 30) win.setTimeout(function () { init((attempt || 0) + 1); }, 100);
          return;
        }

        if (!calculate.hasAttribute('data-pf-explain-bound')) {
          calculate.setAttribute('data-pf-explain-bound', 'true');
          calculate.addEventListener('click', function () { win.setTimeout(renderCalculatorExplanation, 0); });
        }

        if (!positions.hasAttribute('data-pf-actions-bound')) {
          positions.setAttribute('data-pf-actions-bound', 'true');
          positions.addEventListener('click', function (event) {
            var custom = event.target.closest('button[data-pf-action="average-up"]');
            var card = event.target.closest('article[data-index]');
            var index = Number(card && card.getAttribute('data-index'));
            if (custom && Number.isInteger(index)) {
              event.preventDefault();
              openAverageUp(card, index);
              return;
            }
            var sell = event.target.closest('button[data-action="sell"]');
            if (sell && Number.isInteger(index)) enhanceExitModal(card, index);
          });
        }

        if (typeof win.MutationObserver === 'function') {
          var observer = new win.MutationObserver(function () { decorateCards(); });
          observer.observe(positions, { childList: true });
        }

        ensureExplanationBox();
        decorateCards();
      }

      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { init(0); }, { once: true });
      else init(0);
    }.toString() + ')(window);';
  }

  function finalPortfolioSource() {
    return '(' + function (win) {
      'use strict';
      var doc = win.document;
      var api = null;
      var compareBusy = false;
      var restoreBusy = false;
      var MAX_TICKERS = 20;
      var QUOTE_CONCURRENCY = 4;
      var MAX_BACKUP_BYTES = 1024 * 1024;

      function toast(message, type) {
        if (typeof win.showToast === 'function') win.showToast(message, type || 'success');
        else win.alert(message);
      }

      function money(value) {
        if (value == null || !Number.isFinite(Number(value))) return '—';
        var rounded = Math.round(Number(value));
        return (rounded < 0 ? '-Rp ' : 'Rp ') + Math.abs(rounded).toLocaleString('id-ID');
      }

      function positiveNumber(value, max) {
        var n = Number(value);
        return Number.isFinite(n) && n > 0 && n <= (max || Number.MAX_SAFE_INTEGER) ? n : null;
      }

      function currentPortfolioKey() {
        return typeof win.getPortfolioKey === 'function' ? win.getPortfolioKey() : null;
      }

      function currentJournalKey() {
        var key = currentPortfolioKey();
        return key ? key + '_journal_v1' : null;
      }

      function parsePortfolio(raw) {
        if (api && typeof api.parseStoredState === 'function') return api.parseStoredState(typeof raw === 'string' ? raw : JSON.stringify(raw || {}));
        try {
          var parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
          return {
            version: 1,
            positions: Array.isArray(parsed.positions) ? parsed.positions : [],
            history: Array.isArray(parsed.history) ? parsed.history : []
          };
        } catch (error) {
          return { version: 1, positions: [], history: [] };
        }
      }

      function parseJournal(raw) {
        var journalApi = win.AutoCuanPortfolioJournalV1;
        if (journalApi && typeof journalApi.parseState === 'function') return journalApi.parseState(raw);
        try {
          var parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
          var source = parsed && parsed.state ? parsed.state : parsed;
          return { version: 1, entries: source && Array.isArray(source.entries) ? source.entries : [] };
        } catch (error) {
          return { version: 1, entries: [] };
        }
      }

      function download(filename, content, mime) {
        var blob = new Blob([content], { type: mime });
        var url = win.URL.createObjectURL(blob);
        var link = doc.createElement('a');
        link.href = url;
        link.download = filename;
        link.style.display = 'none';
        doc.body.appendChild(link);
        link.click();
        link.remove();
        win.setTimeout(function () { win.URL.revokeObjectURL(url); }, 1000);
      }

      function csvCell(value) {
        var text = String(value == null ? '' : value);
        return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
      }

      function safeDate() {
        return new Date().toISOString().slice(0, 10);
      }

      function unifiedBackup() {
        var portfolioKey = currentPortfolioKey();
        if (!portfolioKey) { toast('Masuk ke akun terlebih dahulu.', 'error'); return; }
        var journalKey = currentJournalKey();
        var envelope = {
          schema: 'autocuan-portfolio-complete-v1',
          version: 1,
          exportedAt: new Date().toISOString(),
          portfolio: parsePortfolio(win.localStorage.getItem(portfolioKey)),
          journal: parseJournal(journalKey ? win.localStorage.getItem(journalKey) : null)
        };
        download('auto-cuan-portfolio-lengkap-' + safeDate() + '.json', JSON.stringify(envelope, null, 2), 'application/json;charset=utf-8');
        toast('Backup lengkap posisi, riwayat, dan jurnal dibuat.', 'success');
      }

      function unifiedRestore(file) {
        if (!file || restoreBusy) return;
        if (file.size > MAX_BACKUP_BYTES) { toast('File backup terlalu besar. Maksimal 1 MB.', 'error'); return; }
        var portfolioKey = currentPortfolioKey();
        var journalKey = currentJournalKey();
        if (!portfolioKey || !journalKey) { toast('Masuk ke akun terlebih dahulu.', 'error'); return; }
        restoreBusy = true;
        file.text().then(function (text) {
          var parsed;
          try { parsed = JSON.parse(text); }
          catch (error) { throw new Error('File bukan JSON yang valid.'); }
          if (!parsed || parsed.schema !== 'autocuan-portfolio-complete-v1') throw new Error('Format backup lengkap tidak dikenali.');
          var portfolio = parsePortfolio(parsed.portfolio);
          var journal = parseJournal(parsed.journal);
          var message = 'Pulihkan ' + portfolio.positions.length + ' posisi, ' + portfolio.history.length + ' riwayat, dan ' + journal.entries.length + ' jurnal? Data lokal akun ini akan diganti.';
          if (!win.confirm(message)) return;
          win.localStorage.setItem(portfolioKey, JSON.stringify(portfolio));
          win.localStorage.setItem(journalKey, JSON.stringify(journal));
          if (typeof win.renderPortfolio === 'function') win.renderPortfolio();
          toast('Backup lengkap berhasil dipulihkan. Muat ulang halaman bila jurnal belum langsung berubah.', 'success');
        }).catch(function (error) {
          toast(error && error.message ? error.message : 'Gagal memulihkan backup.', 'error');
        }).finally(function () {
          restoreBusy = false;
          var input = doc.getElementById('pfCompleteRestoreInput');
          if (input) input.value = '';
        });
      }

      function exportTransactions() {
        var key = currentPortfolioKey();
        if (!key) { toast('Masuk ke akun terlebih dahulu.', 'error'); return; }
        var state = parsePortfolio(win.localStorage.getItem(key));
        if (!state.history.length) { toast('Belum ada riwayat transaksi untuk diekspor.', 'warning'); return; }
        var rows = [['Waktu', 'Ticker', 'Aksi', 'Lot', 'Harga', 'Realized P/L']];
        state.history.forEach(function (item) {
          rows.push([
            new Date(item.timestamp).toISOString(),
            item.ticker,
            item.action,
            item.lots,
            item.price,
            item.realizedPL
          ]);
        });
        var csv = '\ufeff' + rows.map(function (row) { return row.map(csvCell).join(','); }).join('\r\n');
        download('auto-cuan-riwayat-transaksi-' + safeDate() + '.csv', csv, 'text/csv;charset=utf-8');
        toast('Riwayat transaksi berhasil diekspor.', 'success');
      }

      function normalizeTickers(value) {
        var seen = new Set();
        String(value || '').toUpperCase().split(/[\s,;|]+/).forEach(function (raw) {
          var ticker = api && typeof api.normalizeTicker === 'function' ? api.normalizeTicker(raw) : null;
          if (ticker && seen.size < MAX_TICKERS) seen.add(ticker);
        });
        return Array.from(seen);
      }

      function screenerTickers() {
        var root = doc.getElementById('page-screener');
        if (!root) return [];
        var found = new Set();
        Array.prototype.forEach.call(root.querySelectorAll('[data-ticker],[data-symbol]'), function (node) {
          [node.getAttribute('data-ticker'), node.getAttribute('data-symbol')].forEach(function (raw) {
            var ticker = api.normalizeTicker(raw);
            if (ticker && found.size < MAX_TICKERS) found.add(ticker);
          });
        });
        var ignored = new Set(['ALL','RISK','SCORE','EXEC','READY','WATCH','STATUS','TYPE','SEARCH','SWING','PDF','FAILED','SCANNED','UNIVERSE']);
        var matches = String(root.textContent || '').toUpperCase().match(/\b[A-Z]{3,5}(?:\.JK)?\b/g) || [];
        matches.forEach(function (raw) {
          var ticker = api.normalizeTicker(raw);
          if (ticker && !ignored.has(ticker) && found.size < MAX_TICKERS) found.add(ticker);
        });
        return Array.from(found);
      }

      async function fetchQuote(ticker) {
        var headers = typeof win.getAuthHeaders === 'function' ? win.getAuthHeaders() : {};
        var controller = typeof win.AbortController === 'function' ? new win.AbortController() : null;
        var timer = controller ? win.setTimeout(function () { controller.abort(); }, 12000) : null;
        try {
          var response = await win.fetch('/api/quote?ticker=' + encodeURIComponent(ticker) + '&portfolio=1', {
            headers: headers,
            signal: controller ? controller.signal : undefined
          });
          var data = await response.json();
          var accepted = api.acceptQuote ? api.acceptQuote(data) : null;
          if (!response.ok || !accepted) throw new Error((data && data.error) || 'Harga tidak tersedia');
          return { ticker: ticker, ok: true, quote: accepted };
        } catch (error) {
          return { ticker: ticker, ok: false, error: error && error.message ? error.message : 'Harga tidak tersedia' };
        } finally {
          if (timer) win.clearTimeout(timer);
        }
      }

      async function mapLimit(items, limit, worker) {
        var results = new Array(items.length);
        var cursor = 0;
        async function runner() {
          while (cursor < items.length) {
            var index = cursor++;
            results[index] = await worker(items[index], index);
          }
        }
        var runners = [];
        for (var i = 0; i < Math.min(limit, items.length); i += 1) runners.push(runner());
        await Promise.all(runners);
        return results;
      }

      function renderComparison(results, allocation) {
        var target = doc.getElementById('pfBudgetFinderResults');
        if (!target) return;
        if (!results.length) {
          target.innerHTML = '<p class="rounded-lg border border-dark-600/40 p-4 text-xs text-gray-500">Belum ada hasil.</p>';
          return;
        }
        target.innerHTML = results.map(function (result) {
          if (!result.ok) {
            return '<article class="rounded-xl border border-dark-600/40 bg-dark-800/20 p-4"><p class="font-bold text-white">' + api.escapeHtml(result.ticker) + '</p><p class="mt-2 text-xs text-red-300">' + api.escapeHtml(result.error) + '</p></article>';
          }
          var price = Number(result.quote.price);
          var lots = Math.floor(allocation / (price * api.LOT_SIZE));
          var purchase = lots * price * api.LOT_SIZE;
          var remaining = allocation - purchase;
          var stale = result.quote.stale ? ' · T-1/stale' : '';
          return '<article class="rounded-xl border border-dark-600/40 bg-dark-800/20 p-4 space-y-2" data-budget-result="' + api.escapeHtml(result.ticker) + '">' +
            '<div class="flex items-start justify-between gap-2"><div><p class="font-black text-white">' + api.escapeHtml(result.ticker) + '</p><p class="text-[10px] text-gray-500">Harga ' + money(price) + stale + '</p></div><p class="text-lg font-black text-emerald-300">' + lots + ' lot</p></div>' +
            '<div class="grid grid-cols-2 gap-2 text-xs"><div><p class="text-gray-500">Nilai beli</p><p class="text-gray-200">' + money(purchase) + '</p></div><div><p class="text-gray-500">Sisa alokasi</p><p class="text-gray-200">' + money(remaining) + '</p></div></div>' +
            (lots > 0 ? '<button type="button" data-budget-use="' + api.escapeHtml(result.ticker) + '" data-budget-price="' + price + '" class="pf-action text-blue-300">Masukkan ke Kalkulator</button>' : '<p class="text-xs text-amber-300">Alokasi belum cukup untuk 1 lot.</p>') +
          '</article>';
        }).join('');
      }

      async function compareTickers() {
        if (compareBusy) return;
        var budget = positiveNumber((doc.getElementById('pfBudgetFinderBudget') || {}).value, 1000000000000);
        var allocationPct = positiveNumber((doc.getElementById('pfBudgetFinderAllocation') || {}).value, 100);
        var maxPrice = positiveNumber((doc.getElementById('pfBudgetFinderMaxPrice') || {}).value, api.MAX_PRICE) || api.MAX_PRICE;
        var tickers = normalizeTickers((doc.getElementById('pfBudgetFinderTickers') || {}).value);
        if (!budget || !allocationPct || !tickers.length) {
          toast('Isi budget, alokasi 1–100%, dan minimal satu ticker.', 'error');
          return;
        }
        compareBusy = true;
        var button = doc.getElementById('pfBudgetFinderCompare');
        if (button) { button.disabled = true; button.textContent = 'Mengambil harga…'; }
        var allocation = budget * allocationPct / 100;
        try {
          var results = await mapLimit(tickers, QUOTE_CONCURRENCY, fetchQuote);
          results = results.filter(function (result) { return !result.ok || Number(result.quote.price) <= maxPrice; });
          results.sort(function (a, b) {
            if (a.ok !== b.ok) return a.ok ? -1 : 1;
            return a.ok ? Number(a.quote.price) - Number(b.quote.price) : a.ticker.localeCompare(b.ticker);
          });
          renderComparison(results, allocation);
        } finally {
          compareBusy = false;
          if (button) { button.disabled = false; button.textContent = 'Bandingkan Ticker'; }
        }
      }

      function useBudgetResult(button) {
        var ticker = button.getAttribute('data-budget-use');
        var price = button.getAttribute('data-budget-price');
        var budget = (doc.getElementById('pfBudgetFinderBudget') || {}).value;
        var tickerInput = doc.getElementById('pfTicker');
        var budgetInput = doc.getElementById('pfBudget');
        var buyInput = doc.getElementById('pfBuy');
        var stopInput = doc.getElementById('pfStop');
        var targetInput = doc.getElementById('pfTarget');
        if (!tickerInput || !budgetInput || !buyInput) return;
        tickerInput.value = ticker;
        budgetInput.value = budget;
        buyInput.value = price;
        if (stopInput) stopInput.value = '';
        if (targetInput) targetInput.value = '';
        tickerInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast(ticker + ' dimasukkan ke Kalkulator. Isi stop/invalidation sebelum menghitung posisi.', 'success');
      }

      function ensureSection() {
        if (doc.getElementById('pfFinalPortfolioTools')) return true;
        var journal = doc.getElementById('pfJournalSection');
        var calcTitle = doc.getElementById('pfCalcTitle');
        var calcSection = calcTitle && calcTitle.closest('section');
        var anchor = journal || calcSection;
        if (!anchor) return false;
        var section = doc.createElement('section');
        section.id = 'pfFinalPortfolioTools';
        section.className = 'portfolio-card p-4 space-y-5';
        section.innerHTML = '' +
          '<div><h3 class="text-base font-bold text-white">Cari Saham Sesuai Budget</h3><p class="mt-1 text-xs text-gray-500">Membandingkan kemampuan beli berdasarkan harga terakhir dan alokasi. Bukan rekomendasi saham dan tidak memakai AI.</p></div>' +
          '<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">' +
            '<label><span class="mb-1 block text-[11px] text-gray-500">Budget Total</span><input id="pfBudgetFinderBudget" type="number" inputmode="decimal" placeholder="5000000" class="w-full rounded-lg border border-dark-600/40 bg-dark-800/80 px-3 py-2 text-sm text-gray-100"></label>' +
            '<label><span class="mb-1 block text-[11px] text-gray-500">Alokasi Maks. per Saham (%)</span><input id="pfBudgetFinderAllocation" type="number" min="1" max="100" value="30" class="w-full rounded-lg border border-dark-600/40 bg-dark-800/80 px-3 py-2 text-sm text-gray-100"></label>' +
            '<label><span class="mb-1 block text-[11px] text-gray-500">Harga Maksimum (opsional)</span><input id="pfBudgetFinderMaxPrice" type="number" inputmode="decimal" placeholder="Kosong = bebas" class="w-full rounded-lg border border-dark-600/40 bg-dark-800/80 px-3 py-2 text-sm text-gray-100"></label>' +
            '<label><span class="mb-1 block text-[11px] text-gray-500">Ticker, maks. 20</span><input id="pfBudgetFinderTickers" maxlength="180" placeholder="BBCA, BBRI, BMRI, TLKM" class="w-full rounded-lg border border-dark-600/40 bg-dark-800/80 px-3 py-2 text-sm text-gray-100"></label>' +
          '</div>' +
          '<div class="flex flex-wrap gap-2"><button id="pfBudgetFinderCompare" type="button" class="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-black">Bandingkan Ticker</button><button id="pfBudgetFinderScreener" type="button" class="pf-action text-blue-300">Ambil dari Screener</button></div>' +
          '<div id="pfBudgetFinderResults" class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3"></div>' +
          '<div class="border-t border-dark-600/40 pt-4"><div class="flex flex-wrap items-start justify-between gap-3"><div><h3 class="text-sm font-bold text-white">Data Portfolio Lengkap</h3><p class="mt-1 text-xs text-gray-500">Backup terpadu mencakup posisi aktif, riwayat transaksi, dan jurnal akun ini di browser.</p></div><div class="flex flex-wrap gap-2"><button id="pfCompleteBackup" type="button" class="pf-action text-blue-300">Backup Lengkap</button><button id="pfCompleteRestore" type="button" class="pf-action text-amber-300">Pulihkan Lengkap</button><button id="pfTransactionCsv" type="button" class="pf-action text-emerald-300">Ekspor Transaksi CSV</button><input id="pfCompleteRestoreInput" type="file" accept="application/json,.json" class="hidden"></div></div></div>';
        anchor.insertAdjacentElement('afterend', section);

        var style = doc.createElement('style');
        style.id = 'pfFinalPortfolioStyles';
        style.textContent = '#pfFinalPortfolioTools .pf-action{margin-top:0;min-height:40px}#pfFinalPortfolioTools article{min-width:0}#pfFinalPortfolioTools p{overflow-wrap:anywhere}@media(max-width:640px){#pfBudgetFinderResults{grid-template-columns:1fr}}';
        doc.head.appendChild(style);

        doc.getElementById('pfBudgetFinderCompare').addEventListener('click', compareTickers);
        doc.getElementById('pfBudgetFinderScreener').addEventListener('click', function () {
          var tickers = screenerTickers();
          if (!tickers.length) { toast('Belum menemukan ticker. Buka Screener dan tampilkan hasilnya dahulu.', 'warning'); return; }
          doc.getElementById('pfBudgetFinderTickers').value = tickers.join(', ');
          toast(tickers.length + ' ticker diambil dari tampilan Screener tanpa mengubah perhitungannya.', 'success');
        });
        doc.getElementById('pfBudgetFinderResults').addEventListener('click', function (event) {
          var button = event.target.closest('button[data-budget-use]');
          if (button) useBudgetResult(button);
        });
        doc.getElementById('pfCompleteBackup').addEventListener('click', unifiedBackup);
        doc.getElementById('pfCompleteRestore').addEventListener('click', function () { doc.getElementById('pfCompleteRestoreInput').click(); });
        doc.getElementById('pfCompleteRestoreInput').addEventListener('change', function (event) { unifiedRestore(event.target.files && event.target.files[0]); });
        doc.getElementById('pfTransactionCsv').addEventListener('click', exportTransactions);
        return true;
      }

      function init(attempt) {
        api = win.AutoCuanPortfolioV1;
        if (!api || !doc.getElementById('pfCalcTitle') || typeof win.getPortfolioKey !== 'function') {
          if ((attempt || 0) < 120) win.setTimeout(function () { init((attempt || 0) + 1); }, 100);
          return;
        }
        if (doc.documentElement.hasAttribute('data-pf-final-ready')) return;
        if (!ensureSection()) {
          if ((attempt || 0) < 120) win.setTimeout(function () { init((attempt || 0) + 1); }, 100);
          return;
        }
        doc.documentElement.setAttribute('data-pf-final-ready', 'true');
      }

      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { init(0); }, { once: true });
      else init(0);
    }.toString() + ')(window);';
  }

  Promise.all(parts.map(function (url) {
    return fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then(function (response) {
      if (!response.ok) throw new Error('Portfolio runtime HTTP ' + response.status);
      return response.text();
    });
  })).then(function (chunks) {
    var script = document.createElement('script');
    script.setAttribute('data-portfolio-v1-runtime', 'true');
    script.text = chunks.join('') + '\n' + enhancementSource() + '\n' + finalPortfolioSource();
    document.head.appendChild(script);
  }).catch(function (error) {
    console.error('[Portfolio V1] runtime gagal dimuat', error);
    var content = document.getElementById('portofolioContent');
    if (content) content.innerHTML = '<div class="portfolio-card p-4 text-sm text-red-300">Portfolio V1 gagal dimuat. Muat ulang halaman.</div>';
  });
})(window);
