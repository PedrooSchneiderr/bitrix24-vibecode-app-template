'use strict';

// O frontend não tem chave nem sessão: só fala com o próprio backend (/api/*).

const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const STATE_TEXT = {
  loading: 'Carregando…',
  empty: 'Nenhum negócio nesta pipeline ainda.',
  forbidden: 'Você não tem permissão para ver estes negócios.',
  session_expired: 'Sua sessão expirou. Recarregue a página para entrar novamente.',
};

function showState(kind, message) {
  const el = $('state');
  el.className = kind === 'forbidden' || kind === 'session_expired' || kind === 'error' ? 'error' : '';
  el.textContent = message || STATE_TEXT[kind] || 'Não foi possível carregar os dados.';
}

function render(data) {
  const list = $('funnel');
  list.replaceChildren();
  const max = Math.max(1, ...data.stages.map((s) => s.count));

  for (const s of data.stages) {
    const li = document.createElement('li');
    li.className = 'stage' + (s.semantics === 'S' ? ' won' : '') + (s.count === 0 ? ' empty' : '');
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = s.name;
    const val = document.createElement('span');
    val.textContent = `${s.count} · ${money.format(s.sum)}`;
    row.append(name, val);
    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = `${(s.count / max) * 100}%`;
    track.append(fill);
    li.append(row, track);
    list.append(li);
  }

  const summary = $('summary');
  summary.hidden = false;
  summary.textContent = `${data.total} negócios · ${data.won} ganhos · conversão ${(data.winRate * 100).toFixed(1)}%`;
  showState(data.total === 0 ? 'empty' : 'ok', data.total === 0 ? undefined : '');
}

async function load() {
  showState('loading');
  $('summary').hidden = true;
  try {
    const res = await fetch(`/api/funnel?categoryId=${encodeURIComponent($('category').value || 0)}`);
    const body = await res.json();
    if (!res.ok) {
      $('funnel').replaceChildren();
      const err = body.error || {};
      // Sessão e permissão têm texto fixo; demais erros usam o userMessage da API.
      return showState(err.kind, STATE_TEXT[err.kind] || err.userMessage);
    }
    render(body);
  } catch {
    showState('error', 'Falha de conexão com o app.');
  }
}

$('category').addEventListener('change', load);
load();
