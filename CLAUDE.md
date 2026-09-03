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

1. **Contratos do domínio** — `Account`, `Job`, `Pipeline`, `Execution`,
   `AutomationDriver`, `ContentSource`. _(próxima fase)_
2. Infra base: Postgres + Redis + API mínima de contas via Docker Compose.
3. Fila + worker skeleton com driver mock.
4. Orquestração de pipeline: sequência, idempotência, retry, dead-letter.
5. Observabilidade básica (logs estruturados + Prometheus/Grafana).
6. Driver Graph API real, cobrindo operações do fluxo core.
7. Validação em pequena escala antes de paralelizar.
8. Driver Playwright pro que a API não cobre (Destaques etc.).
9. Content Acquisition Driver (contas dedicadas de scraping).
10. Escala horizontal de workers.
11. Painel admin.
12. Backups e hardening antes de operar as 500 contas em produção real.

---

## Notas de manutenção deste arquivo

Mantenha este arquivo atualizado conforme decisões novas forem fechadas —
ele é a fonte da verdade do projeto, lida automaticamente em toda sessão.
Registre decisões e o motivo (não só o "o quê"), do mesmo jeito que as
seções acima. Não documente bugs/fixes individuais aqui — isso é histórico
de manutenção, não vai virar changelog gigante como no projeto anterior.
