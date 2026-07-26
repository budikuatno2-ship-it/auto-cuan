(function () {
  'use strict';

  if (window.AutoCuanAI && window.AutoCuanAI.renderMarkdown) return;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function friendlyText(value) {
    var text = String(value == null ? '' : value).trim();
    return text
      .replace(/Model terlalu lama menyelesaikan jawaban\. Sistem tidak mencoba model lain karena request pertama mungkin tetap dihitung provider\. Coba lagi nanti dengan pertanyaan yang lebih singkat\./gi,
        'AI-nya lagi mikir kelamaan. Biar token nggak kebuang, sistem nggak nembak model lain dulu. Coba lagi bentar dengan pertanyaan yang lebih ringkas ya.')
      .replace(/Model yang tersedia menolak request atau sedang penuh\. Fallback dihentikan agar token tidak terbuang\. Coba lagi setelah beberapa saat\./gi,
        'Model yang lagi aktif belum bisa nerima request ini. Sistem berhenti dulu biar tokenmu nggak kebakar. Coba lagi sebentar ya.')
      .replace(/Model yang dicoba sedang gangguan atau traffic ramai\. Sistem menghentikan fallback agar token tidak terbuang\. Coba lagi setelah beberapa saat\./gi,
        'Model yang dicoba lagi ramai atau gangguan. Sistem stop dulu biar tokenmu nggak kebakar. Coba lagi bentar ya.')
      .replace(/Mohon bersabar ya, traffic model sedang ramai…/gi,
        'Sedikit lebih lama nih—traffic lagi ramai, tapi pertanyaanmu masih jalan…')
      .replace(/Memuat data(?: analisis| portofolio)? dan memilih model terbaik…/gi,
        'Lagi baca datanya dan nyari jalur AI yang paling pas…')
      .replace(/Masih memproses data dan mencoba model cadangan…/gi,
        'Masih diproses ya, lagi cek jalur cadangan yang sehat…');
  }

  function inlineFormat(value) {
    var html = escapeHtml(value);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    return html;
  }

  function renderMarkdown(value) {
    var text = friendlyText(value).replace(/\r/g, '');
    var lines = text.split('\n');
    var html = [];
    var listType = '';

    function closeList() {
      if (!listType) return;
      html.push(listType === 'ol' ? '</ol>' : '</ul>');
      listType = '';
    }

    lines.forEach(function (rawLine) {
      var line = rawLine.trim();
      if (!line) {
        closeList();
        return;
      }

      var heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        closeList();
        var level = Math.min(4, heading[1].length + 2);
        html.push('<h' + level + '>' + inlineFormat(heading[2]) + '</h' + level + '>');
        return;
      }

      var bullet = line.match(/^[-*]\s+(.+)$/);
      if (bullet) {
        if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
        html.push('<li>' + inlineFormat(bullet[1]) + '</li>');
        return;
      }

      var numbered = line.match(/^\d+[.)]\s+(.+)$/);
      if (numbered) {
        if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
        html.push('<li>' + inlineFormat(numbered[1]) + '</li>');
        return;
      }

      closeList();
      html.push('<p>' + inlineFormat(line) + '</p>');
    });

    closeList();
    return html.join('');
  }

  function setTextIfChanged(node, value) {
    var next = String(value == null ? '' : value);
    if (node && node.textContent !== next) node.textContent = next;
  }

  function polishNode(node) {
    if (!node || node.nodeType !== 1) return;

    if (node.matches && node.matches('#aiStatus')) {
      var cleanedStatus = friendlyText(node.textContent).replace(/\s*Model:\s*[^.]+\.?/gi, '').trim();
      setTextIfChanged(node, cleanedStatus);
    }

    var modelLabels = node.querySelectorAll ? node.querySelectorAll('[class*="text-"][class*="gray"]') : [];
    Array.prototype.forEach.call(modelLabels, function (el) {
      if (/^\s*Model:\s*wz\//i.test(el.textContent || '')) el.remove();
    });

    var candidates = [];
    if (node.matches && (node.matches('.ai-message.ai-assistant') || node.matches('.ai-content.ai-followup'))) candidates.push(node);
    if (node.querySelectorAll) {
      Array.prototype.push.apply(candidates, node.querySelectorAll('.ai-message.ai-assistant, .ai-content.ai-followup'));
    }

    candidates.forEach(function (el) {
      if (el.querySelector && el.querySelector('.ai-loading-dot, .spinner-sm')) return;
      var raw = el.getAttribute('data-ai-raw') || el.textContent || '';
      if (!raw.trim()) return;
      var signature = raw.length + ':' + raw.slice(0, 40);
      if (el.getAttribute('data-ai-rendered') === signature) return;
      el.setAttribute('data-ai-raw', raw);
      el.setAttribute('data-ai-rendered', signature);
      el.classList.add('ai-rich-text');
      el.innerHTML = renderMarkdown(raw);
    });

    var loadingTexts = node.querySelectorAll ? node.querySelectorAll('#stockAiLoadingText, #aiLoadingText') : [];
    Array.prototype.forEach.call(loadingTexts, function (el) {
      setTextIfChanged(el, friendlyText(el.textContent));
    });
  }

  var style = document.createElement('style');
  style.textContent = '.ai-rich-text{white-space:normal!important}.ai-rich-text p{margin:.45rem 0;line-height:1.65}.ai-rich-text p:first-child{margin-top:0}.ai-rich-text p:last-child{margin-bottom:0}.ai-rich-text h3,.ai-rich-text h4{margin:1rem 0 .45rem;font-size:1rem;line-height:1.35;color:#f1f5f9}.ai-rich-text ul,.ai-rich-text ol{margin:.45rem 0 .75rem;padding-left:1.35rem}.ai-rich-text li{margin:.28rem 0;line-height:1.6}.ai-rich-text strong{color:#f8fafc;font-weight:750}.ai-rich-text code{padding:.1rem .35rem;border-radius:.35rem;background:rgba(15,23,42,.75);color:#a7f3d0;font: .9em ui-monospace,SFMono-Regular,Menlo,monospace}';
  document.head.appendChild(style);

  window.AutoCuanAI = { renderMarkdown: renderMarkdown, friendlyText: friendlyText, polishNode: polishNode };

  // Important: only process newly inserted elements. Observing characterData and
  // re-writing the same text created a feedback loop that could freeze Chrome.
  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      Array.prototype.forEach.call(mutation.addedNodes || [], function (added) {
        if (added && added.nodeType === 1) polishNode(added);
      });
    });
  });

  function start() {
    polishNode(document.body);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
