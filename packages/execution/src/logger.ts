/**
 * Logger estruturado (pino) — logs em JSON para acompanhar o ciclo do job.
 *
 * Se `LOKI_URL` estiver definida, além do stdout os logs são enviados ao Loki
 * via transport `pino-loki` (batching, tolerante a Loki fora do ar). Sem a
 * variável, comporta-se como antes: só stdout. Assim o envio ao agregador é
 * opt-in e não acopla o desenvolvimento local a ter o Loki de pé.
 */

import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(name: string, level: string = process.env.LOG_LEVEL ?? "info"): Logger {
  const lokiUrl = process.env.LOKI_URL;
  if (!lokiUrl) {
    return pino({ name, level });
  }

  const transport = pino.transport({
    targets: [
      // stdout continua sendo a fonte primária (e o que promtail/console leem).
      { target: "pino/file", options: { destination: 1 }, level },
      {
        target: "pino-loki",
        level,
        options: {
          host: lokiUrl,
          labels: { app: name, service: "scaleapp" },
          batching: true,
          interval: 5,
          // Loki indisponível não pode derrubar o processo.
          silenceErrors: true,
        },
      },
    ],
  });

  return pino({ name, level }, transport);
}
