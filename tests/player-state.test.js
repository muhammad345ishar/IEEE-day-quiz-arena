import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePlayerState } from '../src/player-state.js';

const questionBank = [
  { question: 'First question', options: [{ text: 'B', originalIndex: 1 }, { text: 'C', originalIndex: 2 }, { text: 'A', originalIndex: 0 }, { text: 'D', originalIndex: 3 }] },
];

function snapshot(overrides = {}) {
  return {
    state: { gameId: 'game-one', phase: 'running', totalQuestions: 10, startedAt: 100, playerCount: 2, finishedCount: 0 },
    player: { id: 'P-001', name: 'Alex', progress: 2, finished: false, correct: null, totalTimeMs: null, rank: null },
    questions: questionBank,
    serverNow: 500,
    ...overrides,
  };
}

test('a delayed me response cannot roll back newer socket progress or clock', () => {
  const current = snapshot();
  const incoming = snapshot({ player: { ...current.player, progress: 1 }, serverNow: 400 });
  const result = mergePlayerState(current, incoming);
  assert.deepEqual(result.player, current.player);
  assert.equal(result.serverNow, 500);
  assert.deepEqual(result.state, current.state);
});

test('an old answer response cannot restore the previous game after reset', () => {
  const reset = snapshot({ state: { gameId: 'game-two', phase: 'closed', totalQuestions: 3 }, player: null, questions: [], serverNow: 900 });
  const oldAnswer = snapshot({ serverNow: 800 });
  assert.equal(mergePlayerState(reset, oldAnswer), reset);
  assert.equal(mergePlayerState(reset, oldAnswer).player, null);
  assert.deepEqual(mergePlayerState(reset, oldAnswer).questions, []);
});

test('authoritative new-game state clears the previous identity and question bank', () => {
  const current = snapshot();
  const newState = { state: { gameId: 'game-two', phase: 'closed', totalQuestions: 3 }, serverNow: 900 };
  const result = mergePlayerState(current, newState, true);
  assert.deepEqual(result.state, newState.state);
  assert.equal(result.player, null);
  assert.deepEqual(result.questions, []);
});

test('late question-bank data is retained while newer progress remains intact', () => {
  const current = snapshot({ questions: [] });
  const lateMe = snapshot({ player: { ...current.player, progress: 0 }, serverNow: 200 });
  const result = mergePlayerState(current, lateMe);
  assert.deepEqual(result.questions, questionBank);
  assert.equal(result.player.progress, 2);
  assert.equal(result.serverNow, current.serverNow);
  const stateOnly = mergePlayerState(result, { state: result.state, serverNow: 600 });
  assert.deepEqual(stateOnly.questions, questionBank);
  assert.deepEqual(stateOnly.player, current.player);
  const emptyBank = mergePlayerState(stateOnly, { ...stateOnly, questions: [], serverNow: 700 });
  assert.deepEqual(emptyBank.questions, questionBank);
});

test('same-millisecond stale progress cannot undo a final result', () => {
  const current = snapshot({ player: { id: 'P-001', name: 'Alex', progress: 10, finished: true, correct: 8, totalTimeMs: 400, rank: 1 } });
  for (const progress of [9, 10]) {
    const stale = snapshot({ player: { ...current.player, progress, finished: false, correct: null, totalTimeMs: null, rank: null } });
    const result = mergePlayerState(current, stale);
    assert.deepEqual(result.player, current.player);
    assert.equal(result.serverNow, current.serverNow);
  }
});

test('a newly joined identity is accepted even if a newer public state arrived first', () => {
  const waiting = snapshot({ player: null, questions: [], serverNow: 600 });
  const joinResponse = snapshot({ serverNow: 500 });
  const result = mergePlayerState(waiting, joinResponse);
  assert.deepEqual(result.player, joinResponse.player);
  assert.equal(result.serverNow, 600);
  assert.deepEqual(result.state, waiting.state);
});

test('an earlier phase cannot restore lobby or running after the game advances', () => {
  const current = snapshot({ state: { ...snapshot().state, phase: 'finished', finishedCount: 2 } });
  for (const phase of ['closed', 'lobby', 'running']) {
    for (const serverNow of [400, 500, 600]) {
      const result = mergePlayerState(current, { state: { ...current.state, phase, finishedCount: 0 }, serverNow });
      assert.equal(result.state.phase, 'finished');
      assert.equal(result.state.finishedCount, 2);
      assert.deepEqual(result.player, current.player);
    }
  }
});

test('later live ranks still update finished players and inputs remain unchanged', () => {
  const current = snapshot({ player: { id: 'P-001', name: 'Alex', progress: 10, finished: true, correct: 8, totalTimeMs: 400, rank: 1 } });
  const incoming = { state: current.state, player: { ...current.player, rank: 2 }, serverNow: 800 };
  const beforeCurrent = structuredClone(current);
  const beforeIncoming = structuredClone(incoming);
  const result = mergePlayerState(current, incoming);
  assert.equal(result.player.rank, 2);
  assert.deepEqual(result.questions, questionBank);
  assert.deepEqual(current, beforeCurrent);
  assert.deepEqual(incoming, beforeIncoming);
});
