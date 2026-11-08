# bitrix24-vibecode-app-template

Template de app Node.js (runtime `node24`) para a plataforma **Alaio Vibecode** (vibecode.bitrix24.com), a plataforma de apps de IA do Bitrix24. Ele cobre o ciclo completo: backend BFF seguro, deploy em servidor Black Hole/Galaxy, publicação no menu do Bitrix24 e consumo da Entity API.

O exemplo é um **mini dashboard de funil de negócios**: etapas lidas da API (nunca fixas no código), contagem e valor por etapa, taxa de ganho e estados de tela para "sem dados", "erro", "sem permissão" e "sessão expirada".

## Arquitetura

```
 Navegador (iframe no Bitrix24)
        │  só chama /api/* do próprio app, sem chave nem sessão
        ▼
 Gateway Black Hole ── autentica o usuário e injeta headers X-Vibe-*
        │
        ▼
 Backend BFF (src/server.js) ── único que segura a chave
        │  X-Api-Key + Authorization: <sessão do usuário>
        ▼
 Entity API do Vibecode (/v1/statuses, /v1/deals/aggregate, /v1/me)
        │
        ▼
 Portal Bitrix24 (seu-portal.bitrix24.com)
```

| Arquivo | Papel |
|---|---|
| `src/server.js` | HTTP sem dependências: rotas `/api/*`, identidade só dos headers `X-Vibe-*`, arquivos estáticos |
| `src/vibeClient.js` | Cliente da Entity API com o mapa oficial de erros e retries |
| `src/funnel.js` | Monta o funil: `/v1/statuses` + `/v1/deals/aggregate`, etapas vazias com zero, ganho = `semantics: "S"` |
| `public/` | Frontend estático (HTML/CSS/JS puro) |
| `scripts/deploy.js` | Deploy one-shot + OAuth + publish (só roda com `--confirm`) |

## Tratamento de erros

| Resposta da API | Comportamento |
|---|---|
| `429 RATE_LIMITED` / `QUEUE_OVERFLOW` / `QUEUE_TIMEOUT` | Não chegou ao Bitrix24: retry com backoff + jitter, respeitando `retryAfter` |
| `502 BITRIX_UNAVAILABLE` | Mensagem na tela, sem retry infinito |
| `503 BITRIX_TIMEOUT` | Uma escrita pode ter sido aplicada: **re-lê antes** de tentar de novo (`write(..., verify)`) |
| `403 BITRIX_ACCESS_DENIED` | Estado "sem permissão" |
| `401 KEY_EXPIRED` / `TOKEN_MISSING` / `INVALID_SESSION` | Estado "sessão expirada" |

O texto mostrado ao usuário vem de `error.userMessage`, que a própria API devolve.

## Checklist de segurança

- [ ] **BFF**: a chave fica só no backend, em variável de ambiente. O frontend nunca vê chave nem `vibe_session_*`.
- [ ] **Identidade só do Gateway**: usuário lido de `X-Vibe-*`, nunca de query/body. `X-Vibe-User-Id` só é repassado se for numérico.
- [ ] **`accessPolicy: OWNER_ONLY`** (padrão). Abrir para `PORTAL`/`AUTHENTICATED` é decisão consciente, nunca automática.
- [ ] **Black Hole** ligado (padrão): servidor sem porta aberta na internet.
- [ ] **Chave READONLY** sempre que o app só lê. (READONLY bloqueia criar infraestrutura: faça o deploy com uma chave de escrita e use a READONLY no runtime.)
- [ ] **Nunca chave pessoal em app multiusuário**: com vários usuários, use a chave `vibe_app_` + sessão do usuário, para cada um enxergar só o que a permissão dele permite.
- [ ] `.env` fora do git; chave rotacionada se aparecer em log, print ou chat.
- [ ] Auditoria de segurança feita em sessão separada de quem escreveu o código.

## Rodando local

```bash
cp .env.example .env   # preencha as chaves
node --env-file=.env src/server.js
# http://localhost:3000
```

Local não existe Gateway, então as chamadas usam a `VIBE_API_KEY`.

## Deploy passo a passo

1. Gere uma chave `vibe_api_` no painel do Vibecode **logado no portal certo** (a chave fica presa ao portal ativo na hora da criação).
2. Rode o dry-run: `node scripts/deploy.js` (não envia nada).
3. Deploy real: `VIBE_API_KEY=<SUA_CHAVE> node scripts/deploy.js --confirm`. O script:
   1. empacota `package.json`, `src/` e `public/` em `.tar.gz`;
   2. `POST /v1/infra/servers` one-shot com `runtime: "node24"`, `source` e `env`;
   3. faz poll até `running` + `blackholeStatus: CONNECTED`;
   4. envia o ícone SVG (`/icon`);
   5. `POST /v1/apps` (devolve a chave `vibe_app_` uma única vez);
   6. imprime a URL de `/v1/oauth/authorize`: abra numa aba normal, logado no portal; o script faz poll até `complete`;
   7. `POST /v1/apps/:id/publish` com `{ "sourceServerId": "<SERVER_ID>" }`;
   8. lista os servidores para detectar duplicata.
4. O app aparece no menu lateral do Bitrix24. Para teste headless, gere um token temporário em `POST /v1/infra/servers/<SERVER_ID>/access-tokens` (`mode: "api-bearer"`).

## Gotchas reais

- A chave **mascarada** exibida no painel (ex.: `vibe_app_xxx...xxxx`) não funciona na API. Use o botão de copiar.
- **Redeploy em servidor hibernando pode criar um servidor duplicado** em vez de atualizar. Sempre confira `GET /v1/infra/servers` depois.
- `node20` está depreciado: use `node24`. Sem `runtime` o install falha com `npm: not found`.
- `publish` sem `sourceServerId` falha com `SNAPSHOT_REQUIRED`.
- Uma chave = um slot de app: um segundo create com a mesma chave devolve `reused: true`. Cada app precisa da própria chave.
- Redeploy sem `env` apaga as variáveis de ambiente do app.
- A sessão `vibe_session_` dura 24h sem renovação automática: não serve para job em background (use `vibe_api_`).
- No máximo 2 deploys inline simultâneos na plataforma (`429 DEPLOY_BACKEND_BUSY`, tente de novo em 30s).
- `Access Denied` num app levado para outro portal costuma ser campo/etapa/departamento fixo no código que não existe lá, não problema de autenticação. Por isso este template lê etapas da API.

## Autor

**Pedro Schneider**, engenheiro de integrações Bitrix24.
[LinkedIn](https://www.linkedin.com/in/pedro-schneider-6b372518b/)

Licença MIT.
