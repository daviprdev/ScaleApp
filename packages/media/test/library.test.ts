/**
 * Testes de integração da Biblioteca de Mídia contra Postgres + storage reais.
 *
 * O que estes testes existem para provar (e que fake nenhum provaria): que os
 * metadados e os bytes contam a mesma história — depois de dedup, movimentação,
 * remoção, restart do processo e chamadas concorrentes.
 *
 * Requer DATABASE_URL (o script de teste carrega o .env da raiz).
 */

import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pgPkg from "pg";
import type { Pool } from "pg";
import {
  FilesystemMediaStorage,
  LibraryMediaResolver,
  MediaError,
  MediaLibrary,
  MediaRepository,
  MediaServeError,
  MediaServer,
  ROOT_FOLDER_ID,
  storageKeyFor,
  type MediaStorage,
  type UrlSigner,
} from "../src/index.js";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL não definida (copie .env.example para .env)");

let pool: Pool;
let storageRoot: string;
let storage: FilesystemMediaStorage;
let library: MediaLibrary;
let repo: MediaRepository;

const signer: UrlSigner = {
  sign: (data) => createHash("sha256").update(`chave-de-teste:${data}`).digest("base64url"),
};

/** Bytes determinísticos com cabeçalho plausível de JPEG/MP4. */
function bytes(seed: string, size = 256): Buffer {
  const body = createHash("sha256").update(seed).digest();
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(size, body[0]!), body]);
}

const criados: string[] = [];
const pastas: string[] = [];

async function ingest(seed: string, over: Record<string, unknown> = {}) {
  const result = await library.ingest({
    bytes: bytes(seed),
    name: `${seed}.jpg`,
    mimeType: "image/jpeg",
    ...over,
  });
  criados.push(result.asset.id);
  return result;
}

before(async () => {
  pool = new pgPkg.Pool({ connectionString: dbUrl });
  storageRoot = await mkdtemp(join(tmpdir(), "scaleapp-media-"));
  storage = new FilesystemMediaStorage(storageRoot);
  repo = new MediaRepository(pool);
  library = new MediaLibrary({ pool, storage });
});

after(async () => {
  // Limpa o que os testes criaram (o banco de dev é compartilhado).
  if (criados.length) {
    await pool.query(`DELETE FROM media_assets WHERE id = ANY($1::uuid[])`, [criados]);
  }
  await pool.query(
    `DELETE FROM media_blobs WHERE NOT EXISTS
       (SELECT 1 FROM media_assets a WHERE a.checksum = media_blobs.checksum)`,
  );
  if (pastas.length) {
    await pool.query(`DELETE FROM media_folders WHERE id = ANY($1::uuid[])`, [pastas]);
  }
  await pool.end();
  await rm(storageRoot, { recursive: true, force: true });
});

// --- 1. pastas ---------------------------------------------------------------

test("cria pasta e lista", async () => {
  const nome = `campanha-${randomUUID().slice(0, 8)}`;
  const folder = await library.createFolder(nome);
  pastas.push(folder.id);

  const listadas = await library.listFolders(200);
  assert.ok(listadas.some((f) => f.id === folder.id && f.name === nome));
  // A raiz da migration existe e serve de destino padrão.
  assert.ok(listadas.some((f) => f.id === ROOT_FOLDER_ID));
});

test("pasta com nome repetido no mesmo nível é rejeitada", async () => {
  const nome = `dup-${randomUUID().slice(0, 8)}`;
  const primeira = await library.createFolder(nome);
  pastas.push(primeira.id);
  await assert.rejects(() => library.createFolder(nome), /duplicate key|unique/i);
});

// --- 2/3/4. upload, metadados e bytes -----------------------------------------

test("upload persiste metadados no banco e bytes no storage", async () => {
  const seed = `upload-${randomUUID().slice(0, 8)}`;
  const { asset, deduplicated } = await ingest(seed);

  assert.equal(deduplicated, false);
  assert.equal(asset.kind, "image");
  assert.equal(asset.mimeType, "image/jpeg");
  assert.equal(asset.status, "ready");
  assert.equal(asset.folderId, ROOT_FOLDER_ID);
  assert.equal(asset.source, "upload");
  assert.equal(asset.byteSize, bytes(seed).byteLength);
  assert.match(asset.checksum, /^[0-9a-f]{64}$/);

  // Metadado no Postgres...
  const row = await pool.query(`SELECT id FROM media_assets WHERE id = $1`, [asset.id]);
  assert.equal(row.rows.length, 1);

  // ...e bytes no storage, na chave derivada do conteúdo.
  assert.equal(asset.storageKey, storageKeyFor(asset.checksum, "image/jpeg"));
  assert.equal(await storage.exists(asset.storageKey), true);
  assert.deepEqual(await storage.readAll(asset.storageKey), bytes(seed));

  // E nenhum byte dentro do banco.
  const cols = await pool.query<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns
     WHERE table_name IN ('media_assets','media_blobs')`,
  );
  assert.ok(!cols.rows.some((c) => c.data_type === "bytea"));
});

test("vídeo é classificado como vídeo, e uso é só classificação", async () => {
  const seed = `video-${randomUUID().slice(0, 8)}`;
  const { asset } = await ingest(seed, { name: `${seed}.mp4`, mimeType: "video/mp4", usage: "reel" });
  assert.equal(asset.kind, "video");
  assert.equal(asset.usage, "reel");
  assert.match(asset.storageKey, /\.mp4$/);
});

test("uso incompatível e tipo não suportado são recusados", async () => {
  await assert.rejects(
    () => library.ingest({ bytes: bytes("x"), name: "x.jpg", mimeType: "image/jpeg", usage: "reel" }),
    (err: MediaError) => err.code === "USAGE_MISMATCH",
  );
  await assert.rejects(
    () => library.ingest({ bytes: bytes("y"), name: "y.pdf", mimeType: "application/pdf" }),
    (err: MediaError) => err.code === "UNSUPPORTED_TYPE",
  );
});

// --- 5. listagem paginada -----------------------------------------------------

test("listagem é paginada e o total acompanha", async () => {
  const folder = await library.createFolder(`pag-${randomUUID().slice(0, 8)}`);
  pastas.push(folder.id);
  for (let i = 0; i < 5; i++) await ingest(`pag-${folder.id}-${i}`, { folderId: folder.id });

  const p1 = await library.list({ limit: 2, offset: 0, folderId: folder.id });
  const p2 = await library.list({ limit: 2, offset: 2, folderId: folder.id });
  const p3 = await library.list({ limit: 2, offset: 4, folderId: folder.id });

  assert.equal(p1.total, 5);
  assert.deepEqual([p1.items.length, p2.items.length, p3.items.length], [2, 2, 1]);
  const ids = [...p1.items, ...p2.items, ...p3.items].map((a) => a.id);
  assert.equal(new Set(ids).size, 5, "páginas não podem repetir item");
});

// --- 6. resolver real ----------------------------------------------------------

test("resolver real devolve URL assinada e o tipo certo", async () => {
  const { asset } = await ingest(`resolve-${randomUUID().slice(0, 8)}`);
  const resolver = new LibraryMediaResolver(repo, signer, {
    publicBaseUrl: "https://midia.exemplo.test",
    urlTtlMs: 60_000,
  });

  const resolved = await resolver.resolveMedia(asset.id);
  assert.ok(resolved);
  assert.equal(resolved.kind, "image");
  const url = new URL(resolved.url);
  assert.equal(url.origin, "https://midia.exemplo.test");
  assert.equal(url.pathname, `/media/${asset.id}/raw`);
  assert.ok(url.searchParams.get("sig"));
  assert.ok(Number(url.searchParams.get("exp")) * 1000 > Date.now());
});

test("resolver recusa id inexistente, malformado e mídia apagada", async () => {
  const resolver = new LibraryMediaResolver(repo, signer, {
    publicBaseUrl: "https://midia.exemplo.test",
  });
  assert.equal(await resolver.resolveMedia("não-é-uuid"), null);
  assert.equal(await resolver.resolveMedia(randomUUID()), null);

  const { asset } = await ingest(`apagada-${randomUUID().slice(0, 8)}`);
  await library.delete(asset.id);
  assert.equal(await resolver.resolveMedia(asset.id), null);
});

test("a URL assinada serve exatamente os bytes gravados", async () => {
  const seed = `serve-${randomUUID().slice(0, 8)}`;
  const { asset } = await ingest(seed);
  const resolver = new LibraryMediaResolver(repo, signer, {
    publicBaseUrl: "https://midia.exemplo.test",
    urlTtlMs: 60_000,
  });
  const server = new MediaServer({ repo, storage, signer });

  const resolved = (await resolver.resolveMedia(asset.id))!;
  const url = new URL(resolved.url);
  const opened = await server.open(
    asset.id,
    Number(url.searchParams.get("exp")),
    url.searchParams.get("sig")!,
  );

  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk as Uint8Array));
  assert.deepEqual(Buffer.concat(chunks), bytes(seed));
  assert.equal(opened.mimeType, "image/jpeg");
});

test("assinatura inválida ou expirada não serve nada", async () => {
  const { asset } = await ingest(`sig-${randomUUID().slice(0, 8)}`);
  const server = new MediaServer({ repo, storage, signer });
  const exp = Math.floor((Date.now() + 60_000) / 1000);

  await assert.rejects(
    () => server.open(asset.id, exp, "assinatura-forjada"),
    (err: MediaServeError) => err.reason === "invalid_signature",
  );
  const expirado = Math.floor((Date.now() - 1000) / 1000);
  await assert.rejects(
    () => server.open(asset.id, expirado, signer.sign(`${asset.id}.${expirado}`)),
    (err: MediaServeError) => err.reason === "invalid_signature",
  );
});

// --- 7. deduplicação -----------------------------------------------------------

test("mesmo conteúdo na mesma pasta não duplica item nem bytes", async () => {
  const seed = `dedup-${randomUUID().slice(0, 8)}`;
  const primeira = await ingest(seed);
  const segunda = await ingest(seed, { name: "outro-nome.jpg" });

  assert.equal(segunda.deduplicated, true);
  assert.equal(segunda.bytesReused, true);
  assert.equal(segunda.asset.id, primeira.asset.id, "deve devolver o item existente");

  const blobs = await pool.query(`SELECT checksum FROM media_blobs WHERE checksum = $1`, [
    primeira.asset.checksum,
  ]);
  assert.equal(blobs.rows.length, 1, "um checksum, uma linha de conteúdo");
});

test("mesmo conteúdo em pastas diferentes: dois itens, um arquivo só", async () => {
  const folder = await library.createFolder(`cross-${randomUUID().slice(0, 8)}`);
  pastas.push(folder.id);
  const seed = `cross-${randomUUID().slice(0, 8)}`;

  const raiz = await ingest(seed);
  const outra = await ingest(seed, { folderId: folder.id });

  assert.notEqual(raiz.asset.id, outra.asset.id);
  assert.equal(raiz.asset.checksum, outra.asset.checksum);
  assert.equal(raiz.asset.storageKey, outra.asset.storageKey);
  assert.equal(outra.bytesReused, true);

  const arquivos = await pool.query(`SELECT count(*)::int AS n FROM media_blobs WHERE checksum = $1`, [
    raiz.asset.checksum,
  ]);
  assert.equal(arquivos.rows[0]!.n, 1);
});

// --- 8. movimentação -------------------------------------------------------------

test("mover troca a pasta sem tocar nos bytes", async () => {
  const destino = await library.createFolder(`mover-${randomUUID().slice(0, 8)}`);
  pastas.push(destino.id);
  const { asset } = await ingest(`mover-${randomUUID().slice(0, 8)}`);

  const movido = await library.move(asset.id, destino.id);
  assert.equal(movido.folderId, destino.id);
  assert.equal(movido.storageKey, asset.storageKey, "mover não pode reescrever arquivo");
  assert.equal(await storage.exists(asset.storageKey), true);
});

test("mover para pasta que já tem o mesmo conteúdo é conflito explícito", async () => {
  const destino = await library.createFolder(`conflito-${randomUUID().slice(0, 8)}`);
  pastas.push(destino.id);
  const seed = `conflito-${randomUUID().slice(0, 8)}`;

  const naRaiz = await ingest(seed);
  await ingest(seed, { folderId: destino.id });

  await assert.rejects(
    () => library.move(naRaiz.asset.id, destino.id),
    (err: MediaError) => err.code === "DUPLICATE_IN_TARGET",
  );
});

// --- 9. exclusão consistente --------------------------------------------------------

test("excluir remove metadado e bytes quando ninguém mais referencia", async () => {
  const { asset } = await ingest(`del-${randomUUID().slice(0, 8)}`);

  const res = await library.delete(asset.id);
  assert.deepEqual(
    { deleted: res.deleted, bytes: res.bytesRemoved, pendente: res.pendingStorageCleanup },
    { deleted: true, bytes: true, pendente: false },
  );
  assert.equal(await storage.exists(asset.storageKey), false, "bytes precisam sumir");
  const blob = await pool.query(`SELECT checksum FROM media_blobs WHERE checksum = $1`, [
    asset.checksum,
  ]);
  assert.equal(blob.rows.length, 0, "linha de conteúdo precisa sumir junto");
});

test("excluir NÃO apaga bytes ainda referenciados por outra pasta", async () => {
  const folder = await library.createFolder(`ref-${randomUUID().slice(0, 8)}`);
  pastas.push(folder.id);
  const seed = `ref-${randomUUID().slice(0, 8)}`;
  const a = await ingest(seed);
  const b = await ingest(seed, { folderId: folder.id });

  const res = await library.delete(a.asset.id);
  assert.equal(res.bytesRemoved, false, "o outro item ainda usa este conteúdo");
  assert.equal(await storage.exists(b.asset.storageKey), true);

  // Removido o último, aí sim os bytes vão embora.
  const ultimo = await library.delete(b.asset.id);
  assert.equal(ultimo.bytesRemoved, true);
  assert.equal(await storage.exists(b.asset.storageKey), false);
});

test("falha no storage vira pendência rastreável, não lixo silencioso", async () => {
  const { asset } = await ingest(`falha-${randomUUID().slice(0, 8)}`);

  // Storage que recusa remover — simula disco/rede indisponível na hora errada.
  const quebrado: MediaStorage = {
    ...storage,
    put: storage.put.bind(storage),
    read: storage.read.bind(storage),
    readAll: storage.readAll.bind(storage),
    exists: storage.exists.bind(storage),
    stat: storage.stat.bind(storage),
    async delete() {
      throw new Error("storage indisponível");
    },
  };
  const comFalha = new MediaLibrary({ pool, storage: quebrado });

  const res = await comFalha.delete(asset.id);
  assert.deepEqual(
    { deleted: res.deleted, bytes: res.bytesRemoved, pendente: res.pendingStorageCleanup },
    { deleted: true, bytes: false, pendente: true },
  );

  // O metadado já saiu (nada resolve mais para ele)...
  const resolver = new LibraryMediaResolver(repo, signer, { publicBaseUrl: "https://x.test" });
  assert.equal(await resolver.resolveMedia(asset.id), null);

  // ...e a limpeza ficou registrada como pendência, que o coletor termina.
  const pendentes = await repo.findPendingDeleteBlobs(50);
  assert.ok(pendentes.some((b) => b.checksum === asset.checksum));

  const gc = await library.collectPendingDeletes(50);
  assert.ok(gc.removed >= 1);
  assert.equal(await storage.exists(asset.storageKey), false);
});

test("excluir duas vezes é idempotente", async () => {
  const { asset } = await ingest(`idem-${randomUUID().slice(0, 8)}`);
  const primeira = await library.delete(asset.id);
  const segunda = await library.delete(asset.id);
  assert.equal(primeira.deleted, true);
  assert.equal(segunda.deleted, false);
});

// --- 10. restart do processo ------------------------------------------------------

test("referências sobrevivem a um restart (pool, storage e serviço novos)", async () => {
  const seed = `restart-${randomUUID().slice(0, 8)}`;
  const { asset } = await ingest(seed);

  // Simula o processo reiniciando: nada em memória é reaproveitado, só o que
  // está no Postgres e no diretório de storage.
  const outroPool = new pgPkg.Pool({ connectionString: dbUrl });
  try {
    const outroStorage = new FilesystemMediaStorage(storageRoot);
    const outroRepo = new MediaRepository(outroPool);
    const outroResolver = new LibraryMediaResolver(outroRepo, signer, {
      publicBaseUrl: "https://midia.exemplo.test",
      urlTtlMs: 60_000,
    });

    const resolved = await outroResolver.resolveMedia(asset.id);
    assert.ok(resolved, "a mídia tem que continuar resolvível depois do restart");

    const server = new MediaServer({ repo: outroRepo, storage: outroStorage, signer });
    const url = new URL(resolved.url);
    const opened = await server.open(
      asset.id,
      Number(url.searchParams.get("exp")),
      url.searchParams.get("sig")!,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk as Uint8Array));
    assert.deepEqual(Buffer.concat(chunks), bytes(seed));

    // E os bytes estão num diretório persistente, não no temp do processo.
    const info = await stat(join(storageRoot, asset.storageKey));
    assert.ok(info.isFile());
  } finally {
    await outroPool.end();
  }
});

// --- 11. concorrência -----------------------------------------------------------------

test("uploads concorrentes do mesmo arquivo: um item, um blob, zero erro", async () => {
  const seed = `corrida-${randomUUID().slice(0, 8)}`;
  const payload = bytes(seed);

  const resultados = await Promise.all(
    Array.from({ length: 4 }, () =>
      library.ingest({ bytes: payload, name: `${seed}.jpg`, mimeType: "image/jpeg" }),
    ),
  );
  for (const r of resultados) criados.push(r.asset.id);

  const ids = new Set(resultados.map((r) => r.asset.id));
  assert.equal(ids.size, 1, "as quatro chamadas têm que convergir para o mesmo item");
  assert.equal(resultados.filter((r) => !r.deduplicated).length, 1, "só uma cria de fato");

  const linhas = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM media_assets WHERE checksum = $1 AND status <> 'deleted'`,
    [resultados[0]!.asset.checksum],
  );
  assert.equal(linhas.rows[0]!.n, 1);
});

test("exclusões concorrentes: uma vence, os bytes somem uma vez só", async () => {
  const { asset } = await ingest(`del-corrida-${randomUUID().slice(0, 8)}`);

  const resultados = await Promise.all([
    library.delete(asset.id),
    library.delete(asset.id),
    library.delete(asset.id),
  ]);

  assert.equal(resultados.filter((r) => r.deleted).length, 1, "só uma remoção pode ganhar");
  assert.equal(await storage.exists(asset.storageKey), false);
});

test("resolver concorrente com exclusão nunca devolve mídia sem bytes", async () => {
  const { asset } = await ingest(`res-corrida-${randomUUID().slice(0, 8)}`);
  const resolver = new LibraryMediaResolver(repo, signer, { publicBaseUrl: "https://x.test" });
  const server = new MediaServer({ repo, storage, signer });

  const [resolvidoAntes] = await Promise.all([resolver.resolveMedia(asset.id), library.delete(asset.id)]);

  // Se a resolução ganhou a corrida, a URL dela já não serve mais nada — o
  // servidor recusa em vez de entregar arquivo ausente.
  if (resolvidoAntes) {
    const url = new URL(resolvidoAntes.url);
    await assert.rejects(
      () =>
        server.open(
          asset.id,
          Number(url.searchParams.get("exp")),
          url.searchParams.get("sig")!,
        ),
      (err: MediaServeError) => err.reason === "not_found" || err.reason === "bytes_missing",
    );
  }
  assert.equal(await resolver.resolveMedia(asset.id), null);
});
