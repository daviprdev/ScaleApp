/**
 * Portas da Biblioteca de Mídia. O domínio não conhece filesystem, S3 nem
 * MinIO: fala com `MediaStorage` e pronto. Trocar o backend no futuro é
 * escrever outra implementação desta interface — nenhuma migration, nenhuma
 * mudança em repositório, serviço ou resolver.
 */

import type { Readable } from "node:stream";

export interface StoredObject {
  readonly key: string;
  readonly byteSize: number;
}

export interface PutObjectInput {
  readonly key: string;
  readonly bytes: Buffer;
  readonly contentType: string;
}

/**
 * Storage de bytes. Contrato deliberadamente pequeno — quanto menos ele exige,
 * mais backends conseguem satisfazê-lo.
 *
 * `put` precisa ser idempotente: as chaves são derivadas do conteúdo, então
 * gravar duas vezes a mesma chave é gravar o mesmo arquivo. Isso é o que torna
 * seguro escrever os bytes ANTES de inserir a linha no banco.
 */
export interface MediaStorage {
  put(input: PutObjectInput): Promise<StoredObject>;
  /** Stream para servir sem carregar o arquivo inteiro em memória. */
  read(key: string): Promise<Readable>;
  /** Bytes completos — só para arquivos pequenos e para teste. */
  readAll(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  /** Remove; devolve false se já não existia (a remoção é idempotente). */
  delete(key: string): Promise<boolean>;
  stat(key: string): Promise<StoredObject | null>;
}

export interface FetchedMedia {
  readonly bytes: Buffer;
  readonly contentType?: string;
}

/** Baixa uma mídia de uma URL externa (importação). */
export interface MediaFetcher {
  fetch(url: string, maxBytes: number): Promise<FetchedMedia>;
}

/**
 * Assina a URL pública de uma mídia. A Graph API baixa o arquivo por conta
 * própria, então a URL precisa ser alcançável da internet — e, sendo, precisa
 * ser assinada e expirável, senão o id da mídia vira uma porta aberta para a
 * biblioteca inteira.
 */
export interface UrlSigner {
  sign(data: string): string;
}
