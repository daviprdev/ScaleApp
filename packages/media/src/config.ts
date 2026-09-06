/**
 * Configuração da biblioteca.
 *
 * `storageRoot` tem que ser um diretório persistente (volume da VPS), NUNCA o
 * temporário do processo: a biblioteca é a fonte dos arquivos que o pipeline
 * publica, e um restart não pode levar o acervo embora. O default aponta para
 * `.data/media` na raiz do repositório, que é o volume do ambiente de dev.
 */

export interface MediaConfig {
  readonly storageRoot: string;
  /**
   * Base pública usada nas URLs assinadas. Em produção, o domínio real da VPS:
   * é este endereço que o Instagram vai acessar para baixar a mídia.
   */
  readonly publicBaseUrl: string;
  readonly urlTtlMs: number;
  readonly maxBytes: number;
  /** Teto do lote do coletor de bytes órfãos (regra 8). */
  readonly gcBatchLimit: number;
}

const MB = 1024 * 1024;

export const DEFAULT_MEDIA_CONFIG: MediaConfig = {
  storageRoot: ".data/media",
  publicBaseUrl: "http://localhost:3000",
  urlTtlMs: 60 * 60 * 1000,
  maxBytes: 300 * MB,
  gcBatchLimit: 100,
};

function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadMediaConfig(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  const d = DEFAULT_MEDIA_CONFIG;
  return {
    storageRoot: env.MEDIA_STORAGE_ROOT ?? d.storageRoot,
    publicBaseUrl: (env.MEDIA_PUBLIC_BASE_URL ?? d.publicBaseUrl).replace(/\/+$/, ""),
    urlTtlMs: num(env.MEDIA_URL_TTL_MS, d.urlTtlMs),
    maxBytes: num(env.MEDIA_MAX_BYTES, d.maxBytes),
    gcBatchLimit: num(env.MEDIA_GC_BATCH_LIMIT, d.gcBatchLimit),
  };
}
