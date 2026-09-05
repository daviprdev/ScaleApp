/**
 * Rotas do Session/Credential Manager (módulo 8): onboarding OAuth de conta,
 * consulta do estado da sessão e carga do secret do Meta App no cofre.
 *
 * Nenhuma rota devolve segredo. O que sai daqui é referência (`vault://…`),
 * status e expiração; o token em si nunca deixa o cofre a não ser dentro do
 * driver, no momento da requisição.
 *
 * Sem `SECRETS_KEYS` no ambiente não há cofre, e todas estas rotas respondem
 * 503 — melhor recusar do que gravar credencial em claro.
 */

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { InstagramOAuthClient, UndiciHttpClient } from "@scaleapp/driver-graph";
import { PoolProxyResolver } from "@scaleapp/proxy";
import {
  AccountLoginService,
  Keyring,
  LoginError,
  OAuthStateError,
  PostgresSecretVault,
  SessionRepository,
  computeSessionStatus,
  loadSessionConfig,
} from "@scaleapp/session";

export interface SessionRoutesConfig {
  /** URI de callback registrada no Meta App (OAUTH_REDIRECT_URI). */
  readonly redirectUri: string;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: SessionRoutesConfig,
): void {
  const keyring = Keyring.fromEnv();
  const sessionConfig = loadSessionConfig();
  const sessions = new SessionRepository(pool);

  if (!keyring) {
    app.log.warn("SECRETS_KEYS ausente — rotas de sessão respondem 503 (cofre indisponível)");
  }

  const vault = keyring ? new PostgresSecretVault(pool, keyring) : null;
  const login =
    keyring && vault
      ? new AccountLoginService({
          pool,
          vault,
          keyring,
          exchange: new InstagramOAuthClient(new UndiciHttpClient()),
          // Pool real (módulo 9): sem proxy dedicado vivo, o login não sai.
          proxies: new PoolProxyResolver(pool, vault, { cacheTtlMs: 0 }),
          redirectUri: config.redirectUri,
        })
      : null;

  /** Guarda: sem cofre configurado, nada de fluxo de credencial. */
  const vaultUnavailable = { error: "cofre indisponível: defina SECRETS_KEYS no ambiente" };

  // Passo 1 do login: URL de autorização para a conta.
  app.post<{ Params: { id: string } }>("/accounts/:id/session/authorize-url", async (req, reply) => {
    if (!login) return reply.code(503).send(vaultUnavailable);
    try {
      const start = await login.startAuthorization(req.params.id);
      return { url: start.url, expiresInMs: start.expiresInMs };
    } catch (err) {
      if (err instanceof LoginError) {
        return reply.code(err.code === "ACCOUNT_NOT_FOUND" ? 404 : 400).send({ error: err.message });
      }
      throw err;
    }
  });

  // Passo 2: callback do OAuth. A Meta redireciona o navegador para cá.
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    "/auth/instagram/callback",
    async (req, reply) => {
      if (!login) return reply.code(503).send(vaultUnavailable);

      const { code, state, error, error_description: description } = req.query;
      if (error) {
        // Usuário negou ou a Meta recusou: não é erro nosso, mas precisa aparecer.
        return reply.code(400).send({ error, description: description ?? null });
      }
      if (!code || !state) {
        return reply.code(400).send({ error: "callback sem code/state" });
      }

      try {
        const result = await login.completeAuthorization({ code, state });
        // Sem token e sem referência na resposta — só o que identifica a conta.
        return {
          accountId: result.accountId,
          igUserId: result.igUserId,
          username: result.username,
          expiresAt: result.expiresAt,
        };
      } catch (err) {
        if (err instanceof OAuthStateError) {
          return reply.code(400).send({ error: `state inválido: ${err.message}` });
        }
        if (err instanceof LoginError) {
          const status = err.code === "ACCOUNT_NOT_FOUND" ? 404 : 409;
          return reply.code(status).send({ error: err.message, code: err.code });
        }
        req.log.error({ err }, "falha ao completar autorização");
        return reply.code(502).send({ error: "troca OAuth falhou" });
      }
    },
  );

  // Estado da sessão da conta (o painel e o operador leem daqui).
  app.get<{ Params: { id: string } }>("/accounts/:id/session", async (req, reply) => {
    const snapshot = await sessions.getSnapshot(req.params.id);
    if (!snapshot) return reply.code(404).send({ error: "conta não encontrada" });
    return {
      ...snapshot,
      // Status derivado da expiração — o persistido pode estar defasado entre
      // duas varreduras.
      derivedStatus: computeSessionStatus(snapshot.expiresAt, sessionConfig.expiringWindowMs),
    };
  });

  // Carga do secret do Meta App no cofre (BYOC): sem isto o login não completa,
  // porque a troca de código exige o client_secret do App da conta.
  app.put<{ Params: { id: string }; Body: { secret: string } }>(
    "/meta-apps/:id/secret",
    {
      schema: {
        body: {
          type: "object",
          required: ["secret"],
          additionalProperties: false,
          properties: { secret: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      if (!vault) return reply.code(503).send(vaultUnavailable);

      const current = await pool.query<{ secret_ref: string }>(
        `SELECT secret_ref FROM meta_apps WHERE id = $1`,
        [req.params.id],
      );
      const row = current.rows[0];
      if (!row) return reply.code(404).send({ error: "Meta App não encontrado" });

      // Reescreve a linha do cofre quando já existe uma referência — assim o
      // ponteiro guardado no Meta App continua válido e não sobra segredo órfão.
      if (await vault.replace(row.secret_ref, req.body.secret)) {
        return { metaAppId: req.params.id, secretRef: row.secret_ref, rotated: true };
      }

      const secretRef = await vault.put("meta_app_secret", req.body.secret);
      await pool.query(`UPDATE meta_apps SET secret_ref = $2 WHERE id = $1`, [
        req.params.id,
        secretRef,
      ]);
      return { metaAppId: req.params.id, secretRef, rotated: false };
    },
  );
}
