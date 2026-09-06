# CLAUDE.md — ScaleApp

Este arquivo é lido automaticamente pelo Claude Code em toda conversa neste
repositório. Contém a visão, as decisões arquiteturais fechadas e o estado
atual do projeto. É a base pra qualquer trabalho de implementação daqui pra
frente — antes de gerar código, releia este arquivo.

---

## Visão geral

**Nome:** ScaleApp
**Dono:** Davi Pereira (`daviprdev`)
**Objetivo:** plataforma privada de automação em escala para múltiplas contas
Instagram, hospedada em infraestrutura própria (VPS). Uso pessoal / 1–3
operadores de confiança — **não é um SaaS multi-tenant comercial**. O eixo de
"escala" é volume de contas operadas em paralelo com confiabilidade, não
número de usuários.

**Meta de volume:** ~500 contas processadas por dia.

Este projeto **não herda arquitetura, decisões técnicas nem código de nenhum
projeto anterior** (incluindo o AutoScale, produto antigo do mesmo dono). O
AutoScale foi usado só como fonte de requisitos funcionais e de lições
operacionais reais — nunca como referência de como construir.

---

## Arquitetura

Duas responsabilidades separadas por um contrato explícito, porque mudam em
ritmos diferentes:

- **Control Plane** — regras de negócio, estado, histórico. Estável, muda
  pouco. Não conhece Playwright, proxies, seletores de UI ou SDK do
  Instagram — só conhece contas, jobs e resultados.
- **Execution Plane** — onde a automação de fato acontece contra o
  Instagram. Instável, muda toda vez que a plataforma externa muda algo.
  Isolado atrás de uma porta (`AutomationDriver`).

Um job nasce no Control Plane, é publicado numa fila, e só vira ação real
dentro de um worker do Execution Plane, através de um driver. O núcleo nunca
importa Playwright, Appium ou SDK do Instagram diretamente.

### Módulos

1. **Account Registry** — cadastro de contas: credenciais, sessão, proxy
   associado, tags/grupos, status de saúde, prioridade de failover, qual
   Meta App usa.
2. **Pipeline Definition** — descreve *o quê* deve acontecer numa conta, sem
   saber como.
3. **Orchestrator** — converte pipeline em jobs concretos; controla
   sequência, estado, condicionais.
4. **AutomationDriver (porta)** — contrato comum entre os dois planos.
5. **Drivers concretos** — Graph API (primário), Playwright (secundário),
   Content Acquisition (scraping via contas dedicadas).
6. **Queue & Worker Pool** — filas segmentadas por classe de driver, workers
   horizontalmente escaláveis.
7. **Scheduler** — disparo recorrente e por evento.
8. **Session/Credential Manager** — login, tokens, criptografia em repouso,
   refresh preventivo.
9. **Proxy/Network Manager** — proxy dedicado por conta, pool com
   atribuição/liberação, health check.
10. **Observability Stack** — logs estruturados, métricas, alertas.
11. **Admin Panel** — painel in-app: contas, jobs, status, notificações.

---

## Stack

| Camada | Escolha | Motivo |
|---|---|---|
| Core / API | TypeScript + Node.js | Tipagem forte no contrato entre planos; ecossistema maduro pra filas e automação. |
| Banco | PostgreSQL self-hosted na VPS | Sob controle próprio, sem depender de BaaS. JSONB pra payload de job, `SELECT FOR UPDATE SKIP LOCKED` pra locking de conta. |
| Fila | Redis + BullMQ | Retry/backoff, prioridade, rate-limit por fila, jobs repetíveis (scheduler). |
| Driver primário | **Graph API oficial** (Instagram Login API, contas Business/Creator) | Validado em produção real pelo AutoScale rodando dezenas/centenas de contas simultâneas. Mais estável e previsível que UI automation. |
| Driver secundário | Playwright | Só pro que a API não cobre (ex.: Destaques, que a Graph API nunca suportou). |
| Content Acquisition | Contas dedicadas autenticadas (não Apify) | Apify não pega conteúdo privado nem lista completa. Usa a mesma infraestrutura de conta+proxy do driver de postagem, só que pra leitura. |
| Observabilidade | Prometheus + Loki + Grafana | Leve o suficiente pra VPS única. |
| Infra | Docker Compose · Hetzner Cloud | Melhor custo por vCPU/RAM pra paralelizar automação; sem necessidade de KVM no v1. |

---

## Decisões fechadas

- **Driver primário = Graph API oficial.** Estratégia: contas convertidas
  pra Business/Creator, cadastradas via Instagram Login API. Playwright só
  cobre o que a API não suporta.
- **Múltiplos Meta Apps (BYOC) desde o v1** — não é opcional. Rate-limit da
  Graph API é por App; com 500 contas num único App, quedas em cascata
  artificiais são praticamente garantidas (lição direta do AutoScale).
  Contas devem ser distribuídas entre vários Apps.
- **Fingerprint/anti-detecção de vídeo:** deliberadamente em aberto.
  Primeira versão sem nenhum reencode automático por padrão — o histórico do
  AutoScale mostra que reencode automático em todo post derruba alcance
  (Instagram penaliza qualidade degradada / dupla compressão). Qualquer
  efeito de variação (hue, ruído, velocidade) deve ser **opt-in manual por
  pipeline**, nunca automático. Estratégia definitiva fica pra iterar com
  dados reais do sistema rodando.
- **VPS única no v1** (Hetzner Cloud), sem automação de dispositivo/emulador
  no v1.
- **Proxy dedicado por conta**, obrigatório, não opcional — pool com
  atribuição automática e verificação de saúde.
- **Warmup de conta nova** entra implementado de verdade desde o início
  (no AutoScale foi projetado mas nunca funcionou de fato — bug de anos
  nunca detectado).
- **Cofre próprio no Postgres, não serviço externo** (módulo 8). Segredo
  (token, senha, secret de Meta App, credencial de proxy) é cifrado na
  aplicação com AES-256-GCM e guardado na tabela `secrets`; o resto do sistema
  só manuseia a referência `vault://<uuid>`. A chave vive no ambiente
  (`SECRETS_KEYS`), nunca no banco — um dump sozinho não expõe nada. Keyring
  versionado (`key_id` por linha) para rotacionar chave em lotes limitados sem
  reescrever tudo de uma vez. AAD = `id:kind`, então um blob copiado para
  outra linha ou outro tipo de segredo deixa de decifrar.
- **A referência do token é estável através do refresh.** Refrescar reescreve
  a mesma linha do cofre em vez de criar outra: `accounts.access_token_ref`
  não muda, e a gravação do token novo + a nova expiração acontecem na mesma
  transação. Separadas, uma falha no meio deixaria a conta com token velho e
  expiração nova — e ela pararia de ser candidata a refresh, morrendo em
  silêncio.
- **Refresh que não persiste é falha, não sucesso.** O driver Graph exige um
  `tokenSink`; sem ele, `refresh_session` retorna erro em vez de rodar como
  no-op. É a mesma classe de bug do warmup que "existia" e nunca funcionou.
- **Login OAuth sai pelo proxy dedicado da conta**, como qualquer outra
  requisição em nome dela (regras 7 e 10). Fazer o login pelo IP da VPS e só
  depois operar por proxy é justamente o padrão que a Meta correlaciona.
- **Proxy morto e outage do provedor são diagnósticos diferentes** (módulo 9,
  regra 2 aplicada ao pool). A varredura de saúde só declara um proxy `down`
  quando o lote NÃO parece outage; a suspeita de outage exige limiar
  percentual **e** contagem mínima absoluta, porque cada metade sozinha erra:
  só percentual condena o pool inteiro num lote de três, só contagem ignora um
  provedor pequeno caindo. Sob suspeita, todos ficam `degraded` e ninguém é
  aposentado.
- **Trocar o IP de uma conta é decisão cara, não automática.** Falha de proxy
  em job real conta strike e degrada, mas a troca automática (`swapAfterFailures`)
  vem desligada por padrão: conta pulando de IP sozinha é exatamente o padrão
  que a plataforma nota. Quando ligada, o proxy ruim é aposentado, nunca
  devolvido ao pool.
- **O resolver recusa em vez de improvisar.** Proxy `down`/`retired`, ou
  credencial que não está no cofre, resolve para nada — o driver transforma
  isso em `ProxyError` e o job retenta. Não existe caminho "só desta vez pelo
  IP da infra" (regra 10 não tem exceção).
- **IP de saída é observado e comparado.** A checagem grava o IP que o proxy
  apresenta; dois proxies "dedicados" com o mesmo IP são pool rotativo ou
  compartilhado disfarçado, e aparecem num diagnóstico próprio.
- **Biblioteca de mídia: metadados no Postgres, bytes no storage.** Nada de
  `bytea`/large object — um banco com vídeos dentro é impossível de fazer
  backup e todo `SELECT` vira risco de memória. O backend do v1 é
  **filesystem em volume da VPS**, atrás da porta `MediaStorage`: uma VPS só,
  volume local, e o que S3/MinIO trariam de verdade (URL assinada) já é
  resolvido pela própria API. Trocar para S3/MinIO depois é escrever outra
  implementação da porta — sem migration, sem tocar em serviço ou resolver.
- **Conteúdo endereçado por checksum.** A chave de storage é derivada do
  sha256, então bytes idênticos ocupam uma cópia só e gravar duas vezes é
  gravar o mesmo arquivo. A deduplicação é consequência do modelo, não uma
  verificação que alguém pode esquecer de chamar. Duas tabelas: `media_blobs`
  (o conteúdo) e `media_assets` (o item lógico) — o mesmo vídeo em duas pastas
  são dois itens e um arquivo. É isso que faz "story/reel" ser classificação de
  uso, não cópia.
- **Ordem entre banco e storage é decisão, não detalhe.** Na ingestão, bytes
  primeiro: uma falha no meio deixa um objeto órfão (invisível e recolhível),
  enquanto a ordem inversa deixaria uma linha apontando para bytes inexistentes
  — mídia que o pipeline promete publicar e não consegue. Na remoção, banco
  primeiro: a referência some na hora e os bytes viram pendência
  (`pending_delete`) que o coletor termina. Falha parcial vira trabalho
  rastreável, nunca lixo silencioso.
- **A URL da mídia é assinada e expira.** A Graph API baixa o arquivo sozinha,
  então a biblioteca precisa ser alcançável da internet; uma URL adivinhável
  por id exporia o acervo inteiro. HMAC derivado da chave ativa do cofre, com
  validade que cobre o download do lado da Meta.
- **`state` do OAuth assinado, não persistido.** HMAC derivado da chave ativa
  do cofre + validade curta, em vez de tabela de fluxos em aberto: sem estado
  no banco não há linha órfã de fluxo abandonado.

### Escopo funcional confirmado (v1)

Entra:
- Contas: OAuth oficial, pastas/grupos, saúde, failover, múltiplos Meta Apps.
- Proxy dedicado por conta, pool.
- Biblioteca de mídia com pastas.
- Content Acquisition: scraping via contas dedicadas (não Apify).
- Publicação: post único multi-conta, campanha em massa com distribuição
  anti-duplicata entre contas (algoritmo tipo "quadrado latino" — nunca o
  mesmo vídeo em várias contas na mesma janela), loop de repostagem
  contínua por pasta.
- Legendas automáticas (pool de variações, sem repetição óbvia).
- Horário humano (janela de postagem configurável por timezone).
- Stories: postar agora + repostagem via template.
- Warmup automático de conta nova (implementação real).
- Analytics por post (likes, alcance, plays) — **depende de Advanced
  Access da Meta para `instagram_business_manage_insights`**, aprovação
  externa fora do nosso controle; construir o suporte mas não bloquear o
  resto do sistema nisso.
- Observabilidade: dashboard (contas, fila, views), monitor de
  campanha/loop, histórico de failover.

Backlog (não é prioridade do v1):
- Checker de perfis em massa.

Fora de escopo (específico de SaaS multi-cliente, não se aplica a uso
próprio):
- Aprovação manual de usuários, impersonation, painel admin de usuários.
- Webhook de vendas / notificação de lucro diário.

---

## Regras de design (lições operacionais herdadas do AutoScale)

Estas são restrições de arquitetura, não sugestões — cada uma corresponde a
um incidente real de produção documentado no histórico do projeto anterior:

1. **Nunca reencodar vídeo automaticamente por padrão.** Reencode só quando
   o usuário ativa um efeito explicitamente por pipeline.
2. **Distinguir falha de conta individual vs. outage de plataforma** antes
   de marcar contas como erradas. Cascata só deve disparar com limiar
   percentual **e** contagem mínima absoluta — limiar percentual sozinho
   gera falso positivo em lotes pequenos.
3. **Distinguir checkpoint de segurança de token morto.** São remediações
   diferentes; tratar como o mesmo erro trava contas que só precisam de
   login manual.
4. **Claim atômico** (`UPDATE ... WHERE status = ...` ou lock de linha) em
   qualquer job que possa ser processado por duas invocações concorrentes.
   Nunca confiar em fire-and-forget para nada que precise completar.
5. **Stagger/jitter com teto proporcional ao intervalo do ciclo** — nunca
   deixar o atraso inicial de uma conta ultrapassar a janela do próprio
   ciclo (causa "pulo de ciclo" e dobra o intervalo efetivo). Nunca
   despachar todas as contas de um lote ao mesmo tempo (thundering herd →
   rate-limit em cascata).
6. **Refresh de token preventivo**, antes da expiração, não reativo ao erro.
7. **Contas novas**: período de carência sem sync agressivo, cadência baixa,
   sempre via proxy — nunca IP direto da infraestrutura pra requisição em
   nome de uma conta.
8. **Toda query de listagem é paginada/limitada explicitamente.** Nunca
   assumir que "sem `LIMIT`" significa "sem teto" — bancos e APIs podem
   truncar silenciosamente.
9. **Idempotency key em todo job.** Retry nunca deve poder duplicar uma
   ação real (ex.: repostar um story já publicado).
10. **Proxy dedicado por conta, nunca rotativo por padrão** — sessão
    rotacionando o IP no meio de uma operação é uma fonte real de bloqueio.

---

## Roadmap de implementação

1. ✅ **Contratos do domínio** — `Account`, `Job`, `Pipeline`, `Execution`,
   `AutomationDriver`, `ContentSource`. Em `packages/domain`.
2. ✅ Infra base: Postgres + Redis + API mínima de contas via Docker Compose.
   `docker-compose.yml`, `packages/db` (schema versionado, `claim_next_job`,
   `idempotency_key` UNIQUE, proxy dedicado UNIQUE), `apps/api` (Fastify).
3. ✅ Fila + worker skeleton com driver mock. `packages/execution` (BullMQ,
   producer, worker, repos), `packages/driver-mock`, `apps/worker`.
4. ✅ Orquestração de pipeline: sequência, idempotência, retry, dead-letter.
   `packages/orchestrator` (`pipeline_executions`/`pipeline_step_executions`,
   `advance` transacional com `FOR UPDATE`, reusa `packages/execution`).
5. ✅ **Observabilidade básica** (logs estruturados + Prometheus/Grafana/Loki).
   `packages/observability` (registry prom-client, métricas de job/fila/HTTP,
   servidor `/metrics`), API e worker instrumentados, `pino-loki` opt-in via
   `LOKI_URL`. Stack Prometheus+Grafana+Loki+promtail no compose sob o profile
   `observability` (`docker compose --profile observability up -d`); datasources
   e dashboard "ScaleApp — Visão geral" provisionados. Grafana em
   `localhost:3001` (admin/admin por padrão). API expõe `/metrics` na
   `API_PORT`; worker na `WORKER_METRICS_PORT` (9101).
6. ✅ **Driver Graph API real, cobrindo operações do fluxo core.**
   `packages/driver-graph` implementa a porta `AutomationDriver` para
   `graph_api`: publish_media (container→publish, com polling de vídeo e
   carrossel), publish_story, fetch_insights, refresh_session, warmup_action.
   Não cobre Destaques nem aquisição (`supports()` false → registry roteia a
   outro driver). Toda I/O passa por **portas injetadas** (HttpClient/Credential/
   Proxy/Media) — os módulos 8/9 e a biblioteca de mídia as implementam depois;
   por ora há stubs de dev (`devResolvers.ts`). Mapeamento de erro Meta →
   `FailureClass` (regras 2 e 3: 190/subcódigos → Checkpoint vs TokenDead;
   4/17/32/429 → RateLimited; 5xx/1/2 → PlatformOutage; transporte via proxy →
   ProxyError). Migration `0004` adiciona `accounts.ig_user_id`. Worker usa o
   driver real com `WORKER_GRAPH_DRIVER=1` (mock continua o default). Validado
   com HttpClient fake (13 testes); **ainda não posta de verdade** — falta
   credenciais Meta + módulos 8/9 + biblioteca de mídia (ver passo 7).
7. **Validação em pequena escala antes de paralelizar.** _(fase atual — exige
   credenciais Meta reais; é aqui que o driver Graph faz a primeira postagem)_

   ✅ **Módulo 8 — Session/Credential Manager** já implementado, e com ele o
   driver Graph deixou de depender de stub para credencial.
   `packages/session`: cofre (`PostgresSecretVault` + `Keyring` AES-256-GCM,
   migration `0005`), `VaultCredentialResolver`/`VaultTokenSink` implementando
   as portas do driver, `SessionRepository` com as transições de sessão
   (checkpoint ≠ token morto, regra 3), refresh preventivo
   (`planPreventiveRefresh` + varredura `SESSION_SWEEP_ENABLED`, com lote
   limitado, stagger dentro do ciclo e chave de idempotência derivada da
   expiração vigente) e `AccountLoginService` (OAuth). A troca OAuth em si
   vive em `driver-graph/oauth.ts` — é conhecimento da plataforma — e entra
   no Control Plane pela porta `OAuthTokenExchange`. API ganhou
   `POST /accounts/:id/session/authorize-url`,
   `GET /auth/instagram/callback`, `GET /accounts/:id/session` e
   `PUT /meta-apps/:id/secret` (carga do secret do App no cofre). Validado com
   fakes (34 testes) e com um smoke contra Postgres/Redis reais — cofre,
   varredura de refresh, rotação de token pelo sink e transições de sessão;
   **ainda não exercitado contra a Meta real.**

   ✅ **Módulo 9 — Proxy/Network Manager** também implementado.
   `packages/proxy` (migration `0006`): `ProxyRepository` (claim atômico com
   `FOR UPDATE SKIP LOCKED`, listagens limitadas), `ProxyAssignmentService`
   (troca de proxy da conta numa transação, reserva para conta nova,
   reconciliação dos dois lados do vínculo), `PoolProxyResolver` — o resolver
   real que substituiu o `DbAccountProxyResolver` de dev no worker e na API —,
   health check com a distinção proxy morto × outage do provedor, e o
   diagnóstico de IP de saída compartilhado. Varredura opt-in via
   `PROXY_SWEEP_ENABLED`. Rotas: CRUD de pool, `/proxies/:id/check`,
   `/proxies/stats`, `/proxies/reserve`, `/accounts/:id/proxy/swap` e
   `/proxies/diagnostics/shared-exit-ips`. Validado com 32 testes de fake e um
   smoke contra Postgres real (claim concorrente, troca transacional, pool
   esgotado, health check e diagnóstico de IP).

   ✅ **Biblioteca de Mídia** implementada — com ela, o último stub de dev sai
   do caminho do driver. `packages/media` (migration `0007`):
   `media_folders`/`media_blobs`/`media_assets`, `FilesystemMediaStorage` atrás
   da porta `MediaStorage`, `MediaLibrary` (upload, importação por URL, mover,
   renomear, exclusão consistente com coletor de pendências),
   `LibraryMediaResolver` — que substituiu o `UrlMediaResolver` no worker — e
   `MediaServer`, que serve os bytes pela URL assinada. Rotas: pastas, upload
   binário, importação, listagem paginada, detalhe, mover/renomear, excluir,
   `GET /media/:id/raw` (pública, assinada) e GC. Um teste de fiação no worker
   impede a volta do stub. Validado com 14 testes puros (storage, streaming,
   escape de path, assinatura/expiração de URL, fiação do worker); a migration
   `0007` e o `library.test.ts` — que exercita dedup por checksum, mover,
   renomear e exclusão com coletor de pendências contra Postgres real —
   **ainda não foram exercitados**, porque o Docker desta máquina travou.

   Falta para a validação de fato: aplicar a `0007` e rodar o `library.test.ts`
   contra o banco, mais credenciais Meta (App + conta Business/Creator),
   proxies reais cadastrados no pool e mídia real na biblioteca.
8. Driver Playwright pro que a API não cobre (Destaques etc.).
9. Content Acquisition Driver (contas dedicadas de scraping).
10. Escala horizontal de workers.
11. Painel admin.
12. Backups e hardening antes de operar as 500 contas em produção real.

> **Nota de ambiente:** a máquina de desenvolvimento tem **Docker Desktop**
> (backend WSL2). O `docker-compose.yml` foi exercitado de verdade: Postgres
> `16-alpine` + Redis `7-alpine` sobem, as migrations até a `0006` aplicam e os
> módulos 8 e 9 foram validados contra esse banco (a `0007` ainda não rodou). O
> `.env` real (gitignorado) mora na raiz.
>
> Pegadinhas desta máquina, todas já custaram tempo:
> - o `docker` do Docker Desktop instala por usuário em
>   `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin` — se um shell não achar
>   `docker`, recarregue o PATH do registro;
> - existe um **PostgreSQL nativo do Windows** (serviço `postgresql-x64-16`)
>   escutando na 5432. Como o Docker também publica na 5432, a conexão ia parar
>   no Postgres errado e falhava com `28P01 senha falhou`. Por isso o `.env`
>   local usa `POSTGRES_PORT=5433` e `DATABASE_URL` na 5433 — o serviço nativo
>   não foi mexido;
> - **não há binário de `pnpm` no PATH** — ele só existe dentro do corepack.
>   `corepack pnpm <cmd>` não basta: scripts recursivos (`pnpm -r run
>   typecheck`) invocam `pnpm` de novo por pacote e quebram. Use um shim
>   `pnpm.cmd` chamando `node ...\corepack\v1\pnpm\9.15.0\bin\pnpm.cjs %*`;
> - o **WSL2 embaixo do Docker Desktop trava** de tempos em tempos, e o sintoma
>   engana: `docker ps` responde, mas `docker start`/`docker compose` penduram
>   para sempre. Envolva todo comando docker em `timeout`, e não perca tempo
>   atacando o Docker — o remédio é WSL (`wsl --shutdown`, `Restart-Service
>   LxssManager`) e, no fim, reboot.
>
> Os testes de integração (`execution`, `orchestrator`) leem `DATABASE_URL`/
> `REDIS_URL` do `.env` da raiz via `--env-file-if-exists` no script de `test`.

---

## Notas de manutenção deste arquivo

Mantenha este arquivo atualizado conforme decisões novas forem fechadas —
ele é a fonte da verdade do projeto, lida automaticamente em toda sessão.
Registre decisões e o motivo (não só o "o quê"), do mesmo jeito que as
seções acima. Não documente bugs/fixes individuais aqui — isso é histórico
de manutenção, não vai virar changelog gigante como no projeto anterior.
