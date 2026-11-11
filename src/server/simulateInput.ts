/**
 * Normaliza eventos enviados manualmente para `POST /api/simulate`.
 *
 * Útil para testar o overlay e as regras sem esperar um presente caro cair:
 *
 *   curl -X POST http://127.0.0.1:8787/api/simulate \
 *     -H 'content-type: application/json' \
 *     -d '{"events":[{"type":"like","count":100}]}'
 */
import type { LiveEvent, SocialKind, Viewer } from '../types.js';

const SOCIAL_TYPES = new Set<SocialKind>(['follow', 'share', 'subscribe', 'join']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value);
}

function parseUser(value: unknown): Viewer | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const id = asString(raw.userId ?? raw.id).trim();
  if (!id) return null;
  return {
    userId: id,
    username: asString(raw.username ?? raw.uniqueId, id),
    nickname: asString(raw.nickname ?? raw.username ?? raw.uniqueId, id),
    ...(typeof raw.avatarUrl === 'string' ? { avatarUrl: raw.avatarUrl } : {}),
  };
}

/** Converte um objeto vindo da API em `LiveEvent`; devolve null se inválido. */
export function normalizeSimulatedEvent(input: unknown, index = 0): LiveEvent | null {
  const raw = asRecord(input);
  if (!raw) return null;

  const type = asString(raw.type);
  const ts = asNumber(raw.ts, Date.now());
  const id = asString(raw.id, `sim-${Date.now()}-${index}`);

  const user = parseUser(raw.user) ?? {
    userId: `sim-${index}`,
    username: 'sim',
    nickname: 'Sim',
  };

  switch (type) {
    case 'chat': {
      const text = asString(raw.text).trim();
      if (!text) return null;
      return { type: 'chat', id, ts, user, text };
    }
    case 'gift': {
      const giftName = asString(raw.giftName, 'Presente');
      const diamonds = Math.max(0, asNumber(raw.diamonds, 0));
      const repeatCount = Math.max(1, Math.trunc(asNumber(raw.repeatCount, 1)));
      const streakable = raw.streakable === true;
      const comboEnd = raw.comboEnd === undefined ? true : raw.comboEnd === true;
      return {
        type: 'gift',
        id,
        ts,
        user,
        giftId: asString(raw.giftId, 'sim-gift'),
        giftName,
        diamonds,
        repeatCount,
        streakable,
        comboEnd,
      };
    }
    case 'like':
      return {
        type: 'like',
        id,
        ts,
        user,
        count: Math.max(0, Math.trunc(asNumber(raw.count, 1))),
      };
    case 'viewers':
      return { type: 'viewers', id, ts, count: Math.max(0, Math.trunc(asNumber(raw.count, 0))) };
    default:
      if (SOCIAL_TYPES.has(type as SocialKind)) {
        return { type: type as SocialKind, id, ts, user };
      }
      return null;
  }
}

export function normalizeSimulatedEvents(input: unknown): LiveEvent[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item, index) => normalizeSimulatedEvent(item, index))
    .filter((event): event is LiveEvent => event !== null);
}
