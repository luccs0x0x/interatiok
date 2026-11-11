/** Protocolo WebSocket entre o motor e o overlay (contrato documentado em docs/CONTRATO-OVERLAY.md). */
import type { GameConfig } from '../config.js';
import type { GameAction, GameState } from '../types.js';

export const PROTOCOL_VERSION = 1 as const;

/** Configuração que o visual pode usar para montar HUD/metas. */
export interface PublicConfig {
  thresholds: {
    expensiveGiftCoins: number;
    likeStep: number;
    goalCoins: number;
    goalEnabled: boolean;
  };
  chat: {
    windowSize: number;
    minRepliesPerWindow: number;
    maxRepliesPerWindow: number;
    cooldownMs: number;
    minReplyGapMs: number;
  };
  tiers: Array<{ id: string; minCoins: number; animation: string; intensity: number }>;
  animations: {
    likeMilestone: string;
    expensiveGift: string;
    goal: string;
  };
}

export type ServerMessage =
  | {
      v: typeof PROTOCOL_VERSION;
      type: 'hello';
      serverTime: number;
      state: GameState;
      config: PublicConfig;
    }
  | { v: typeof PROTOCOL_VERSION; type: 'state'; state: GameState }
  | {
      v: typeof PROTOCOL_VERSION;
      type: 'action';
      seq: number;
      id: string;
      ts: number;
      action: GameAction;
    }
  | { v: typeof PROTOCOL_VERSION; type: 'pong'; t: number };

export type ClientMessage = { type: 'ping'; t?: number };

export function publicConfig(config: GameConfig): PublicConfig {
  return {
    thresholds: {
      expensiveGiftCoins: config.expensiveGift.minCoinsExclusive,
      likeStep: config.likes.step,
      goalCoins: config.donation.goal.targetCoins,
      goalEnabled: config.donation.goal.enabled,
    },
    chat: {
      windowSize: config.chat.windowSize,
      minRepliesPerWindow: config.chat.minRepliesPerWindow,
      maxRepliesPerWindow: config.chat.maxRepliesPerWindow,
      cooldownMs: config.chat.cooldownMs,
      minReplyGapMs: config.chat.minReplyGapMs,
    },
    tiers: config.donation.tiers.map((tier) => ({
      id: tier.id,
      minCoins: tier.minCoins,
      animation: tier.animation,
      intensity: tier.intensity,
    })),
    animations: {
      likeMilestone: config.likes.animation,
      expensiveGift: config.expensiveGift.animation,
      goal: config.donation.goal.animation,
    },
  };
}
