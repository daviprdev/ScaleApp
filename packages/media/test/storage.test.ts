/**
 * Testes do que não precisa de banco: identidade do conteúdo, chave de storage,
 * URL assinada e o backend de filesystem.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import {
  FilesystemMediaStorage,
  SignedUrlError,
  StorageKeyError,
  buildMediaUrl,
  checksumOf,
  kindFromMime,
  mimeFromFilename,
  normalizeMime,
  signMediaAccess,
  storageKeyFor,
  usageAllowedFor,
  verifyMediaAccess,
  type UrlSigner,
} from "../src/index.js";

let root: string;
let storage: FilesystemMediaStorage;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "scaleapp-storage-"));
  storage = new FilesystemMediaStorage(root);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

// --- conteúdo -----------------------------------------------------------------

test("checksum é estável e a chave deriva do conteúdo", () => {
  const a = Buffer.from("conteúdo");
  assert.equal(checksumOf(a), checksumOf(Buffer.from("conteúdo")));
  assert.notEqual(checksumOf(a), checksumOf(Buffer.from("outro")));

  const sum = checksumOf(a);
  const key = storageKeyFor(sum, "image/jpeg");
  assert.equal(key, `sha256/${sum.slice(0, 2)}/${sum.slice(2, 4)}/${sum}.jpg`);
  // Mesmo conteúdo, mesma chave — é o que faz a deduplicação ser estrutural.
  assert.equal(key, storageKeyFor(sum, "image/jpeg"));
});

test("tipo vem do MIME, não da extensão do nome", () => {
  assert.equal(kindFromMime("video/mp4"), "video");
  assert.equal(kindFromMime("image/png"), "image");
  assert.equal(normalizeMime("image/jpeg; charset=binary"), "image/jpeg");
  assert.throws(() => kindFromMime("application/zip"));
  assert.equal(mimeFromFilename("clipe.MP4"), "video/mp4");
  assert.equal(mimeFromFilename("foto.jpeg"), "image/jpeg");
  assert.equal(mimeFromFilename("sem-extensao"), undefined);
});

test("reel só se aplica a vídeo; story vale para os dois", () => {
  assert.equal(usageAllowedFor("video", "reel"), true);
  assert.equal(usageAllowedFor("image", "reel"), false);
  assert.equal(usageAllowedFor("image", "story"), true);
});

// --- storage --------------------------------------------------------------------

test("grava, lê e apaga", async () => {
  const payload = Buffer.from("bytes de teste");
  const key = storageKeyFor(checksumOf(payload), "image/png");

  const stored = await storage.put({ key, bytes: payload, contentType: "image/png" });
  assert.equal(stored.byteSize, payload.byteLength);
  assert.equal(await storage.exists(key), true);
  assert.deepEqual(await storage.readAll(key), payload);
  assert.deepEqual((await storage.stat(key))?.byteSize, payload.byteLength);

  assert.equal(await storage.delete(key), true);
  assert.equal(await storage.exists(key), false);
  // Remoção é idempotente: apagar o que já sumiu não é erro.
  assert.equal(await storage.delete(key), false);
});

test("gravar o mesmo conteúdo duas vezes é idempotente e não deixa temporário", async () => {
  const payload = Buffer.from("conteúdo repetido");
  const key = storageKeyFor(checksumOf(payload), "image/jpeg");

  await storage.put({ key, bytes: payload, contentType: "image/jpeg" });
  await storage.put({ key, bytes: payload, contentType: "image/jpeg" });

  const dir = join(root, key.slice(0, key.lastIndexOf("/")));
  const entradas = await readdir(dir);
  assert.equal(entradas.length, 1, `sobrou temporário: ${entradas.join(", ")}`);
  assert.deepEqual(await storage.readAll(key), payload);
});

test("stream não carrega o arquivo inteiro de uma vez", async () => {
  const payload = Buffer.alloc(200_000, 7);
  const key = storageKeyFor(checksumOf(payload), "video/mp4");
  await storage.put({ key, bytes: payload, contentType: "video/mp4" });

  const chunks: Buffer[] = [];
  for await (const chunk of await storage.read(key)) chunks.push(Buffer.from(chunk as Uint8Array));
  assert.ok(chunks.length > 1, "arquivo grande deveria chegar em pedaços");
  assert.deepEqual(Buffer.concat(chunks), payload);
});

test("chave não pode escapar da raiz", async () => {
  for (const ruim of ["../fora.jpg", "/etc/passwd", "a/../../b.jpg", ""]) {
    await assert.rejects(() => storage.exists(ruim), StorageKeyError, `aceitou "${ruim}"`);
  }
});

test("ler objeto ausente falha com mensagem clara", async () => {
  await assert.rejects(() => storage.read("sha256/aa/bb/inexistente.jpg"), /ausente no storage/);
});

// --- URL assinada -------------------------------------------------------------------

const signer: UrlSigner = {
  sign: (data) => createHmac("sha256", "segredo-de-teste").update(data).digest("base64url"),
};

test("assina e verifica", () => {
  const parts = signMediaAccess(signer, "3f2504e0-4f89-11d3-9a0c-0305e82c3301", 60_000);
  verifyMediaAccess(signer, parts.assetId, parts.expiresAtSec, parts.signature);

  const url = new URL(buildMediaUrl("https://midia.test/", parts));
  assert.equal(url.pathname, `/media/${parts.assetId}/raw`);
  assert.equal(url.searchParams.get("sig"), parts.signature);
});

test("assinatura de outra mídia, expiração esticada ou chave errada não passam", () => {
  const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const parts = signMediaAccess(signer, id, 60_000);

  // Mesma assinatura, outro id.
  assert.throws(
    () => verifyMediaAccess(signer, "00000000-0000-0000-0000-000000000000", parts.expiresAtSec, parts.signature),
    SignedUrlError,
  );
  // Expiração empurrada para frente sem reassinar.
  assert.throws(
    () => verifyMediaAccess(signer, id, parts.expiresAtSec + 3600, parts.signature),
    SignedUrlError,
  );
  // Outra chave.
  const outro: UrlSigner = { sign: (d) => createHmac("sha256", "outra", ).update(d).digest("base64url") };
  assert.throws(() => verifyMediaAccess(outro, id, parts.expiresAtSec, parts.signature), SignedUrlError);
});

test("URL expirada é recusada", () => {
  const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const parts = signMediaAccess(signer, id, 1_000);
  verifyMediaAccess(signer, id, parts.expiresAtSec, parts.signature, Date.now());
  assert.throws(
    () => verifyMediaAccess(signer, id, parts.expiresAtSec, parts.signature, Date.now() + 5_000),
    /expirada/,
  );
});
