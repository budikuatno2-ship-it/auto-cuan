(function () {
  'use strict';

  var access = window.__AUTOCUAN_PORTFOLIO_ACCESS__ || {};
  var uid = String(access.userId || localStorage.getItem('autocuan_user_id') || '').trim();
  if (!uid) return;

  var chatKey = 'autocuan_portfolio_ai_chat_' + uid;
  var migrationKey = 'autocuan_portfolio_ai_recovery_v1_' + uid;
  var legacyError = /permintaan ai ditolak provider|periksa konfigurasi model|model yang sempat dicoba sedang gangguan|model yang dicoba sedang gangguan|semua model sedang gangguan|asisten ai portofolio belum aktif|provider menolak permintaan|traffic ramai\. coba lagi sebentar/i;

  function cleanStoredChat() {
    try {
      var rows = JSON.parse(localStorage.getItem(chatKey) || '[]');
      if (!Array.isArray(rows)) rows = [];
      var cleaned = [];
      var removed = false;

      rows.forEach(function (row) {
        var role = row && row.role;
        var content = String(row && row.content || '');
        if (role === 'assistant' && legacyError.test(content)) {
          removed = true;
          if (cleaned.length && cleaned[cleaned.length - 1].role === 'user') cleaned.pop();
          return;
        }
        if (role === 'user' || role === 'assistant') cleaned.push({ role: role, content: content });
      });

      if (removed || !localStorage.getItem(migrationKey)) {
        localStorage.setItem(chatKey, JSON.stringify(cleaned.slice(-20)));
        localStorage.setItem(migrationKey, String(Date.now()));
      }
    } catch (_) {
      try {
        localStorage.removeItem(chatKey);
        localStorage.setItem(migrationKey, String(Date.now()));
      } catch (_) {}
    }
  }

  function addLayoutFixes() {
    if (document.getElementById('portfolioAiRecoveryStyles')) return;
    var style = document.createElement('style');
    style.id = 'portfolioAiRecoveryStyles';
    style.textContent = [
      '#p-ai .ai-chat{min-height:560px;display:flex;flex-direction:column}',
      '#p-ai .ai-messages{flex:1;min-height:280px;max-height:52vh;overflow:auto;padding-right:4px;scrollbar-gutter:stable}',
      '#p-ai .ai-compose{position:sticky;bottom:0;z-index:4;padding-top:12px;background:linear-gradient(180deg,rgba(17,23,34,0),#111722 22%)}',
      '#p-ai .ai-compose textarea{min-height:74px;max-height:180px;resize:vertical}',
      '#p-ai .ai-status{padding-bottom:4px}',
      '@media(max-width:760px){#p-ai .ai-chat{min-height:520px}#p-ai .ai-messages{max-height:48vh;min-height:240px}#p-ai .ai-compose{position:static}}'
    ].join('');
    document.head.appendChild(style);
  }

  cleanStoredChat();
  addLayoutFixes();
})();
