'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const apiHandler = require('./api/index.js');
const PORT = Number(process.env.PORT || 8090);
const root = __dirname;
const types = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.wasm':'application/wasm','.gif':'image/gif','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
function sendFile(res, file){
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not found')}
    res.writeHead(200,{'Content-Type':types[path.extname(file).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(data);
  });
}
http.createServer((req,res)=>{
  try{
    const u = new URL(req.url,'http://localhost');
    if(u.pathname==='/api') return apiHandler(req,res);
    let pathname = decodeURIComponent(u.pathname);
    if(pathname==='/' || pathname==='') pathname='/index.html';
    const file = path.normalize(path.join(root, pathname));
    if(!file.startsWith(root)) {res.writeHead(403); return res.end('Forbidden')}
    sendFile(res,file);
  }catch(e){res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});res.end(e.message)}
}).listen(PORT,'0.0.0.0',()=>{
  console.log('IPTV Expert custom player running: http://localhost:'+PORT);
  console.log('Example: http://localhost:'+PORT+'/?id=550');
});
