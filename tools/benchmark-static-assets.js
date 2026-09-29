'use strict';
// Isolated loopback asset measurements. No production API/login requests.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const {createStaticResponder}=require('../lib/static-assets');
async function main(){
 const serve=createStaticResponder({rootDir:path.join(__dirname,'../public'),mimeTypes:{'.html':'text/html','.css':'text/css','.js':'application/javascript','.mjs':'application/javascript'}});
 const server=http.createServer(async(req,res)=>{if(!await serve(req,res,req.url)){res.statusCode=404;res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const get=(file,headers={})=>new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:server.address().port,path:'/'+file,headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.setTimeout(10000,()=>req.destroy(new Error('Loopback timeout')));req.on('error',reject);});
 try{const files=[];for(const file of ['index.html','ui-theme.css','money-sheet-runtime.js','vendor/number-flow-0.6.2/index.mjs']){
  const raw=await get(file),gz=await get(file,{'accept-encoding':'gzip'}),br=await get(file,{'accept-encoding':'br'});assert.equal(raw.status,200);assert.deepEqual(zlib.gunzipSync(gz.body),raw.body);assert.deepEqual(zlib.brotliDecompressSync(br.body),raw.body);
  const repeated=await get(file,{'accept-encoding':'br'});assert.deepEqual(repeated.body,br.body);
  const revalidated=br.headers.etag?await get(file,{'if-none-match':br.headers.etag}):null;if(revalidated){assert.equal(revalidated.status,304);assert.equal(revalidated.body.length,0);}
  files.push({file,raw_bytes:raw.body.length,gzip_bytes:gz.body.length,brotli_bytes:br.body.length,brotli_reduction_pct:Math.round(1000*(1-br.body.length/raw.body.length))/10,conditional_status:revalidated&&revalidated.status});
 }
 const result={scope:'Loopback response sizes, not measured VPS improvement, LCP, INP or real mobile latency.',files,cache:serve.stats()};console.log(JSON.stringify(result,null,2));
 if(process.env.PRECISION_TEST_OUTPUT){fs.mkdirSync(process.env.PRECISION_TEST_OUTPUT,{recursive:true});fs.writeFileSync(path.join(process.env.PRECISION_TEST_OUTPUT,'asset-transfer.json'),JSON.stringify(result,null,2));}
 }finally{await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
