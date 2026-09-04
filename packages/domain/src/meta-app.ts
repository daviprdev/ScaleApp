/**
 * Meta App (BYOC). Múltiplos Apps desde o v1 não é opcional: rate-limit da
 * Graph API é por App, então concentrar 500 contas num único App garante
 * quedas em cascata artificiais. Contas são distribuídas entre vários Apps.
 */

import type { MetaAppId } from "./common.js";

export interface MetaApp {
  readonly id: MetaAppId;
  readonly label: string;
  /** App ID público da Meta. */
  readonly clientId: string;
  /** Referência ao segredo no cofre — nunca o secret em texto no domínio. */
  readonly secretRef: string;
  readonly enabled: boolean;
  /**
   * Teto de contas atribuíveis a este App. Usado pela distribuição BYOC para
   * não sobrecarregar um App e provocar rate-limit em cascata.
   */
  readonly accountCapacity?: number;
}
