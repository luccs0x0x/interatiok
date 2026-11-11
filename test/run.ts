/**
 * Runner de testes em processo único.
 *
 * `node --test` abre um processo por arquivo; em ambientes com sandbox isso pode
 * ser bloqueado (spawn EPERM). Importar os arquivos aqui roda tudo no mesmo
 * processo, com o mesmo runner do `node:test`.
 */
import './chatScheduler.test.js';
import './giftCombiner.test.js';
import './gameEngine.test.js';
import './responder.test.js';
import './server.test.js';
import './sessionStore.test.js';
