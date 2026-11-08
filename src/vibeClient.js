'use strict';

// Cliente da Entity API do Vibecode. Roda SOMENTE no backend: é o único lugar
// do app que conhece a chave.

const BASE_URL = process.env.VIBE_API_BASE || 'https://vibecode.bitrix24.com/v1';
const MAX_RETRIES = 3;

// Códigos que garantidamente não chegaram ao Bitrix24 -> retry seguro.
const SAFE_RETRY_CODES = new Set(['RATE_LIMITED', 'QUEUE_OVERFLOW', 'QUEUE_TIMEOUT']);

class VibeError extends Error {
  constructor(status, body) {
    const err = (body && body.error) || {};
    super(err.message || `HTTP ${status}`);
    this.status = status;
    this.code = err.code || 'UNKNOWN';
    this.userMessage = err.userMessage || null;
    this.hint = err.hint || null;
    this.retryAfter = Number(err.retryAfter) || null;
  }

  // Categoria usada pelo frontend para escolher o estado da tela.
  get kind() {
    if (this.status === 401) return 'session_expired';
    if (this.status === 403) return 'forbidden';
    if (this.status === 429) return 'rate_limited';
    if (this.status === 502 || this.status === 503) return 'unavailable';
    return 'error';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt, retryAfterSec) {
  if (retryAfterSec) return retryAfterSec * 1000;
  const base = 500 * 2 ** attempt;
  return base + Math.floor(Math.random() * base); // jitter
}

/**
 * Monta os headers de autenticação.
 * - Com sessão do Gateway (app embarcado): chave vibe_app_ + Bearer da sessão,
 *   a chamada roda com as permissões do usuário logado.
 * - Sem sessão: chave vibe_api_ do dono (uso OWNER_ONLY / jobs internos).
 */
function authHeaders(session) {
  if (session && process.env.VIBE_APP_KEY) {
    return { 'X-Api-Key': process.env.VIBE_APP_KEY, Authorization: session };
  }
  if (!process.env.VIBE_API_KEY) throw new Error('VIBE_API_KEY não configurada');
  return { 'X-Api-Key': process.env.VIBE_API_KEY };
}

async function rawRequest(method, path, { body, session } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders(session) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.success === false)) throw new VibeError(res.status, json);
  return json && 'data' in json ? json.data : json;
}

/**
 * Leitura (GET ou POST de consulta, ex.: /search, /aggregate): idempotente,
 * faz retry com backoff só nos 429 seguros. 502 não entra em loop.
 */
async function read(method, path, opts) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rawRequest(method, path, opts);
    } catch (e) {
      const retriable = e instanceof VibeError && e.status === 429 && SAFE_RETRY_CODES.has(e.code);
      if (!retriable || attempt >= MAX_RETRIES) throw e;
      await sleep(backoff(attempt, e.retryAfter));
    }
  }
}

/**
 * Escrita: em 503 BITRIX_TIMEOUT a operação PODE ter sido aplicada.
 * `verify()` re-lê o estado; só reenvia se a escrita não aconteceu.
 */
async function write(method, path, opts, verify) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rawRequest(method, path, opts);
    } catch (e) {
      if (!(e instanceof VibeError) || attempt >= MAX_RETRIES) throw e;
      if (e.status === 429 && SAFE_RETRY_CODES.has(e.code)) {
        await sleep(backoff(attempt, e.retryAfter));
        continue;
      }
      if (e.status === 503 && e.code === 'BITRIX_TIMEOUT' && verify) {
        await sleep(backoff(attempt));
        const applied = await verify();
        if (applied) return applied;
        continue;
      }
      throw e;
    }
  }
}

module.exports = { read, write, VibeError };
