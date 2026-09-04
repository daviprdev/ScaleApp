/**
 * Tradução de falha da Graph API para `OperationError` do domínio. É aqui que as
 * regras 2 e 3 viram código:
 *  - Regra 2: outage de plataforma (5xx, códigos transitórios) NÃO é falha de
 *    conta — vira `PlatformOutage`, não `AccountError`. A decisão de disparar
 *    cascata (limiar % + contagem mínima) é de outro módulo; aqui só
 *    classificamos certo para não envenenar essa decisão.
 *  - Regra 3: checkpoint de segurança (precisa de login/verificação manual) é
 *    distinto de token morto (precisa de novo fluxo de auth). Mapeamos os
 *    subcódigos do erro 190 para `CheckpointRequired` vs `TokenDead`.
 *
 * `retryable` é ortogonal à classe: rate limit e outage retentam com backoff;
 * checkpoint e token morto, não (retry não remedia — só espalha o erro).
 */

import { FailureClass } from "@scaleapp/domain";
import type { IsoTimestamp, OperationError } from "@scaleapp/domain";
import { HttpTransportError } from "./httpClient.js";

/** Formato do erro da Graph API dentro do corpo da resposta. */
export interface GraphErrorBody {
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
    readonly code?: number;
    readonly error_subcode?: number;
    readonly fbtrace_id?: string;
  };
}

function now(): IsoTimestamp {
  return new Date().toISOString() as IsoTimestamp;
}

function err(
  failureClass: FailureClass,
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): OperationError {
  return {
    failureClass,
    code,
    message,
    retryable,
    occurredAt: now(),
    ...(details ? { details } : {}),
  };
}

// Subcódigos do erro 190 (OAuthException) que significam ação MANUAL do humano
// dono da conta (checkpoint/verificação/senha) — regra 3, ramo CheckpointRequired.
const CHECKPOINT_SUBCODES = new Set<number>([
  459, // usuário precisa refazer login (checkpoint)
  460, // senha alterada — sessão invalidada
  464, // usuário não confirmado / verificação pendente
]);

// Códigos de rate limit da Graph API (por app, usuário, página e custom/IG).
const RATE_LIMIT_CODES = new Set<number>([4, 17, 32, 613, 80001, 80002, 80003, 80004]);

/**
 * Mapeia uma resposta HTTP de erro (status + corpo) para `OperationError`.
 * `viaProxy` não se aplica aqui (é uma resposta HTTP, não falha de transporte).
 */
export function mapHttpError(status: number, body: string): OperationError {
  let parsed: GraphErrorBody = {};
  try {
    parsed = JSON.parse(body) as GraphErrorBody;
  } catch {
    // Corpo não-JSON (ex.: página de erro do proxy/gateway).
  }
  const g = parsed.error;
  const code = g?.code;
  const subcode = g?.error_subcode;
  const message = g?.message ?? `HTTP ${status}`;
  const details: Record<string, unknown> = {
    httpStatus: status,
    ...(code !== undefined ? { graphCode: code } : {}),
    ...(subcode !== undefined ? { graphSubcode: subcode } : {}),
    ...(g?.fbtrace_id ? { fbtraceId: g.fbtrace_id } : {}),
  };
  const c = (fc: FailureClass, retryable: boolean): OperationError =>
    err(fc, code !== undefined ? `GRAPH_${code}` : `HTTP_${status}`, message, retryable, details);

  // Erro 190: problemas de token/sessão — checkpoint vs token morto (regra 3).
  if (code === 190) {
    if (subcode !== undefined && CHECKPOINT_SUBCODES.has(subcode)) {
      return c(FailureClass.CheckpointRequired, false);
    }
    return c(FailureClass.TokenDead, false);
  }

  // Rate limit — retryável com backoff (regra 5 governa o stagger).
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) {
    return c(FailureClass.RateLimited, true);
  }
  if (status === 429) {
    return c(FailureClass.RateLimited, true);
  }

  // Bloqueio de ação por política (não é login checkpoint, mas exige atenção).
  if (code === 368) {
    return c(FailureClass.AccountError, false);
  }

  // Permissões insuficientes / parâmetro inválido — não adianta retentar.
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) {
    return c(FailureClass.AccountError, false);
  }
  if (code === 100) {
    return c(FailureClass.InvalidInput, false);
  }

  // Transitórios da plataforma: código 1/2 ou 5xx — NÃO culpar a conta (regra 2).
  if (code === 1 || code === 2 || status >= 500) {
    return c(FailureClass.PlatformOutage, true);
  }

  return c(FailureClass.Unknown, false);
}

/** Mapeia uma falha de transporte (conexão/timeout) para `OperationError`. */
export function mapTransportError(e: HttpTransportError): OperationError {
  // Toda chamada em nome de conta sai por proxy (regra 10): falha de conexão
  // com proxy presente é, por padrão, problema de proxy — remediação distinta.
  const failureClass = e.viaProxy ? FailureClass.ProxyError : FailureClass.Network;
  return err(failureClass, `TRANSPORT_${e.code}`, e.message, true, { transportCode: e.code });
}

/** Erro de pré-condição local (contexto incompleto) — nunca retryável. */
export function preconditionError(code: string, message: string): OperationError {
  return err(FailureClass.InvalidInput, code, message, false);
}

/** Referência de token não resolveu para um token — remediação: novo auth (regra 3). */
export function tokenUnresolved(): OperationError {
  return err(
    FailureClass.TokenDead,
    "CRED_UNRESOLVED",
    "referência de token não resolveu para um token de acesso",
    false,
  );
}

/**
 * Proxy dedicado indisponível. Regra 10: nunca sair pelo IP da infraestrutura —
 * sem proxy, a operação falha (retryável: o pool pode reatribuir).
 */
export function proxyUnavailable(): OperationError {
  return err(
    FailureClass.ProxyError,
    "PROXY_UNAVAILABLE",
    "proxy dedicado indisponível para a conta",
    true,
  );
}

/** Container de vídeo terminou em erro/expiração no lado do Instagram. */
export function containerError(statusCode: string, retryable: boolean): OperationError {
  const fc = retryable ? FailureClass.PlatformOutage : FailureClass.AccountError;
  return err(fc, `CONTAINER_${statusCode}`, `container terminou em ${statusCode}`, retryable);
}
