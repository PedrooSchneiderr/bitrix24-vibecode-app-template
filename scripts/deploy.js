#!/usr/bin/env node
'use strict';

/**
 * Deploy one-shot + publicação no Bitrix24 (fluxo validado na plataforma Alaio Vibecode).
 *
 * NÃO roda sozinho: não há hook de npm nem CI chamando este arquivo. Ele só
 * executa com a flag explícita --confirm, e a chave vem de variável de ambiente.
 *
 *   VIBE_API_KEY=... node scripts/deploy.js --confirm
 *
 * Etapas:
 *   1. Empacota o app em .tar.gz (com o id do servidor no favicon, se já existir)
 *   2. POST /v1/infra/servers           one-shot: runtime node24 + source + env
 *   3. GET  /v1/infra/servers/:id       poll até running + blackhole CONNECTED
 *   4. POST /v1/infra/servers/:id/icon  sem ícone o deploy fica "NOT complete"
 *   5. POST /v1/apps                    cria o app (retorna a chave vibe_app_ UMA vez)
 *   6. GET  /v1/oauth/authorize + poll  usuário do portal autoriza no navegador
 *   7. POST /v1/apps/:id/publish        com sourceServerId (sem ele: SNAPSHOT_REQUIRED)
 *
 * Depois de qualquer redeploy, confira GET /v1/infra/servers: redeploy em servidor
 * hibernando pode criar um servidor duplicado em vez de atualizar o existente.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const BASE = process.env.VIBE_API_BASE || 'https://vibecode.bitrix24.com/v1';
const API_KEY = process.env.VIBE_API_KEY;
const APP_NAME = process.env.APP_NAME || 'funil-template';
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, { body, headers = {}, raw } = {}) {
  const res = await fetch(BASE + p, {
    method,
    redirect: 'manual',
    headers: { 'X-Api-Key': API_KEY, ...(raw ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json?.error || json)}`);
  return json && 'data' in json ? json.data : json;
}

function pack(serverId) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pack-'));
  for (const item of ['package.json', 'src', 'public']) {
    fs.cpSync(path.join(ROOT, item), path.join(tmp, item), { recursive: true });
  }
  if (serverId) {
    const index = path.join(tmp, 'public', 'index.html');
    fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replaceAll('__SERVER_ID__', serverId));
  }
  const out = path.join(ROOT, `${APP_NAME}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', tmp, '.']);
  fs.rmSync(tmp, { recursive: true, force: true });
  return fs.readFileSync(out).toString('base64');
}

async function waitRunning(serverId) {
  for (let i = 0; i < 60; i++) {
    const s = await api('GET', `/infra/servers/${serverId}`);
    const status = String(s.status || '').toLowerCase();
    const bh = String(s.blackholeStatus || '').toUpperCase();
    console.log(`  status=${status} blackhole=${bh}`);
    if (status === 'running' && bh === 'CONNECTED') return s;
    if (status === 'failed' || status === 'error') throw new Error('Deploy falhou: ' + JSON.stringify(s));
    await sleep(10_000);
  }
  throw new Error('Timeout esperando o servidor ficar running/CONNECTED');
}

async function main() {
  if (!process.argv.includes('--confirm')) {
    console.log('Dry-run: nada foi enviado. Rode com --confirm para executar o deploy real.');
    return;
  }
  if (!API_KEY) throw new Error('Defina VIBE_API_KEY no ambiente (nunca no código).');

  console.log('1-2. Empacotando e criando servidor (one-shot)…');
  const server = await api('POST', '/infra/servers', {
    body: {
      name: APP_NAME,
      displayName: 'Funil de Negócios',
      description: 'Dashboard de funil embarcado no CRM',
      runtime: 'node24', // node20 está depreciado
      start: 'npm start',
      source: { content: pack(null) },
      // A plataforma não injeta chave no app; redeploy sem `env` apaga estas variáveis.
      env: {
        VIBE_API_KEY: process.env.APP_RUNTIME_API_KEY || API_KEY,
        ...(process.env.APP_RUNTIME_APP_KEY ? { VIBE_APP_KEY: process.env.APP_RUNTIME_APP_KEY } : {}),
      },
    },
  });
  const serverId = server.id || server.serverId;
  if (server.reused) console.warn('  Atenção: reused=true (uma chave = um slot de app). Usou o servidor existente.');
  console.log(`  serverId=${serverId}`);

  console.log('3. Aguardando running/CONNECTED…');
  const ready = await waitRunning(serverId);
  const appUrl = ready.appUrl || `https://${serverId}.vibecode.bitrix24.com`;

  console.log('4. Enviando ícone…');
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(path.join(ROOT, 'public', 'icon.svg'))], { type: 'image/svg+xml' }), 'icon.svg');
  await api('POST', `/infra/servers/${serverId}/icon`, { raw: form });

  console.log('5. Criando app…');
  const app = await api('POST', '/apps', {
    body: { title: 'Funil de Negócios', scopes: ['crm', 'user', 'placement'], appUrl },
  });
  // rawKey (vibe_app_) aparece uma única vez: guarde num cofre, nunca no repo/log.
  if (app.rawKey) console.log('  Chave do app gerada (não exibida). Salve-a no seu cofre de segredos agora.');

  console.log('6. Autorização OAuth…');
  const state = crypto.randomBytes(16).toString('hex');
  const authorizeUrl = `${BASE}/oauth/authorize?app_key=${encodeURIComponent(app.rawKey)}&state=${state}`;
  console.log(`  Abra no navegador (aba normal, logado no portal):\n  ${authorizeUrl}`);
  for (let i = 0; ; i++) {
    const poll = await api('GET', `/oauth/poll?app_key=${encodeURIComponent(app.rawKey)}&state=${state}`);
    if (poll.status === 'complete') break;
    if (i >= 60) throw new Error('Timeout aguardando autorização OAuth');
    await sleep(5_000);
  }

  console.log('7. Publicando no menu/CRM…');
  await api('POST', `/apps/${app.id}/publish`, { body: { sourceServerId: serverId } });

  console.log('8. Conferindo duplicatas…');
  const servers = await api('GET', '/infra/servers');
  const same = (Array.isArray(servers) ? servers : servers.items || []).filter((s) => s.name === APP_NAME);
  if (same.length > 1) console.warn(`  ${same.length} servidores com o nome ${APP_NAME}: revise e remova o duplicado.`);

  console.log(`Pronto. App em ${appUrl} (accessPolicy padrão: OWNER_ONLY).`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
