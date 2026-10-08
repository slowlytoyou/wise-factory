import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UPGRADES, PRESTIGE_THRESHOLD,
  createGame, tick, buyUpgrade, upgradeCost, productionRate, pulse,
  prestige, canPrestige, toggleAutomation, automationUnlocked,
  serializeGame, hydrateGame,
} from '../src/model.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

test('a new workshop earns without input and can afford its first drone', () => {
  const game = createGame(1000);
  assert.equal(UPGRADES.length, 5);
  assert.equal(game.dust, 25);
  assert.equal(upgradeCost(game, 0), 15);
  close(productionRate(game), 0.35);
  const result = tick(game, 10);
  close(result.earned, 3.5);
  close(game.dust, 28.5);
  assert.equal(buyUpgrade(game, 0).ok, true);
  close(productionRate(game), 1.15);
  assert.ok(upgradeCost(game, 0) > 15);
  assert.equal(buyUpgrade(game, 4).ok, false);
  assert.equal(buyUpgrade(game, -1).ok, false);
  assert.equal(buyUpgrade(game, 0.5).ok, false);
  assert.equal(upgradeCost(game, 99), Infinity);
});

test('passive earnings and pulse cooldown are independent of render frame rate', () => {
  const whole = createGame(0);
  const frames = createGame(0);
  for (const game of [whole, frames]) {
    buyUpgrade(game, 0);
    assert.equal(pulse(game).ok, true);
    assert.equal(pulse(game).ok, false);
  }
  tick(whole, 120);
  for (let frame = 0; frame < 120 * 30; frame += 1) tick(frames, 1 / 30);
  for (const key of ['dust', 'lifetimeDust', 'runDust', 'elapsed', 'pulseCooldown']) close(whole[key], frames[key]);
  assert.equal(pulse(whole).ok, true);
  assert.equal(pulse(frames).ok, true);
});

test('invalid deltas neither mint currency nor poison state', () => {
  const game = createGame(0);
  const before = serializeGame(game, 0);
  for (const delta of [-1, NaN, Infinity, undefined, '10']) {
    assert.deepEqual(tick(game, delta), { earned: 0, events: [] });
  }
  assert.deepEqual(serializeGame(game, 0), before);
});

test('corrupt, unknown and malformed saves are safe to load', () => {
  for (const raw of [null, [], '{oops', 5, { version: 9000 }, '{}']) {
    const result = hydrateGame(raw, 1000);
    assert.deepEqual(result.game, createGame(1000));
    assert.equal(result.offlineEarned, 0);
  }
  const { game } = hydrateGame({
    version: 1, dust: NaN, lifetimeDust: -10, runDust: Infinity,
    levels: [-1, Infinity, '3', 1.9, 1e20], prestigeCount: -5,
    elapsed: {}, pulseCooldown: 100, autoBuy: 'yes', autoElapsed: NaN,
    achievements: ['<script>', '第一', null, '첫 번째 설비', '첫 번째 설비'], savedAt: 'yesterday',
  }, 1000);
  assert.equal(game.dust, 25);
  assert.equal(game.lifetimeDust, 0);
  assert.equal(game.runDust, 0);
  assert.deepEqual(game.levels, [0, 0, 0, 1, 1000]);
  assert.equal(game.prestigeCount, 0);
  assert.equal(game.pulseCooldown, 1.5);
  assert.equal(game.autoBuy, false);
  assert.equal(game.achievements.filter(name => name === '첫 번째 설비').length, 1);
  assert.equal(game.achievements.includes('<script>'), false);
  assert.ok(Number.isFinite(productionRate(game)));
  assert.ok(Number.isFinite(tick(game, 1).earned));
});

test('loading after a long absence preserves currency, automation and cooldowns', () => {
  const game = createGame(10_000);
  buyUpgrade(game, 0);
  tick(game, 1000);
  game.autoBuy = true;
  game.autoElapsed = 3;
  pulse(game);
  const raw = serializeGame(game, 10_000);
  for (const resumedAt of [0, 10_000, 10_000 + 30 * 24 * 60 * 60 * 1000]) {
    const restored = hydrateGame(JSON.stringify(raw), resumedAt);
    assert.equal(restored.offlineSeconds, 0);
    assert.equal(restored.offlineEarned, 0);
    assert.deepEqual(serializeGame(restored.game, 0), serializeGame(game, 0));
    assert.equal(restored.game.savedAt, resumedAt);
    const result = tick(restored.game, 1);
    assert.ok(result.earned > 0);
    assert.equal(restored.game.autoElapsed, 4);
    assert.equal(restored.game.pulseCooldown, .5);
  }
});

test('prestige requires run earnings and preserves permanent progress', () => {
  const game = createGame(0);
  assert.equal(canPrestige(game), false);
  assert.equal(prestige(game).ok, false);
  game.lifetimeDust = PRESTIGE_THRESHOLD * 2;
  game.runDust = PRESTIGE_THRESHOLD;
  game.dust = 50_000;
  buyUpgrade(game, 4);
  game.autoBuy = true;
  assert.equal(canPrestige(game), true);
  assert.equal(prestige(game).ok, true);
  assert.equal(game.dust, 25);
  assert.equal(game.runDust, 0);
  assert.equal(game.lifetimeDust, PRESTIGE_THRESHOLD * 2);
  assert.equal(game.prestigeCount, 1);
  assert.deepEqual(game.levels, [0, 0, 0, 0, 0]);
  assert.equal(game.autoBuy, false);
  close(productionRate(game), 0.35 * 1.5);
  assert.ok(game.achievements.includes('새로운 별의 탄생'));
  assert.equal(automationUnlocked(game), true);
});

test('automation requires unlock and explicit activation', () => {
  const game = createGame(0);
  assert.equal(toggleAutomation(game).ok, false);
  game.dust = 1000;
  game.lifetimeDust = 500;
  tick(game, 10);
  assert.deepEqual(game.levels, [0, 0, 0, 0, 0]);
  assert.equal(toggleAutomation(game).ok, true);
  assert.equal(game.autoBuy, true);
  tick(game, 4);
  assert.deepEqual(game.levels, [0, 0, 0, 0, 0]);
  const result = tick(game, 1);
  assert.equal(game.levels.reduce((sum, value) => sum + value, 0), 1);
  assert.ok(result.events.some(event => event.startsWith('자동 구매')));
  assert.equal(toggleAutomation(game).ok, true);
  assert.equal(game.autoBuy, false);
});

test('automation buys and production are invariant to tick splitting', () => {
  const whole = createGame(0);
  whole.dust = 10_000;
  whole.lifetimeDust = 500;
  toggleAutomation(whole);
  const frames = hydrateGame(serializeGame(whole, 0), 0).game;
  tick(whole, 100);
  for (let frame = 0; frame < 1000; frame += 1) tick(frames, 0.1);
  assert.deepEqual(whole.levels, frames.levels);
  close(whole.dust, frames.dust);
  close(whole.runDust, frames.runDust);
  close(whole.lifetimeDust, frames.lifetimeDust);
  close(whole.autoElapsed, frames.autoElapsed);
});

test('save records are detached and exclude transient properties', () => {
  const game = createGame(0);
  game.visualParticles = [{ color: 'pink' }];
  const save = serializeGame(game, 10_000);
  save.levels[0] = 50;
  save.achievements.push('fake');
  assert.equal(game.levels[0], 0);
  assert.equal(game.achievements.includes('fake'), false);
  assert.equal(save.savedAt, 10_000);
  assert.equal('visualParticles' in save, false);
});
