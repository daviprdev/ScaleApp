/**
 * Rotas da Biblioteca de Mídia.
 *
 * Upload é corpo binário puro (`application/octet-stream` ou o próprio MIME do
 * arquivo), não multipart: evita uma dependência a mais e mantém o caminho do
 * arquivo grande simples. Os metadados vêm na query.
 *
 * `GET /media/:id/raw` é a única rota pública do conjunto — é a URL assinada
 * que a Graph API vai acessar para baixar o arquivo. Ela valida assinatura e
 * expiração antes de qualquer consulta.
 */

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  HttpMediaFetcher,
  MediaError,
  MediaLibrary,
  MediaRepository,
  MediaServeError,
  MediaServer,
  ROOT_FOLDER_ID,
  FilesystemMediaStorage,
  isSupportedMime,
  loadMediaConfig,
  type MediaKind,
  type MediaUsage,
  type UrlSigner,
} from "@scaleapp/media";
import { Keyring } from "@scaleapp/session";

const KINDS: MediaKind[] = ["image", "video"];
const USAGES: MediaUsage[] = ["any", "feed", "story", "reel"];

/** MIMEs aceitos no corpo do upload (o parser precisa conhecê-los). */
const UPLOAD_CONTENT_TYPES = [
  "application/octet-stream",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "video/mp4",
  "video/quicktime",
  "video/webm",
];

function mediaErrorStatus(code: string): number {
  switch (code) {
    case "NOT_FOUND":
    case "FOLDER_NOT_FOUND":
      return 404;
    case "DUPLICATE_IN_TARGET":
    case "FOLDER_NOT_EMPTY":
    case "ROOT_FOLDER":
      return 409;
    case "TOO_LARGE":
      return 413;
    default:
      return 400;
  }
}

export function registerMediaRoutes(app: FastifyInstance, pool: Pool): void {
  const config = loadMediaConfig();
  const storage = new FilesystemMediaStorage(config.storageRoot);
  const repo = new MediaRepository(pool);
  const library = new MediaLibrary({
    pool,
    storage,
    fetcher: new HttpMediaFetcher(),
    maxBytes: config.maxBytes,
  });

  // A assinatura das URLs deriva da chave ativa do cofre — a mesma que o worker
  // usa para assinar. Sem cofre não há URL pública verificável, e a rota /raw
  // recusa em vez de servir sem autenticação.
  const keyring = Keyring.fromEnv();
  const signer: UrlSigner | null = keyring
    ? { sign: (data) => keyring.hmac("media-url", data).toString("base64url") }
    : null;
  const server = signer ? new MediaServer({ repo, storage, signer }) : null;
  if (!signer) {
    app.log.warn("SECRETS_KEYS ausente — /media/:id/raw responde 503 (sem URL assinável)");
  }

  app.addContentTypeParser(UPLOAD_CONTENT_TYPES, { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  const handle = async (
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    fn: () => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MediaError) {
        return reply.code(mediaErrorStatus(err.code)).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  };

  // --- pastas ------------------------------------------------------------------

  app.post<{ Body: { name: string; parentId?: string } }>(
    "/media/folders",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            parentId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (req, reply) =>
      handle(reply, async () => {
        const folder = await library.createFolder(req.body.name, req.body.parentId);
        return reply.code(201).send(folder);
      }),
  );

  app.get<{ Querystring: { limit?: number; parentId?: string; rootOnly?: boolean } }>(
    "/media/folders",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
            parentId: { type: "string", format: "uuid" },
            rootOnly: { type: "boolean", default: false },
          },
        },
      },
    },
    async (req) => {
      const limit = req.query.limit ?? 100;
      const parentId = req.query.rootOnly ? null : req.query.parentId;
      const items = await library.listFolders(limit, parentId);
      return { items, limit, rootFolderId: ROOT_FOLDER_ID };
    },
  );

  app.delete<{ Params: { id: string } }>("/media/folders/:id", async (req, reply) =>
    handle(reply, async () => {
      await library.deleteFolder(req.params.id);
      return reply.code(204).send(null);
    }),
  );

  // --- ingestão -----------------------------------------------------------------

  // Corpo binário. `bodyLimit` acompanha o teto da biblioteca: sem isso o
  // Fastify recusaria qualquer vídeo no limite default de 1 MB.
  app.post<{
    Querystring: { name: string; folderId?: string; usage?: MediaUsage };
    Body: Buffer;
  }>(
    "/media/upload",
    {
      bodyLimit: config.maxBytes,
      schema: {
        querystring: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            folderId: { type: "string", format: "uuid" },
            usage: { type: "string", enum: USAGES },
          },
        },
      },
    },
    async (req, reply) =>
      handle(reply, async () => {
        const declared = req.headers["content-type"];
        const result = await library.ingest({
          bytes: req.body,
          name: req.query.name,
          ...(declared && isSupportedMime(declared) ? { mimeType: declared } : {}),
          ...(req.query.folderId ? { folderId: req.query.folderId } : {}),
          ...(req.query.usage ? { usage: req.query.usage } : {}),
          source: "upload",
        });
        return reply.code(result.deduplicated ? 200 : 201).send(result);
      }),
  );

  app.post<{ Body: { url: string; name?: string; folderId?: string; usage?: MediaUsage } }>(
    "/media/import",
    {
      schema: {
        body: {
          type: "object",
          required: ["url"],
          additionalProperties: false,
          properties: {
            url: { type: "string", minLength: 8 },
            name: { type: "string", minLength: 1, maxLength: 200 },
            folderId: { type: "string", format: "uuid" },
            usage: { type: "string", enum: USAGES },
          },
        },
      },
    },
    async (req, reply) =>
      handle(reply, async () => {
        const result = await library.importFromUrl({
          url: req.body.url,
          ...(req.body.name ? { name: req.body.name } : {}),
          ...(req.body.folderId ? { folderId: req.body.folderId } : {}),
          ...(req.body.usage ? { usage: req.body.usage } : {}),
        });
        return reply.code(result.deduplicated ? 200 : 201).send(result);
      }),
  );

  // --- consulta -------------------------------------------------------------------

  app.get<{
    Querystring: {
      limit?: number;
      offset?: number;
      folderId?: string;
      kind?: MediaKind;
      usage?: MediaUsage;
    };
  }>(
    "/media",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
            folderId: { type: "string", format: "uuid" },
            kind: { type: "string", enum: KINDS },
            usage: { type: "string", enum: USAGES },
          },
        },
      },
    },
    async (req) =>
      library.list({
        limit: req.query.limit ?? 50,
        offset: req.query.offset ?? 0,
        ...(req.query.folderId ? { folderId: req.query.folderId } : {}),
        ...(req.query.kind ? { kind: req.query.kind } : {}),
        ...(req.query.usage ? { usage: req.query.usage } : {}),
      }),
  );

  // Bytes: rota pública assinada (é o que a Graph API acessa).
  app.get<{ Params: { id: string }; Querystring: { exp?: string; sig?: string } }>(
    "/media/:id/raw",
    async (req, reply) => {
      if (!server) {
        return reply.code(503).send({ error: "cofre indisponível: defina SECRETS_KEYS" });
      }
      const { exp, sig } = req.query;
      if (!exp || !sig) return reply.code(400).send({ error: "faltam exp/sig" });

      try {
        const opened = await server.open(req.params.id, Number(exp), sig);
        return reply
          .header("content-type", opened.mimeType)
          .header("content-length", String(opened.byteSize))
          .header("cache-control", "private, max-age=300")
          .send(opened.stream);
      } catch (err) {
        if (err instanceof MediaServeError) {
          if (err.reason === "invalid_signature") {
            return reply.code(403).send({ error: err.message });
          }
          if (err.reason === "bytes_missing") {
            req.log.error({ assetId: req.params.id }, err.message);
            return reply.code(410).send({ error: "mídia sem bytes no storage" });
          }
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>("/media/:id", async (req, reply) => {
    const asset = await library.get(req.params.id);
    if (!asset || asset.status === "deleted") {
      return reply.code(404).send({ error: "mídia não encontrada" });
    }
    return asset;
  });

  // --- movimentação / renomear -------------------------------------------------------

  app.patch<{ Params: { id: string }; Body: { folderId?: string; name?: string } }>(
    "/media/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            folderId: { type: "string", format: "uuid" },
            name: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) =>
      handle(reply, async () => {
        let asset = await library.get(req.params.id);
        if (!asset || asset.status === "deleted") {
          return reply.code(404).send({ error: "mídia não encontrada" });
        }
        if (req.body.folderId) asset = await library.move(req.params.id, req.body.folderId);
        if (req.body.name) asset = await library.rename(req.params.id, req.body.name);
        return asset;
      }),
  );

  // --- remoção ---------------------------------------------------------------------

  app.delete<{ Params: { id: string } }>("/media/:id", async (req, reply) => {
    const result = await library.delete(req.params.id);
    if (!result.deleted) return reply.code(404).send({ error: "mídia não encontrada" });
    if (result.pendingStorageCleanup) {
      // Falha parcial explícita: metadado removido, bytes pendentes de coleta.
      req.log.warn({ assetId: req.params.id }, "bytes pendentes de remoção no storage");
      return reply.code(202).send(result);
    }
    return result;
  });

  // Coletor das pendências de storage (falhas parciais e órfãos).
  app.post<{ Body: { limit?: number } }>(
    "/media/maintenance/gc",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 500 } },
        },
      },
    },
    async (req) => library.collectPendingDeletes(req.body?.limit ?? config.gcBatchLimit),
  );
}
