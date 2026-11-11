import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitize, type LlmClient } from '../src/engine/llm.js';
import { CharacterResponder, render } from '../src/engine/responder.js';
import { testLines, viewer } from './helpers.js';

function responderWithLlm(reply: () => Promise<string | null>) {
  const llm = { complete: reply } as unknown as LlmClient;
  return new CharacterResponder(testLines(), { rng: () => 0, llm });
}

describe('CharacterResponder', () => {
  it('detecta saudação e usa o nome da pessoa', async () => {
    const responder = new CharacterResponder(testLines(), { rng: () => 0 });
    const content = await responder.answerChat({
      user: viewer('1', 'Bia'),
      text: 'oi Lia',
      coins: 0,
    });

    assert.equal(content.text, 'Oi, Bia!');
    assert.equal(content.intent, 'greeting');
    assert.equal(content.emotion, 'happy');
  });

  it('cai no fallback quando não reconhece o intent', async () => {
    const responder = new CharacterResponder(testLines(), { rng: () => 0 });
    const content = await responder.answerChat({
      user: viewer('1', 'Bia'),
      text: 'xyz abc',
      coins: 0,
    });

    assert.equal(content.intent, 'fallback');
    assert.equal(content.text, 'Recebi seu recado, Bia!');
  });

  it('preenche presente, valor e nome na fala de presente caro', async () => {
    const responder = new CharacterResponder(testLines(), { rng: () => 0 });
    const content = await responder.expensiveGift({
      user: viewer('9', 'Nanda'),
      giftName: 'Leão',
      coins: 1200,
      tier: 'diamante',
      repeat: 1,
    });

    assert.match(content.text, /Nanda/);
    assert.match(content.text, /Leão/);
    assert.match(content.text, /1200/);
    assert.equal(content.emotion, 'surprised');
  });

  it('usa o LLM quando ele responde', async () => {
    const responder = responderWithLlm(async () => 'Resposta gerada pelo modelo');
    const content = await responder.answerChat({
      user: viewer('1', 'Bia'),
      text: 'qual o seu nome?',
      coins: 10,
    });

    assert.equal(content.text, 'Resposta gerada pelo modelo');
    assert.equal(content.intent, 'llm');
  });

  it('volta para o template quando o LLM falha', async () => {
    const responder = responderWithLlm(async () => null);
    const content = await responder.answerChat({
      user: viewer('1', 'Bia'),
      text: 'oi Lia',
      coins: 0,
    });

    assert.equal(content.text, 'Oi, Bia!');
    assert.equal(content.intent, 'greeting');
  });

  it('não repete a mesma fala em sequência', () => {
    const lines = testLines({ gift: { bronze: ['A {name}', 'B {name}', 'C {name}'] } });
    const responder = new CharacterResponder(lines, { rng: () => 0 });
    const context = {
      user: viewer('1', 'Bia'),
      giftName: 'Rosa',
      coins: 2,
      tier: 'bronze',
      repeat: 1,
    };

    const first = responder.thankGift(context).text;
    const second = responder.thankGift(context).text;
    assert.notEqual(first, second);
  });
});

describe('render/sanitize', () => {
  it('substitui variáveis conhecidas e mantém as desconhecidas', () => {
    assert.equal(render('{name} mandou {gift} para {foo}', { name: 'Bia', gift: 'Rosa' }), 'Bia mandou Rosa para {foo}');
  });

  it('remove markdown e quebras de linha', () => {
    assert.equal(sanitize('**oi**\n\ntudo bem?'), 'oi tudo bem?');
  });

  it('rejeita texto que se identifica como IA', () => {
    assert.equal(sanitize('Como uma IA, eu não posso opinar'), '');
  });

  it('limita o tamanho da fala', () => {
    const long = 'a'.repeat(400);
    assert.ok(sanitize(long).length <= 180);
  });
});
