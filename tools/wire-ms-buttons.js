const fs = require('fs');

function wireMsButtons(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(
    '<a class="btn p" id="msDetailAnalisisBtn"',
    '<a class="btn p" id="msDetailAnalisisBtn" onclick="if(window.AutoCuanMarketStructure){window.AutoCuanMarketStructure.bukaAnalisisSaham();return false;}"'
  );
  content = content.replace(
    '<button type="button" id="marketStructureGoToChartBtn" class="btn sm" style="display:none">Buka Chart</button>',
    '<button type="button" id="marketStructureGoToChartBtn" class="btn sm" onclick="if(window.AutoCuanMarketStructure){window.AutoCuanMarketStructure.bukaAnalisisSaham();return false;}" style="display:none">Buka Chart</button>'
  );
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Wired ms buttons in', filePath);
}

wireMsButtons('public/index.html');
wireMsButtons('public/partials/analisis-saham.partial.html');
