(function () {
  'use strict';

  if (window.AutoCuanAI && window.AutoCuanAI.version === '20260727-premium-v2') return;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function normalizeTone(value) {
    return String(value == null ? '' : value)
      .replace(/\b(bestie|bro|sis)\b[,.!?]?/gi, '')
      .replace(/\b(lo|lu)\b/gi, 'Anda')
      .replace(/\bgue\b/gi, 'saya')
      .replace(/\bnggak\b/gi, 'tidak')
      .replace(/\bga(k)?\b/gi, 'tidak')
      .replace(/\budah\b/gi, 'sudah')
      .replace(/\bnih\b/gi, '')
      .replace(/\bbentar\b/gi, 'sebentar')
      .replace(/nangkap (pisau|pedang)/gi, 'masuk sebelum ada konfirmasi pantulan')
      .replace(/bikin tidur nyenyak/gi, 'memberi konfirmasi yang lebih kuat')
      .replace(/terjun bebas/gi, 'mengalami penurunan tajam')
      .replace(/seluruh nasib (porto|portofolio)/gi, 'kinerja portofolio')
      .replace(/profit (?:kecil )?bisa lenyap dalam sekejap/gi, 'profit tipis masih dapat berbalik')
      .replace(/\s+([,.!?;:])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ');
  }

  function normalizeSpacing(value) {
    return normalizeTone(value)
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\|\s*\n\s*\n\s*\|/g, '|\n|')
      .replace(/(^|[^0-9])\.([0-9])/g, '$1. $2')
      .replace(/([.!?])(?=[A-ZÀ-ÖØ-Þ])/g, '$1 ')
      .replace(/([,:;])(?=[A-ZÀ-ÖØ-Þ])/g, '$1 ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizeLines(value) {
    var source = normalizeSpacing(value).split('\n');
    var output = [];
    var orphanLabel = '';
    var standaloneHeading = false;

    function push(line) {
      var cleaned = String(line || '').trim();
      if (!cleaned) {
        if (output.length && output[output.length - 1] !== '') output.push('');
        return;
      }
      var previous = output.length ? String(output[output.length - 1] || '').trim().toLowerCase() : '';
      if (previous && previous === cleaned.toLowerCase()) return;
      output.push(cleaned);
    }

    source.forEach(function (raw) {
      var line = raw.trim();
      if (!line) {
        if (!orphanLabel && !standaloneHeading) push('');
        return;
      }
      if (/^(?:#{1,6}|\*\*|__|[-*_]{3,})$/.test(line)) {
        standaloneHeading = /^#{1,6}$/.test(line);
        return;
      }

      var heading = line.match(/^(#{1,6})\s*(.*)$/);
      if (heading) {
        var title = heading[2].replace(/\*\*/g, '').trim();
        if (!title) {
          standaloneHeading = true;
          return;
        }
        if (title.split(/\s+/).length === 1 && title.length < 28) {
          orphanLabel = title.replace(/[:.]$/, '');
          standaloneHeading = false;
          return;
        }
        push('### ' + title);
        standaloneHeading = false;
        return;
      }

      if (standaloneHeading && !orphanLabel) {
        orphanLabel = line.replace(/\*\*/g, '').replace(/[:.]$/, '').trim();
        standaloneHeading = false;
        return;
      }

      if (orphanLabel) {
        var label = orphanLabel;
        orphanLabel = '';
        push('**' + label + ':** ' + line.replace(/^[-–—:\s]+/, ''));
        return;
      }

      push(line);
    });

    if (orphanLabel) push('**' + orphanLabel + ':**');
    return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function inlineFormat(value) {
    var html = escapeHtml(value);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    html = html.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?;:])/g, '$1<em>$2</em>');
    html = html.replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?;:])/g, '$1<em>$2</em>');
    return html.replace(/\*\*|__/g, '');
  }

  function splitTableRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (cell) { return cell.trim(); });
  }
  function isTableLine(line) { return /^\|.*\|$/.test(line.trim()); }
  function isSeparatorRow(cells) {
    return cells.length > 0 && cells.every(function (cell) { return /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')); });
  }

  function renderTable(rows) {
    if (!rows.length) return '';
    var parsed = rows.map(splitTableRow);
    var header = parsed[0];
    var bodyStart = parsed[1] && isSeparatorRow(parsed[1]) ? 2 : 1;
    var body = parsed.slice(bodyStart).filter(function (row) { return row.some(Boolean); });

    if (header.length === 2 && body.length) {
      return '<dl class="ai-kv-grid">' + body.map(function (row) {
        return '<div class="ai-kv-row"><dt>' + inlineFormat(row[0] || '') + '</dt><dd>' + inlineFormat(row[1] || '') + '</dd></div>';
      }).join('') + '</dl>';
    }

    return '<div class="ai-table-wrap"><table><thead><tr>' + header.map(function (cell) {
      return '<th>' + inlineFormat(cell) + '</th>';
    }).join('') + '</tr></thead><tbody>' + body.map(function (row) {
      return '<tr>' + row.map(function (cell) { return '<td>' + inlineFormat(cell) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
  }

  function renderMarkdown(value) {
    var lines = normalizeLines(value).split('\n');
    var html = [];
    var listType = '';
    var tableRows = [];

    function closeList() {
      if (!listType) return;
      html.push(listType === 'ol' ? '</ol>' : '</ul>');
      listType = '';
    }
    function closeTable() {
      if (!tableRows.length) return;
      closeList();
      html.push(renderTable(tableRows));
      tableRows = [];
    }

    lines.forEach(function (rawLine) {
      var line = rawLine.trim();
      if (isTableLine(line)) {
        closeList();
        tableRows.push(line);
        return;
      }
      closeTable();
      if (!line) { closeList(); return; }
      if (/^[-*_]{3,}$/.test(line)) return;

      var heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        closeList();
        html.push('<h3>' + inlineFormat(heading[2]) + '</h3>');
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

    closeTable();
    closeList();
    return html.join('');
  }

  function setTextIfChanged(node, value) {
    var next = String(value == null ? '' : value);
    if (node && node.textContent !== next) node.textContent = next;
  }

  function markFollowupPanel(node) {
    if (!node || !node.closest) return;
    var messages = node.closest('#chatMessages');
    if (messages) messages.classList.add('ai-followup-scroll-region');
  }

  function polishNode(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches && node.matches('#aiStatus')) {
      setTextIfChanged(node, normalizeTone(node.textContent).replace(/\s*Model:\s*[^.]+\.?/gi, '').trim());
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
      markFollowupPanel(el);
      if (el.querySelector && el.querySelector('.ai-loading-dot, .spinner-sm')) return;
      if (el.classList.contains('ai-rich-text') && !el.hasAttribute('data-ai-raw')) return;
      var raw = el.getAttribute('data-ai-raw') || el.textContent || '';
      if (!raw.trim()) return;
      var signature = raw.length + ':' + raw.slice(0, 80);
      if (el.getAttribute('data-ai-rendered') === signature) return;
      el.setAttribute('data-ai-raw', raw);
      el.setAttribute('data-ai-rendered', signature);
      el.classList.add('ai-rich-text');
      el.innerHTML = renderMarkdown(raw);
    });

    var loadingTexts = node.querySelectorAll ? node.querySelectorAll('#stockAiLoadingText, #aiLoadingText') : [];
    Array.prototype.forEach.call(loadingTexts, function (el) { setTextIfChanged(el, normalizeTone(el.textContent)); });
  }

  var style = document.createElement('style');
  style.id = 'autocuan-ai-premium-style';
  style.textContent = [
    '.ai-rich-text{display:block!important;white-space:normal!important;line-height:1.62;max-width:760px;color:#dbe7f5;overflow-wrap:anywhere}',
    '.ai-rich-text p{margin:0 0 10px;line-height:1.62}.ai-rich-text p:last-child{margin-bottom:0}',
    '.ai-rich-text h3{margin:16px 0 7px;font-size:.96rem;line-height:1.35;color:#f8fafc;letter-spacing:-.01em}.ai-rich-text h3:first-child{margin-top:0}',
    '.ai-rich-text ul,.ai-rich-text ol{margin:5px 0 11px;padding-left:1.25rem}.ai-rich-text li{margin:4px 0;line-height:1.55}',
    '.ai-rich-text strong{color:#f8fafc;font-weight:760}.ai-rich-text em{color:#b9c9dc}',
    '.ai-rich-text code{padding:.1rem .34rem;border:1px solid rgba(148,163,184,.14);border-radius:.35rem;background:rgba(7,12,20,.82);color:#a7f3d0;font:.9em ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.ai-kv-grid{display:grid;gap:0;margin:8px 0 12px;border:1px solid rgba(148,163,184,.14);border-radius:12px;overflow:hidden;background:rgba(7,12,20,.52)}',
    '.ai-kv-row{display:grid;grid-template-columns:minmax(120px,.7fr) minmax(0,1fr);gap:14px;padding:8px 11px;border-bottom:1px solid rgba(148,163,184,.1)}',
    '.ai-kv-row:last-child{border-bottom:0}.ai-kv-row dt{color:#8fa3ba;font-size:.78rem}.ai-kv-row dd{margin:0;color:#edf4fc;font-weight:650;text-align:right}',
    '.ai-table-wrap{max-width:100%;overflow:auto;margin:8px 0 12px;border:1px solid rgba(148,163,184,.14);border-radius:12px}',
    '.ai-table-wrap table{width:100%;min-width:0;border-collapse:collapse}.ai-table-wrap th,.ai-table-wrap td{padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.1);text-align:left}.ai-table-wrap th{font-size:.76rem;color:#a9bdd3;background:rgba(15,23,42,.7)}',
    '.ai-message.ai-assistant,.ai-content.ai-followup{overflow-wrap:anywhere;word-break:normal}',
    '#chatMessages.ai-followup-scroll-region{max-height:min(680px,calc(100dvh - 260px));overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding-right:4px}',
    '#chatMessages.ai-followup-scroll-region::-webkit-scrollbar{width:8px}#chatMessages.ai-followup-scroll-region::-webkit-scrollbar-thumb{background:rgba(100,116,139,.4);border-radius:999px}',
    '@media(max-width:640px){.ai-rich-text{max-width:100%;font-size:.92rem}.ai-kv-row{grid-template-columns:1fr;gap:2px}.ai-kv-row dd{text-align:left}#chatMessages.ai-followup-scroll-region{max-height:62dvh}}',
    '@media(prefers-reduced-motion:reduce){.ai-rich-text *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}'
  ].join('');
  document.head.appendChild(style);

  window.AutoCuanAI = {
    version: '20260727-premium-v2',
    renderMarkdown: renderMarkdown,
    friendlyText: normalizeLines,
    structureLongProse: normalizeLines,
    polishNode: polishNode
  };

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
