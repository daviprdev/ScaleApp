/**
 * Storage em filesystem — o backend do v1.
 *
 * Por quê FS e não MinIO/S3 agora: a VPS é uma só, o volume é local, e um
 * serviço a mais no compose custa RAM que o projeto prefere gastar
 * paralelizando automação. O que S3 traria de verdade (URL assinada, escala
 * horizontal) já está resolvido de outro jeito: a URL assinada é emitida pela
 * própria API, e escala horizontal de storage não é problema do v1. Quando
 * for, `MediaStorage` é a única coisa que precisa de outra implementação.
 *
 * Layout endereçado por conteúdo: `sha256/ab/cd/<checksum>.<ext>`. Duas
 * consequências que interessam:
 *  - gravar o mesmo conteúdo duas vezes é gravar o mesmo arquivo (idempotente),
 *    então é seguro escrever os bytes antes de tocar no banco;
 *  - o prefixo de dois níveis evita um diretório com dezenas de milhares de
 *    entradas, que é onde o FS começa a ficar lento.
 *
 * A escrita é atômica: grava num arquivo temporário DENTRO da própria raiz e
 * renomeia. O temporário não vive no diretório temporário do processo — de
 * propósito: `rename` entre sistemas de arquivos diferentes não é atômico, e
 * nada aqui pode depender de um caminho que some no restart.
 */

import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, unlink, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { MediaStorage, PutObjectInput, StoredObject } from "../ports.js";

export class StorageKeyError extends Error {
  constructor(key: string) {
    super(`chave de storage inválida: ${key}`);
    this.name = "StorageKeyError";
  }
}

/** Aceita só chaves relativas e sem `..` — nada de escapar da raiz. */
function assertSafeKey(key: string): void {
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.startsWith("\\") ||
    key.includes("\0") ||
    key.split(/[\\/]/).some((part) => part === ".." || part === ".")
  ) {
    throw new StorageKeyError(key);
  }
}

export class FilesystemMediaStorage implements MediaStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Raiz configurada — útil para diagnóstico e para o teste de restart. */
  get rootDir(): string {
    return this.root;
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(join(this.root, key));
    // Cinto e suspensório: mesmo com a validação acima, nunca escrever fora.
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new StorageKeyError(key);
    return full;
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const target = this.pathFor(input.key);
    await mkdir(dirname(target), { recursive: true });

    // Já existe com o mesmo tamanho? Conteúdo endereçado por hash: é o mesmo
    // arquivo, reescrever não agrega.
    const existing = await this.statPath(target);
    if (existing && existing.byteSize === input.bytes.byteLength) {
      return { key: input.key, byteSize: existing.byteSize };
    }

    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, input.bytes);
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return { key: input.key, byteSize: input.bytes.byteLength };
  }

  async read(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    // Falha cedo com erro claro em vez de devolver um stream que só quebra
    // quando alguém consumir.
    if (!(await this.statPath(path))) {
      throw new Error(`objeto ausente no storage: ${key}`);
    }
    return createReadStream(path);
  }

  async readAll(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    return (await this.statPath(this.pathFor(key))) !== null;
  }

  async delete(key: string): Promise<boolean> {
    try {
      await unlink(this.pathFor(key));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async stat(key: string): Promise<StoredObject | null> {
    const found = await this.statPath(this.pathFor(key));
    return found ? { key, byteSize: found.byteSize } : null;
  }

  private async statPath(path: string): Promise<{ byteSize: number } | null> {
    try {
      const s = await stat(path);
      return s.isFile() ? { byteSize: s.size } : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}
