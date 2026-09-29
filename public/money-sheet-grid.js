/* Spreadsheet interaction controller. No financial persistence or auth logic here. */
(function(root) {
  'use strict';
  if (root.AutoCuanMoneySheetGrid) return;
  const M=root.AutoCuanMoneySheetModel, doc=root.document;
  root.AutoCuanMoneySheetGrid={ create(api) {
    const page=doc.getElementById('page-money-management'), table=doc.getElementById('mmCashflowSpreadsheetTable');
    const $=id=>doc.getElementById(id), address=$('mmCellAddress'), bar=$('mmFormulaInput'), status=$('mmSelectionStats');
    let anchor=null, end=null, hold=false, dragging=false, moved=false, barDirty=false, dragColumn=null;
    const widths=[44,148,146,248,160,250,44];
    const rows=()=>api.rows();
    const same=(a,b)=>a&&b&&a.id===b.id&&a.col===b.col;
    const cell=element=>{ const input=element.closest('[data-col]'), tr=input&&input.closest('[data-row-id]'); return tr?{id:tr.dataset.rowId,col:Number(input.dataset.col)}:null; };
    function range() {
      const current=rows(), a=current.findIndex(r=>anchor&&r.id===anchor.id), b=current.findIndex(r=>end&&r.id===end.id);
      if(a<0||b<0)return [];
      const out=[];
      for(let r=Math.min(a,b);r<=Math.max(a,b);r++)for(let c=Math.min(anchor.col,end.col);c<=Math.max(anchor.col,end.col);c++)out.push({id:current[r].id,col:c});
      return out;
    }
    function label(p) { const s=api.sheet(); return p&&s?String.fromCharCode(65+p.col)+(s.rows.findIndex(r=>r.id===p.id)+1):''; }
    function raw(p) { const s=api.sheet(), row=s&&s.rows.find(r=>r.id===p.id); if(!row)return ''; const field=M.FIELDS[p.col]; const input=table.querySelector('[data-row-id="'+p.id+'"] [data-col="'+p.col+'"]'); if(input&&input.getAttribute('aria-invalid')==='true') return input.value; return field==='amount' ? row.formula||String(row.amount) : field==='type'?M.TYPE_LABELS[row.type]:row[field]; }
    function paint() {
      const chosen=range(), keys=new Set(chosen.map(p=>p.id+':'+p.col));
      table.querySelectorAll('tbody [data-col]').forEach(input=>{const p=cell(input), td=input.parentElement, selected=keys.has(p.id+':'+p.col);td.classList.toggle('ms-selected',selected);td.classList.toggle('ms-active-cell',same(p,end));td.setAttribute('aria-selected',String(selected));});
      if(doc.activeElement!==address) address.value=label(anchor)+(anchor&&!same(anchor,end)?':'+label(end):'');
      bar.disabled=!end; if(doc.activeElement!==bar){bar.value=end?raw(end):'';barDirty=false;}
      bar.setAttribute('aria-label','Nilai atau rumus sel '+(label(end)||'aktif'));
      let count=0,sum=0;
      const data=api.sheet(), amounts=new Map(data?data.rows.map(r=>[r.id,r.amount]):[]);
      chosen.forEach(p=>{if(p.col===3&&amounts.has(p.id)){sum+=amounts.get(p.id);count++;}});
      status.textContent=chosen.length?chosen.length+' sel dipilih'+(count?' \u00b7 Jumlah Rp '+sum.toLocaleString('id-ID')+' \u00b7 Rata-rata Rp '+(sum/count).toLocaleString('id-ID',{maximumFractionDigits:2}):''):'Pilih sel untuk mengedit';
      ['mmCopyCells','mmClearCells','mmInsertRow','mmDeleteRows','mmFillDown'].forEach(id=>{if($(id))$(id).disabled=!chosen.length;});
      $('mmFillDown').disabled=chosen.length<2||!anchor||anchor.id===end.id;
    }
    function select(a,b,focus) {anchor=a;end=b||a;if(focus&&end){hold=true;api.focus(end.id,end.col);hold=false;}paint();}
    function refresh() {
      const current=rows();
      if(!anchor||!current.some(r=>r.id===anchor.id)||!end||!current.some(r=>r.id===end.id)) anchor=end=current.length?{id:current[0].id,col:0}:null;
      paint();
    }
    function quoted(text) {return /[\t\r\n"]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;}
    function copyText() {
      const cells=range(), lines=[];let rowId=null,line=[];
      cells.forEach(p=>{if(rowId!==p.id){if(line.length)lines.push(line.join('\t'));line=[];rowId=p.id;}let text=raw(p);if(p.col!==3&&/^[\s\uFEFF]*[=+\-@]/.test(text))text="'"+text;line.push(quoted(text));});
      if(line.length)lines.push(line.join('\t'));return lines.join('\r\n');
    }
    function fallbackCopy(text) {
      const input=doc.createElement('textarea');input.value=text;input.setAttribute('aria-label','Salinan rentang');input.style.cssText='position:fixed;left:-9999px;top:0';page.appendChild(input);input.focus();input.select();
      let copied=false;try{copied=doc.execCommand('copy');}catch(_){}input.remove();if(end)api.focus(end.id,end.col);return copied;
    }
    async function copy() {
      const text=copyText();if(!text)return;
      try{if(root.navigator.clipboard&&root.isSecureContext)await root.navigator.clipboard.writeText(text);else if(!fallbackCopy(text))throw new Error('clipboard');api.notice('Rentang disalin. Tempel dengan Ctrl+V atau Cmd+V.');}
      catch(_){api.notice('Browser tidak mengizinkan salin otomatis. Gunakan Ctrl+C / Cmd+C pada rentang yang dipilih.','error');}
    }
    function clear() {api.cells(range().map(p=>({...p,value:p.col===0?'expense':p.col===3?'0':''})));paint();}
    function fillDown() {
      const selected=range();if(!anchor||anchor.id===end.id)return;
      const source=selected[0].id, data=api.sheet();const origin=data.rows.findIndex(r=>r.id===source);
      const changes=selected.filter(p=>p.id!==source).map(p=>{let value=raw({id:source,col:p.col});if(p.col===3&&value[0]==='='){const delta=data.rows.findIndex(r=>r.id===p.id)-origin;value=value.replace(/\bD([1-9]\d*)\b/gi,(_,n)=>'D'+(Number(n)+delta));}return {...p,value};});
      api.cells(changes);paint();
    }
    function applyBar() {if(!barDirty||!end)return;api.cell(end.id,end.col,bar.value);barDirty=false;paint();}
    bar.addEventListener('input',()=>{barDirty=true;});
    bar.addEventListener('change',applyBar);
    bar.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();applyBar();if(end)api.focus(end.id,end.col);}if(event.key==='Escape'){barDirty=false;bar.value=raw(end);if(end)api.focus(end.id,end.col);}});
    address.addEventListener('keydown',event=>{if(event.key!=='Enter')return;event.preventDefault();const match=/^([A-E])([1-9]\d*)(?::([A-E])([1-9]\d*))?$/i.exec(address.value.trim());const s=api.sheet();if(!match||!s)return api.notice('Alamat harus A1 sampai E'+(s?s.rows.length:0)+', atau rentang seperti D1:D4.','error');const a=s.rows[Number(match[2])-1],b=s.rows[Number(match[4]||match[2])-1];if(!a||!b)return api.notice('Baris alamat tersebut belum ada.','error');if(!rows().some(r=>r.id===a.id)||!rows().some(r=>r.id===b.id))return api.notice('Alamat tersebut tersembunyi oleh pencarian. Hapus pencarian dahulu.','error');select({id:a.id,col:match[1].toUpperCase().charCodeAt(0)-65},{id:b.id,col:(match[3]||match[1]).toUpperCase().charCodeAt(0)-65},true);});
    table.addEventListener('focusin',event=>{const p=cell(event.target);if(p&&!hold&&!dragging)select(p);});
    table.addEventListener('pointerdown',event=>{
      if(event.button!==0||event.target.closest('.ms-resizer'))return;
      const p=cell(event.target);if(!p)return;
      if(event.shiftKey&&anchor){event.preventDefault();select(anchor,p,true);return;}
      if(event.pointerType==='mouse'){select(p);dragging=true;moved=false;}
    });
    table.addEventListener('pointerover',event=>{if(!dragging||!(event.buttons&1))return;const p=cell(event.target);if(p&&!same(p,end)){moved=true;select(anchor,p);}});
    doc.addEventListener('pointerup',()=>{if(dragging&&moved&&end){hold=true;api.focus(end.id,end.col);hold=false;paint();}dragging=false;dragColumn=null;});
    table.addEventListener('copy',event=>{const input=event.target;const hasText=input.selectionStart!=null&&input.selectionStart!==input.selectionEnd;if((range().length>1||!hasText)&&event.clipboardData){event.preventDefault();event.clipboardData.setData('text/plain',copyText());}});
    page.addEventListener('keydown',event=>{
      if(event.defaultPrevented||event.isComposing)return;
      const p=cell(event.target), ctrl=event.ctrlKey||event.metaKey;
      if(event.key==='Escape'&&page.classList.contains('ms-expanded')){event.preventDefault();toggleExpand(false);return;}
      if(!p)return;
      if(ctrl&&event.key.toLowerCase()==='d'){event.preventDefault();fillDown();return;}
      if(event.key==='F2'){event.preventDefault();bar.focus();bar.select();return;}
      if((event.key==='Delete'||event.key==='Backspace')&&range().length>1){event.preventDefault();clear();return;}
      if(event.key==='Escape'&&range().length>1){event.preventDefault();select(end);return;}
      if(ctrl&&event.key.toLowerCase()==='a'){event.preventDefault();const list=rows();select({id:list[0].id,col:0},{id:list[list.length-1].id,col:4},false);return;}
      const list=rows();let r=list.findIndex(row=>row.id===(end||p).id),c=(end||p).col;
      if(event.shiftKey&&['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)){
        event.preventDefault();r+=event.key==='ArrowDown'?1:event.key==='ArrowUp'?-1:0;c+=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0;
        select(anchor||p,{id:list[Math.max(0,Math.min(list.length-1,r))].id,col:Math.max(0,Math.min(4,c))},true);
      }else if(ctrl&&(event.key==='Home'||event.key==='End')){event.preventDefault();const to={id:list[event.key==='Home'?0:list.length-1].id,col:event.key==='Home'?0:4};select(event.shiftKey?anchor||p:to,to,true);}
    });
    function setWidth(index,width) {
      widths[index]=Math.max(96,Math.min(640,Math.round(width)));const cols=table.querySelectorAll('col');cols[index].style.width=widths[index]+'px';
      table.style.width=widths.reduce((a,b)=>a+b,0)+'px';table.style.minWidth=table.style.width;
      table.querySelector('[data-resize="'+index+'"]').setAttribute('aria-valuenow',String(widths[index]));
    }
    table.querySelectorAll('thead th').forEach((th,index)=>{
      if(index<1||index>5)return;
      const button=doc.createElement('button');button.type='button';button.className='ms-column-select';button.innerHTML=th.innerHTML;button.setAttribute('aria-label','Pilih kolom '+String.fromCharCode(64+index));th.replaceChildren(button);
      button.addEventListener('click',()=>{const list=rows();if(list.length)select({id:list[0].id,col:index-1},{id:list[list.length-1].id,col:index-1},false);});
      const handle=doc.createElement('button');handle.type='button';handle.className='ms-resizer';handle.dataset.resize=String(index);handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label','Lebar kolom '+String.fromCharCode(64+index));handle.setAttribute('aria-valuemin','96');handle.setAttribute('aria-valuemax','640');handle.setAttribute('aria-valuenow',String(widths[index]));th.appendChild(handle);
      handle.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();setWidth(index,widths[index]+(e.key==='ArrowLeft'?-1:1)*(e.shiftKey?40:8));});
      handle.addEventListener('pointerdown',e=>{e.preventDefault();dragColumn={index,x:e.clientX,width:widths[index]};handle.setPointerCapture(e.pointerId);});
      handle.addEventListener('pointermove',e=>{if(dragColumn&&dragColumn.index===index)setWidth(index,dragColumn.width+e.clientX-dragColumn.x);});
      handle.addEventListener('lostpointercapture',()=>{dragColumn=null;});
      handle.addEventListener('dblclick',()=>{let length=String.fromCharCode(64+index).length;rows().forEach(row=>{length=Math.max(length,String(row[M.FIELDS[index-1]]).length);});setWidth(index,Math.min(480,length*8+36));});
    });
    table.addEventListener('click',event=>{const button=event.target.closest('[data-select-row]');if(button)select({id:button.dataset.selectRow,col:0},{id:button.dataset.selectRow,col:4},false);});
    function toggleExpand(force) {const expanded=force==null?!page.classList.contains('ms-expanded'):force;page.classList.toggle('ms-expanded',expanded);$('mmExpandSheet').setAttribute('aria-pressed',String(expanded));$('mmExpandSheet').textContent=expanded?'Kembali ke ringkasan':'Fokus lembar';}
    $('mmExpandSheet').addEventListener('click',()=>toggleExpand());
    $('mmCopyCells').addEventListener('click',copy);$('mmClearCells').addEventListener('click',clear);$('mmFillDown').addEventListener('click',fillDown);
    $('mmInsertRow').addEventListener('click',()=>{if(end)api.insert(end.id);});
    $('mmDeleteRows').addEventListener('click',()=>{const ids=Array.from(new Set(range().map(p=>p.id)));if(ids.length&&root.confirm('Hapus '+ids.length+' baris yang dipilih? Perubahan bisa diurungkan.'))api.remove(ids);});
    return {refresh,reset(){anchor=end=null;bar.value='';barDirty=false;toggleExpand(false);paint();},paint};
  }};
})(window);
