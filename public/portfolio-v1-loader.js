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
    '/runtime-parts/portfolio-v1-runtime.part10.txt?v=1',
  ];
  Promise.all(parts.map(function (url) {
    return fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then(function (response) {
      if (!response.ok) throw new Error('Portfolio runtime HTTP ' + response.status);
      return response.text();
    });
  })).then(function (chunks) {
    var script = document.createElement('script');
    script.setAttribute('data-portfolio-v1-runtime', 'true');
    script.text = chunks.join('');
    document.head.appendChild(script);
  }).catch(function (error) {
    console.error('[Portfolio V1] runtime gagal dimuat', error);
    var content = document.getElementById('portofolioContent');
    if (content) content.innerHTML = '<div class=\"portfolio-card p-4 text-sm text-red-300\">Portfolio V1 gagal dimuat. Muat ulang halaman.</div>';
  });
})(window);
