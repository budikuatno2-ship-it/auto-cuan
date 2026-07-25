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

  Promise.all(parts.map(function (url) {
    return fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then(function (response) {
      if (!response.ok) throw new Error('Portfolio runtime HTTP ' + response.status);
      return response.text();
    });
  })).then(function (chunks) {
    var script = document.createElement('script');
    script.setAttribute('data-portfolio-v1-runtime', 'true');
    script.text = chunks.join('') + '\n' + enhancementSource();
    document.head.appendChild(script);
  }).catch(function (error) {
    console.error('[Portfolio V1] runtime gagal dimuat', error);
    var content = document.getElementById('portofolioContent');
    if (content) content.innerHTML = '<div class="portfolio-card p-4 text-sm text-red-300">Portfolio V1 gagal dimuat. Muat ulang halaman.</div>';
  });
})(window);
