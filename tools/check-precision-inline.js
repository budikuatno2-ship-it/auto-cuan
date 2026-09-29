'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

// CI syntax scanner for repository-owned markup, NOT an HTML sanitizer.
// Closing tags may contain stray attributes (CodeQL review #90). Do not
// silently skip those script bodies; compile them just like canonical tags.
function checkInlineScripts(html) {
  const blocks = /<script(?=[\t\n\f\r />])((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/script(?=[\t\n\f\r />])[^>]*>/gi;
  let count = 0;
  for (const match of String(html).matchAll(blocks)) {
    if (/\bsrc\s*=|application\/(?:ld\+)?json/i.test(match[1]) || !match[2].trim()) continue;
    // Compilation only: never execute repository JavaScript in this check.
    new vm.Script(match[2], { filename: 'index-inline-' + (++count) });
  }
  return count;
}

function verifyScannerContract() {
  for (const end of ['</script>', '</ScRiPt>', '</script\t\n bar>', '</script foo="bar">', '</script/>']) {
    assert.equal(checkInlineScripts('<script>const n = 1;' + end), 1);
    assert.throws(() => checkInlineScripts('<script>const = ;' + end), SyntaxError);
  }
  assert.equal(checkInlineScripts('<script data-label="a > b">const n = 1;</script>'), 1);
  assert.equal(checkInlineScripts('<script>const a = 1;</script><script>const b = 2;</script>'), 2);
  assert.equal(checkInlineScripts('<script src="app.js">ignored syntax</script>'), 0);
  assert.equal(checkInlineScripts('<script type="application/ld+json">{"name":"test"}</script>'), 0);
  assert.equal(checkInlineScripts('<script> \n </script>'), 0);
  assert.equal(checkInlineScripts('<scriptx>not JavaScript</scriptx>'), 0);
  assert.equal(checkInlineScripts('<script>throw new Error("must not execute");</script>'), 1);
}

if (require.main === module) {
  verifyScannerContract();
  const count = checkInlineScripts(fs.readFileSync('public/index.html', 'utf8'));
  console.log(count + ' inline JavaScript blocks parsed.');
}
module.exports = { checkInlineScripts, verifyScannerContract };
