import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json' };
export async function serveWeb(directory) {
  const root = await realpath(directory);
  const server = http.createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = resolve(root, `.${path}`);
      if (file !== root && !file.startsWith(root + sep)) return res.writeHead(403).end();
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      file = await realpath(file);
      if (!file.startsWith(root + sep)) return res.writeHead(403).end();
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file).toLowerCase()] ?? 'application/octet-stream' }).end(data);
    } catch {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (/^\/(?:cart|orders(?:\/[^/.]+)?|account|login)\/?$/.test(path)) {
        try { return res.writeHead(200, { 'Content-Type': mime['.html'] }).end(await readFile(resolve(root, 'index.html'))); } catch { /* No export. */ }
      }
      res.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
