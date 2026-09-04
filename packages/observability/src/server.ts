/**
 * Servidor HTTP mínimo que expõe `/metrics` a partir do registry. Usado por
 * processos sem servidor web próprio (o worker). A API expõe a mesma rota via
 * Fastify, então não precisa disto.
 */

import { createServer, type Server } from "node:http";
import { metricsText, registryContentType } from "./metrics.js";

export interface MetricsServerOptions {
  readonly port: number;
  readonly host?: string;
}

/** Sobe o servidor de métricas e resolve quando estiver escutando. */
export function startMetricsServer(opts: MetricsServerOptions): Promise<Server> {
  const host = opts.host ?? "0.0.0.0";
  const server = createServer((req, res) => {
    if (req.url === "/metrics") {
      metricsText()
        .then((body) => {
          res.writeHead(200, { "content-type": registryContentType });
          res.end(body);
        })
        .catch((err: unknown) => {
          res.writeHead(500);
          res.end(String(err));
        });
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(opts.port, host, () => resolve(server));
  });
}
