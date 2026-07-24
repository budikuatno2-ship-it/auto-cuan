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

  function portfolioEnhancementSource() {
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

      function portfolioKey() {
        return typeof win.getPortfolioKey === 'function' ? win.getPortfolioKey() : null;
      }

      function readState() {
        var key = portfolioKey();
        if (!key) return { version: 1, positions: [], history: [] };
        return api.parseStoredState(win.localStorage.getItem(key));
      }

      function writeState(state) {
        var key = portfolioKey();
        if (!key) return false;
        state.positions = (state.positions || []).map(api.sanitizePosition).filter(Boolean);
        state.history = (state.history || []).map(api.sanitizeHistory).filter(Boolean).slice(-api.MAX_HISTORY);
        win.localStorage.setItem(key, JSON.stringify(state));
        if (typeof win.renderPortfolio === 'function') win.renderPortfolio();
        win.setTimeout(enhancePortfolioCards, 0);
        return true;
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

      function historyLabel(item) {
        if (!item) return 'Transaksi';
        if (item.action === 'delete') return 'Hapus Data';
        if (item.action === 'close') return item.realizedPL < 0 ? 'Tutup / Cut Loss' : (item.realizedPL > 0 ? 'Tutup / Take Profit' : 'Tutup Posisi');
        return item.realizedPL < 0 ? 'Cut Loss' : (item.realizedPL > 0 ? 'Take Profit' : 'Jual Impas');
      }

      function enhanceHistory() {
        var history = doc.getElementById('pfHistory');
        if (!history) return;
        var state = readState();
        var items = (state.history || []).slice().reverse().slice(0, 20);
        Array.prototype.forEach.call(history.children, function (row, index) {
          var item = items[index];
          var label = row.querySelector('span');
          if (item && label) label.textContent = item.ticker + ' · ' + historyLabel(item) + ' · ' + item.lots + ' lot';
        });
      }

      function closeModal() {
        var modal = doc.getElementById('pfModal');
        if (!modal) return;
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        var confirm = doc.getElementById('pfModalConfirm');
        if (confirm) confirm.onclick = null;
      }

      function openModal(title, bodyHtml, onConfirm, onOpen) {
        var modal = doc.getElementById('pfModal');
        var titleEl = doc.getElementById('pfModalTitle');
        var body = doc.getElementById('pfModalBody');
        var confirm = doc.getElementById('pfModalConfirm');
        if (!modal || !titleEl || !body || !confirm) return;
        titleEl.textContent = title;
        body.innerHTML = bodyHtml;
        confirm.disabled = false;
        confirm.onclick = function () {
          var result = onConfirm();
          if (result !== false) closeModal();
        };
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        if (onOpen) onOpen();
      }

      function numericField(id, label, placeholder) {
        return '<label class="block"><span class="block text-[11px] text-gray-500 mb-1">' + api.escapeHtml(label) + '</span><input id="' + id + '" type="number" inputmode="decimal" placeholder="' + api.escapeHtml(placeholder) + '" class="w-full px-3 py-2 rounded-lg bg-dark-800/80 border border-dark-600/40 text-gray-100 placeholder-gray-600 text-sm focus:outline-none focus:border-emerald-500/50"></label>';
      }

      function averageUp(index) {
        var state = readState();
        var position = state.positions[index];
        if (!position) return;
        openModal('Average Up ' + position.ticker,
          '<p class="text-sm text-gray-300">Average up berarti menambah posisi pada harga di atas average buy. Average buy, modal, dan risiko posisi akan ikut meningkat. Ini perhitungan matematika, bukan rekomendasi membeli.</p>' +
          '<div class="rounded-lg border border-dark-600/40 p-3 text-sm text-gray-300">Average saat ini: <strong>' + money(position.averageBuy) + '</strong> · Posisi: <strong>' + position.lots + ' lot</strong></div>' +
          numericField('pfEnhUpLots', 'Lot Tambahan', '1') + numericField('pfEnhUpPrice', 'Harga Tambahan', String(position.lastPrice || position.averageBuy + 1)) +
          '<div id="pfEnhUpPreview" class="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-sm text-gray-300">Isi lot dan harga untuk melihat dampaknya.</div>',
          function () {
            var lots = api.positiveInteger((doc.getElementById('pfEnhUpLots') || {}).value, api.MAX_LOTS);
            var price = api.finitePositive((doc.getElementById('pfEnhUpPrice') || {}).value, api.MAX_PRICE);
            if (!lots || !price) { toast('Lot atau harga Average Up tidak valid.', 'error'); return false; }
            if (price <= position.averageBuy) { toast('Harga Average Up harus di atas average buy saat ini.', 'error'); return false; }
            var newAverage = api.weightedAverage(position.averageBuy, position.lots, price, lots);
            if (!newAverage) { toast('Perhitungan Average Up tidak valid.', 'error'); return false; }
            position.averageBuy = newAverage;
            position.lots += lots;
            position.investedCapital = newAverage * position.lots * api.LOT_SIZE;
            position.updatedAt = Date.now();
            writeState(state);
            toast('Average Up disimpan setelah konfirmasi.', 'success');
          },
          function () {
            function preview() {
              var lots = api.positiveInteger((doc.getElementById('pfEnhUpLots') || {}).value, api.MAX_LOTS);
              var price = api.finitePositive((doc.getElementById('pfEnhUpPrice') || {}).value, api.MAX_PRICE);
              var box = doc.getElementById('pfEnhUpPreview');
              if (!box || !lots || !price) return;
              if (price <= position.averageBuy) { box.innerHTML = '<p class="text-red-300">Harga harus di atas average buy untuk disebut Average Up.</p>'; return; }
              var avg = api.weightedAverage(position.averageBuy, position.lots, price, lots);
              var totalLots = position.lots + lots;
              var additionalCapital = price * lots * api.LOT_SIZE;
              var estimatedLoss = Math.max(0, (avg - position.stop) * totalLots * api.LOT_SIZE);
              box.innerHTML = '<p>Avg lama: <strong>' + money(position.averageBuy) + '</strong> → Avg baru: <strong>' + money(avg) + '</strong></p><p>Total posisi: <strong>' + totalLots + ' lot</strong> · Modal tambahan: <strong>' + money(additionalCapital) + '</strong></p><p>Estimasi risiko ke stop setelah penambahan: <strong>' + money(estimatedLoss) + '</strong></p>';
            }
            ['pfEnhUpLots', 'pfEnhUpPrice'].forEach(function (id) {
              var input = doc.getElementById(id);
              if (input) input.addEventListener('input', preview);
            });
            preview();
          });
      }

      function manageExit(index) {
        var state = readState();
        var position = state.positions[index];
        if (!position) return;
        openModal('Cut Loss / Take Profit ' + position.ticker,
          '<p class="text-sm text-gray-300">Harga jual di bawah average buy akan tercatat sebagai <strong class="text-red-300">Cut Loss</strong>. Harga jual di atas average buy akan tercatat sebagai <strong class="text-emerald-300">Take Profit</strong>. Sistem hanya mencatat; tidak ada transaksi otomatis ke broker.</p>' +
          '<div class="rounded-lg border border-dark-600/40 p-3 text-sm text-gray-300">Average buy: <strong>' + money(position.averageBuy) + '</strong> · Tersedia: <strong>' + position.lots + ' lot</strong></div>' +
          numericField('pfEnhSellLots', 'Lot Dijual', '1') + numericField('pfEnhSellPrice', 'Harga Jual', String(position.lastPrice || position.averageBuy)) +
          '<div id="pfEnhSellPreview" class="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-sm text-gray-300">Isi lot dan harga jual untuk melihat dampaknya.</div>',
          function () {
            var sale = api.calculatePartialSale(position, (doc.getElementById('pfEnhSellLots') || {}).value, (doc.getElementById('pfEnhSellPrice') || {}).value);
            if (!sale.ok) { toast(sale.error, 'error'); return false; }
            position.realizedPL = Number(position.realizedPL || 0) + sale.realizedPL;
            state.history.push({
              ticker: position.ticker,
              action: sale.closesPosition ? 'close' : 'sell',
              lots: sale.lotsSold,
              price: sale.salePrice,
              realizedPL: sale.realizedPL,
              timestamp: Date.now()
            });
            if (sale.closesPosition) state.positions.splice(index, 1);
            else {
              position.lots = sale.remainingLots;
              position.investedCapital = sale.remainingInvested;
              position.updatedAt = Date.now();
            }
            writeState(state);
            var action = sale.realizedPL < 0 ? 'Cut Loss' : (sale.realizedPL > 0 ? 'Take Profit' : 'Penjualan impas');
            toast(action + ' dicatat: ' + money(sale.realizedPL) + '.', sale.realizedPL < 0 ? 'warning' : 'success');
          },
          function () {
            function preview() {
              var sale = api.calculatePartialSale(position, (doc.getElementById('pfEnhSellLots') || {}).value, (doc.getElementById('pfEnhSellPrice') || {}).value);
              var box = doc.getElementById('pfEnhSellPreview');
              if (!box) return;
              if (!sale.ok) { box.innerHTML = '<p class="text-red-300">' + api.escapeHtml(sale.error) + '</p>'; return; }
              var action = sale.realizedPL < 0 ? 'Cut Loss' : (sale.realizedPL > 0 ? 'Take Profit' : 'Impas');
              var tone = sale.realizedPL < 0 ? 'text-red-300' : (sale.realizedPL > 0 ? 'text-emerald-300' : 'text-gray-300');
              box.innerHTML = '<p>Jenis pencatatan: <strong class="' + tone + '">' + action + '</strong></p><p>Realized P/L: <strong class="' + tone + '">' + money(sale.realizedPL) + '</strong></p><p>Sisa posisi: <strong>' + sale.remainingLots + ' lot</strong>. Average buy sisa posisi tetap <strong>' + money(sale.remainingAverage) + '</strong>.</p><p class="text-xs text-gray-500">Rumus: (harga jual − average buy) × lot dijual × 100 saham.</p>';
            }
            ['pfEnhSellLots', 'pfEnhSellPrice'].forEach(function (id) {
              var input = doc.getElementById(id);
              if (input) input.addEventListener('input', preview);
            });
            preview();
          });
      }

      function enhancePortfolioCards() {
        var container = doc.getElementById('pfPositions');
        if (!container) return;
        Array.prototype.forEach.call(container.querySelectorAll('article[data-index]'), function (card) {
          var index = Number(card.getAttribute('data-index'));
          var statusEl = card.querySelector('h4 + p');
          var status = statusEl ? statusEl.textContent.trim() : '';
          var averageDown = card.querySelector('button[data-action="average"]');
          if (averageDown) averageDown.textContent = 'Average Down';
          var actionRow = card.querySelector('button[data-action]') ? card.querySelector('button[data-action]').parentElement : null;
          if (actionRow && !actionRow.querySelector('[data-pf-action="average-up"]')) {
            var up = doc.createElement('button');
            up.type = 'button';
            up.className = 'pf-action';
            up.setAttribute('data-pf-action', 'average-up');
            up.textContent = 'Average Up';
            actionRow.insertBefore(up, actionRow.querySelector('button[data-action="sell"]'));
          }
          if (actionRow && !actionRow.querySelector('[data-pf-action="exit"]')) {
            var exit = doc.createElement('button');
            exit.type = 'button';
            exit.className = 'pf-action';
            exit.setAttribute('data-pf-action', 'exit');
            exit.textContent = 'Cut Loss / Take Profit';
            actionRow.insertBefore(exit, actionRow.querySelector('button[data-action="close"]'));
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
        enhanceHistory();
      }

      function initEnhancement(attempt) {
        var calculate = doc.getElementById('pfCalculate');
        var positions = doc.getElementById('pfPositions');
        if (!calculate || !positions) {
          if ((attempt || 0) < 30) win.setTimeout(function () { initEnhancement((attempt || 0) + 1); }, 100);
          return;
        }
        if (!calculate.hasAttribute('data-pf-explain-bound')) {
          calculate.setAttribute('data-pf-explain-bound', 'true');
          calculate.addEventListener('click', function () { win.setTimeout(renderCalculatorExplanation, 0); });
        }
        positions.addEventListener('click', function (event) {
          var button = event.target.closest('button[data-pf-action]');
          if (!button) return;
          var card = button.closest('article[data-index]');
          var index = Number(card && card.getAttribute('data-index'));
          if (!Number.isInteger(index)) return;
          if (button.getAttribute('data-pf-action') === 'average-up') averageUp(index);
          else if (button.getAttribute('data-pf-action') === 'exit') manageExit(index);
        });
        if (typeof win.MutationObserver === 'function') {
          new win.MutationObserver(enhancePortfolioCards).observe(positions, { childList: true, subtree: true });
          var history = doc.getElementById('pfHistory');
          if (history) new win.MutationObserver(enhanceHistory).observe(history, { childList: true, subtree: true });
        }
        ensureExplanationBox();
        enhancePortfolioCards();
      }

      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { initEnhancement(0); }, { once: true });
      else initEnhancement(0);
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
    script.text = chunks.join('') + '\n' + portfolioEnhancementSource();
    document.head.appendChild(script);
  }).catch(function (error) {
    console.error('[Portfolio V1] runtime gagal dimuat', error);
    var content = document.getElementById('portofolioContent');
    if (content) content.innerHTML = '<div class="portfolio-card p-4 text-sm text-red-300">Portfolio V1 gagal dimuat. Muat ulang halaman.</div>';
  });
})(window);
