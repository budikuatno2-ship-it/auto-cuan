'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync(
  'public/index.html',
  'utf8'
);

test(
  'Day Trade tabs separate Signal Radar and Hindari',
  () => {
    assert.match(
      html,
      />Signal<\/button>/
    );

    assert.match(
      html,
      />Radar Prioritas<\/button>/
    );

    assert.match(
      html,
      />Radar Aktif<\/button>/
    );

    assert.match(
      html,
      />Hindari<\/button>/
    );

    assert.match(
      html,
      /peluang dapat bergerak lebih dulu/
    );
  }
);

test(
  'semantic labels preserve early opportunities',
  () => {
    assert.match(
      html,
      /SIGNAL TERKONFIRMASI/
    );

    assert.match(
      html,
      /RADAR PRIORITAS — PRE-SPIKE/
    );

    assert.match(
      html,
      /RADAR AWAL — PELUANG BERKEMBANG/
    );

    assert.match(
      html,
      /RADAR PULLBACK — TUNGGU AREA/
    );

    assert.match(
      html,
      /RADAR SPEKULATIF — RISIKO TINGGI/
    );
  }
);

test(
  'only confirmed Day Trade statuses use confirmed helper',
  () => {
    assert.match(
      html,
      /function isDayTradeConfirmedSignalStatus/
    );

    assert.match(
      html,
      /s === 'A_PLUS_SETUP'/
    );

    assert.match(
      html,
      /s === 'TRADE_CANDIDATE'/
    );

    assert.match(
      html,
      /s === 'READY_BREAKOUT'/
    );

    const cardStart = html.indexOf(
      'function renderDtCardGrid'
    );

    const cardEnd = html.indexOf(
      '// Delegated click',
      cardStart
    );

    const cardBody =
      html.slice(cardStart, cardEnd);

    assert.match(
      cardBody,
      /getDayTradeStatusColor/
    );

    assert.match(
      cardBody,
      /getDayTradeSemanticLabel/
    );

    assert.doesNotMatch(
      cardBody,
      /st === 'READY_BREAKOUT' \|\| st === 'PRE_SPIKE_WATCH'/
    );
  }
);

test(
  'help text explains speed versus confirmation tradeoff',
  () => {
    assert.match(
      html,
      /Peluang dapat bergerak lebih dulu/
    );

    assert.match(
      html,
      /lebih tinggi daripada Signal Terkonfirmasi/
    );

    assert.match(
      html,
      /Setup masih berpotensi/
    );
  }
);
