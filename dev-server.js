import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import handler from './api/index.js';
import { securityHeaders } from './lib/security.js';

export function createDevServer(apiHandler = handler) {
  return http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.startsWith('/api/')) return apiHandler(req, res);
    securityHeaders(res);
    const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/session.js': ['session.js', 'text/javascript'], '/youtube.js': ['youtube.js', 'text/javascript'], '/reflections.js': ['reflections.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/tonearm.svg': ['tonearm.svg', 'image/svg+xml'] };
    assets['/listening-notes.js'] = ['listening-notes.js', 'text/javascript'];
    assets['/lounge.css'] = ['lounge.css', 'text/css'];
    const asset = assets[path];
    if (req.method !== 'GET' || !asset) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    res.end(readFileSync(fileURLToPath(new URL(`./public/${asset[0]}`, import.meta.url))));
  });
}
export const server = createDevServer();
if (process.env.NODE_ENV !== 'test') server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`사이: http://localhost:${server.address().port}`));
