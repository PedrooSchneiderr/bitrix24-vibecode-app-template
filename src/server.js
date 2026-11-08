'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { getFunnel } = require('./funnel');
const { read, VibeError } = require('./vibeClient');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

/**
 * Identidade vem SÓ dos headers injetados pelo Gateway Black Hole.
 * Nunca de query string, body ou cookie controlado pelo navegador.
 */
function identity(req) {
  const rawUserId = req.headers['x-vibe-user-id'] || null;
  return {
    session: req.headers['x-vibe-authorization'] || null, // fica no backend, nunca vai pro navegador
    // Visitante não-portal pode vir com id prefixado: só repassa ao Bitrix24 se for numérico.
    userId: rawUserId && /^\d+$/.test(rawUserId) ? rawUserId : null,
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function sendError(res, e) {
  if (e instanceof VibeError) {
    console.error(`[vibe] ${e.status} ${e.code}: ${e.message}`);
    return sendJson(res, e.status, {
      error: { kind: e.kind, code: e.code, userMessage: e.userMessage || 'Não foi possível carregar os dados.' },
    });
  }
  console.error('[app]', e);
  sendJson(res, 500, { error: { kind: 'error', code: 'INTERNAL', userMessage: 'Erro interno do app.' } });
}

async function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 404, { error: 'not found' });
  try {
    const content = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

const routes = {
  'GET /api/health': async () => ({ ok: true }),

  'GET /api/me': async (req) => {
    const { session, userId } = identity(req);
    const me = await read('GET', '/me', { session });
    return { userId, name: me?.user?.name || null };
  },

  'GET /api/funnel': async (req, url) => {
    const { session } = identity(req);
    return getFunnel({ categoryId: url.searchParams.get('categoryId') || 0, session });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(req, res);
    return sendJson(res, 404, { error: 'not found' });
  }
  try {
    sendJson(res, 200, await handler(req, url));
  } catch (e) {
    sendError(res, e);
  }
});

server.listen(PORT, () => console.log(`App ouvindo na porta ${PORT}`));
