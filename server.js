const http = require('http');
const fs = require('fs');
const path = require('path');
const api = require('./api/index.js');

const PORT = process.env.PORT || 8090;
const HOST = process.env.HOST || '0.0.0.0';

function sendFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api')) return api(req, res);
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/' || pathname === '/index.html') return sendFile(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
  const file = path.join(__dirname, pathname.replace(/^\/+/, ''));
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
  const ext = path.extname(file).toLowerCase();
  const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.wasm':'application/wasm', '.png':'image/png', '.jpg':'image/jpeg', '.gif':'image/gif' };
  sendFile(res, file, types[ext] || 'application/octet-stream');
}).listen(PORT, HOST, () => console.log(`IPTV Expert Player running: http://localhost:${PORT}`));
