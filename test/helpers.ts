/** Utilidades compartilhadas pelos testes. */
import { FakeClock } from '../src/clock.js';
import { GameConfigSchema, LinesSchema, type GameConfig, type LinesConfig } from '../src/config.js';
import { GameEngine } from '../src/engine/gameEngine.js';
import { CharacterResponder } from '../src/engine/responder.js';
import { createLogger } from '../src/logger.js';
import type { CharacterAct, CharacterSay, ChatEvent, GameAction, GameState, Viewer } from '../src/types.js';

export const testLogger = createLogger('silent');

export function testConfig(overrides: Record<string, unknown> = {}): GameConfig {
  return GameConfigSchema.parse(overrides);
}

export function testLines(overrides: Record<string, unknown> = {}): LinesConfig {
  return LinesSchema.parse({
    persona: { name: 'Lia', emoji: '💜' },
    chatFallback: ['Recebi seu recado, {name}!'],
    expensiveGift: ['{name} mandou {gift} de {coins} moedas!'],
    gift: { bronze: ['Obrigada, {name}!'], default: ['Valeu, {name}!'] },
    follow: ['Bem-vindo, {name}!'],
    subscribe: ['Assinou, {name}!'],
    goal: ['Meta batida, {coins} moedas!'],
    intents: [
      {
        id: 'greeting',
        patterns: ['\\b(oi|olá|ola)\\b'],
        replies: ['Oi, {name}!'],
      },
    ],
    ...overrides,
  });
}

export function viewer(id = '1', nickname = 'Bia'): Viewer {
  return { userId: id, username: `user${id}`, nickname };
}

export interface EngineHarness {
  engine: GameEngine;
  clock: FakeClock;
  actions: GameAction[];
  states: GameState[];
  config: GameConfig;
  lines: LinesConfig;
}

export function createEngine(
  configOverrides: Record<string, unknown> = {},
  linesOverrides: Record<string, unknown> = {},
): EngineHarness {
  const config = testConfig(configOverrides);
  const lines = testLines(linesOverrides);
  const clock = new FakeClock();
  const actions: GameAction[] = [];
  const states: GameState[] = [];

  const engine = new GameEngine({
    config,
    lines,
    clock,
    responder: new CharacterResponder(lines, { rng: () => 0 }),
    logger: testLogger,
    onAction: (action) => actions.push(action),
    onState: (state) => states.push(state),
  });

  return { engine, clock, actions, states, config, lines };
}

export function chatEvent(
  id: string,
  text: string,
  user: Viewer = viewer(),
  ts = 1_700_000_000_000,
): ChatEvent {
  return { type: 'chat', id, ts, user, text };
}

export function acts(actions: GameAction[]): CharacterAct[] {
  return actions.filter((action): action is CharacterAct => action.kind === 'character.act');
}

export function says(actions: GameAction[]): CharacterSay[] {
  return actions.filter((action): action is CharacterSay => action.kind === 'character.say');
}
