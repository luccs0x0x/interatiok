/**
 * Contrato de uma fonte de eventos ao vivo.
 *
 * `TikTokSource` usa o Webcast (via tiktok-live-connector); `SimulatedSource`
 * gera eventos falsos para desenvolver o visual sem estar ao vivo. O motor só
 * conhece `LiveEvent`.
 */
import type { Logger } from '../logger.js';
import type { LiveEvent } from '../types.js';

export interface LiveSourceStatus {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  room?: string | null;
  message?: string | null;
}

export interface LiveSourceContext {
  onEvent: (event: LiveEvent) => void;
  onStatus: (status: LiveSourceStatus) => void;
  logger: Logger;
}

export interface LiveSource {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
