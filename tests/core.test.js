import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QuizGame, GameError, formatPlayerId, getOptionOrder, shuffleOptions, gradeAnswer, rankPlayers,
} from '../server/game.js';

const questions = [
  { question: 'Which option is C?', options: ['A', 'B', 'C', 'D'], correctIndex: 2 },
  { question: 'Which option is A?', options: ['A', 'B', 'C', 'D'], correctIndex: 0 },
  { question: 'Which option is D?', options: ['A', 'B', 'C', 'D'], correctIndex: 3 },
];

function setup(bank = questions) {
  let clock = 1_000;
  const now = () => clock;
  const game = new QuizGame({ questions: bank, now });
  return { game, now, at(value) { clock = value; } };
}

function submit(game, player, questionIndex, optionIndex = game.questions[questionIndex].correctIndex) {
  return game.answer(player.id, { gameId: game.gameId, questionIndex, optionIndex });
}

function status(expected) {
  return (error) => error instanceof GameError && error.status === expected;
}

test('option order is stable by player/question and only changes option position', () => {
  const original = structuredClone(questions[0]);
  const order = getOptionOrder('P-042', 0);
  assert.deepEqual(order, getOptionOrder('P-042', 0));
  assert.deepEqual([...order].sort(), [0, 1, 2, 3]);
  const distinctPlayerOrders = new Set(Array.from({ length: 100 }, (_, i) => getOptionOrder(formatPlayerId(i + 1), 0).join(',')));
  const distinctQuestionOrders = new Set(Array.from({ length: 100 }, (_, i) => getOptionOrder('P-042', i).join(',')));
  assert.ok(distinctPlayerOrders.size > 15);
  assert.ok(distinctQuestionOrders.size > 15);
  const shuffled = shuffleOptions(questions[0], 'P-042', 0);
  assert.deepEqual(shuffled.options.map((option) => option.originalIndex), order);
  for (const option of shuffled.options) assert.equal(option.text, questions[0].options[option.originalIndex]);
  assert.deepEqual(questions[0], original);
  assert.equal(Object.hasOwn(shuffled, 'correctIndex'), false);
});

test('server grading is correct at every screen position for all 24 seeded shuffles', () => {
  const examples = new Map();
  for (let number = 1; number <= 2_000 && examples.size < 24; number += 1) {
    examples.set(getOptionOrder(formatPlayerId(number), 0).join(','), number);
  }
  assert.equal(examples.size, 24, 'The seed set covers every permutation.');
  for (const [key, number] of examples) {
    for (let position = 0; position < 4; position += 1) {
      const { game: initial, now } = setup([questions[0]]);
      const saved = initial.serialize();
      saved.idCounter = number - 1;
      const game = new QuizGame({ questions: [questions[0]], saved, now });
      game.open();
      const player = game.join('Every shuffle');
      game.start();
      const choices = game.questionsForPlayer(player.id)[0].options;
      assert.equal(choices.map((choice) => choice.originalIndex).join(','), key);
      const selected = choices[position];
      const result = submit(game, player, 0, selected.originalIndex);
      assert.equal(result.correct, selected.text === 'C' ? 1 : 0, `${key}, screen position ${position}`);
    }
  }
  for (const invalid of [-1, 4, 1.1, '2', null, undefined]) {
    assert.throws(() => gradeAnswer(questions[0], invalid), status(400));
  }
});

test('all players receive the full bank in its shared question order, without answer keys', () => {
  const { game } = setup();
  game.open();
  const first = game.join('Same name');
  const second = game.join('Same name');
  assert.deepEqual(game.questionsForPlayer(first.id), []);
  game.start();
  for (const player of [first, second]) {
    const bank = game.questionsForPlayer(player.id);
    assert.equal(bank.length, questions.length);
    assert.deepEqual(bank.map((question) => question.question), questions.map((question) => question.question));
    assert.equal(JSON.stringify(bank).includes('correctIndex'), false);
    assert.equal(JSON.stringify(bank).includes(player.token), false);
  }
});

test('IDs and tokens are unique even with duplicate names, and IDs survive reset/restart', () => {
  const { game, now } = setup();
  game.open();
  const joined = Array.from({ length: 1_500 }, () => game.join('Alex'));
  assert.equal(new Set(joined.map((player) => player.id)).size, joined.length);
  assert.equal(new Set(joined.map((player) => player.token)).size, joined.length);
  assert.equal(joined[0].id, 'P-001');
  assert.equal(joined[41].id, 'P-042');
  assert.equal(joined[1_499].id, 'P-1500');
  assert.throws(() => game.join(' '), status(400));
  assert.throws(() => game.join('A'.repeat(81)), status(400));
  const restored = new QuizGame({ questions, saved: game.serialize(), now });
  assert.equal(restored.join('Alex').id, 'P-1501');
  restored.reset(questions);
  restored.open();
  assert.equal(restored.join('Alex').id, 'P-1502');
  assert.throws(() => formatPlayerId(0), status(400));
  assert.throws(() => formatPlayerId(1.2), status(400));
});

test('restoration repairs a lower ID counter instead of reusing an existing ID', () => {
  const { game, now } = setup();
  game.open();
  game.join('One');
  game.join('Two');
  const saved = game.serialize();
  saved.idCounter = 0;
  const restored = new QuizGame({ questions, saved, now });
  assert.equal(restored.join('Three').id, 'P-003');
  saved.idCounter = -1;
  assert.throws(() => new QuizGame({ questions, saved, now }), /refusing to reuse player IDs/);
});

test('ranking uses correct count, total time, earlier finish and stable IDs in that order', () => {
  const players = [
    { id: 'P-004', correct: 3, totalTimeMs: 8_000, finishedAt: 9_000, finishSequence: 4 },
    { id: 'P-002', correct: 3, totalTimeMs: 7_000, finishedAt: 8_000, finishSequence: 2 },
    { id: 'P-003', correct: 3, totalTimeMs: 7_000, finishedAt: 8_000, finishSequence: 3 },
    { id: 'P-001', correct: 2, totalTimeMs: 1_000, finishedAt: 2_000, finishSequence: 1 },
    { id: 'P-005', correct: 4, totalTimeMs: 10_000, finishedAt: 11_000, finishSequence: 5 },
    { id: 'P-006', correct: 9, totalTimeMs: 10, kicked: true },
  ];
  const before = structuredClone(players);
  const ranked = rankPlayers(players);
  assert.deepEqual(ranked.map((player) => player.id), ['P-005', 'P-002', 'P-003', 'P-004', 'P-001']);
  assert.deepEqual(ranked.map((player) => player.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(players, before, 'Ranking does not mutate records.');
  assert.deepEqual(rankPlayers([
    { id: 'P-010', correct: 0, totalTimeMs: null },
    { id: 'P-002', correct: 0, totalTimeMs: null },
  ]).map((player) => player.id), ['P-002', 'P-010']);
});

test('all timers share the admin start; only the final server submission fixes total time', () => {
  const { game, at } = setup();
  game.open();
  const fast = game.join('Fast');
  at(5_000);
  const slow = game.join('Slow');
  at(10_000);
  game.start();
  assert.equal(fast.startedAt, slow.startedAt);
  assert.equal(game.startedAt, 10_000);
  at(11_000);
  submit(game, fast, 0);
  at(12_000);
  submit(game, fast, 1);
  assert.equal(game.playerView(fast.id).totalTimeMs, null);
  at(13_000);
  const result = game.answer(fast.id, {
    gameId: game.gameId, questionIndex: 2, optionIndex: 3, submittedAt: 1, totalTimeMs: 1,
  });
  assert.equal(result.totalTimeMs, 3_000);
  assert.equal(result.correct, 3);
  assert.equal(result.rank, 1);
  at(50_000);
  assert.equal(game.playerView(fast.id).totalTimeMs, 3_000);
  assert.equal(game.leaderboard({ admin: true }).find((player) => player.id === slow.id).totalTimeMs, 40_000);
});

test('server locks every answer and rejects skipped, repeated, stale and malformed submissions', () => {
  const { game } = setup();
  assert.throws(() => game.join('Too soon'), status(409));
  assert.throws(() => game.start(), status(409));
  game.open();
  assert.throws(() => game.start(), status(409));
  const player = game.join('Player');
  game.start();
  assert.throws(() => game.join('Too late'), status(409));
  assert.throws(() => submit(game, player, 1), status(409));
  assert.throws(() => submit(game, player, 0, '2'), status(400));
  assert.throws(() => game.answer(player.id, { gameId: 'old', questionIndex: 0, optionIndex: 2 }), status(409));
  submit(game, player, 0);
  const saved = structuredClone(player.answers);
  assert.throws(() => submit(game, player, 0, 1), status(409));
  assert.deepEqual(player.answers, saved);
  assert.throws(() => submit(game, player, 2), status(409));
  submit(game, player, 1);
  submit(game, player, 2);
  assert.throws(() => submit(game, player, 2), status(409));
  assert.equal(player.correct, 3);
  assert.equal(game.phase, 'finished');
});

test('players receive no correctness or rank information until their final answer', () => {
  const { game } = setup();
  game.open();
  const player = game.join('Privacy');
  game.start();
  const response = submit(game, player, 0);
  assert.deepEqual(response, {
    id: player.id, name: 'Privacy', progress: 1, finished: false, forced: false,
    correct: null, rank: null, totalTimeMs: null,
  });
  assert.equal(JSON.stringify(response).includes('answers'), false);
  assert.equal(JSON.stringify(response).includes(player.token), false);
  assert.equal(game.leaderboard({ admin: true })[0].correct, 1);
  assert.equal(game.questionsForPlayer(player.id).some((question) => Object.hasOwn(question, 'correctIndex')), false);
});

test('finish sequence settles submissions in the same server millisecond', () => {
  const { game, at } = setup([questions[0]]);
  game.open();
  const firstJoiner = game.join('Same');
  const secondJoiner = game.join('Same');
  game.start();
  at(2_000);
  submit(game, secondJoiner, 0);
  submit(game, firstJoiner, 0);
  assert.equal(game.playerView(secondJoiner.id).rank, 1);
  assert.equal(game.playerView(firstJoiner.id).rank, 2);
  assert.equal(game.phase, 'finished');
  assert.equal(game.endedAt, 2_000);
});

test('force-end preserves finishers and grades unanswered questions as zero credit', () => {
  const { game, at } = setup();
  game.open();
  const finished = game.join('Finished');
  const partial = game.join('Partial');
  const absent = game.join('Offline');
  game.start();
  at(2_000);
  for (let i = 0; i < questions.length; i += 1) submit(game, finished, i);
  submit(game, partial, 0);
  at(9_000);
  game.end();
  assert.equal(game.playerView(finished.id).totalTimeMs, 1_000);
  assert.equal(game.playerView(finished.id).forced, false);
  assert.deepEqual(game.playerView(partial.id), {
    id: partial.id, name: 'Partial', progress: 1, correct: 1,
    finished: true, forced: true, totalTimeMs: 8_000, rank: 2,
  });
  assert.equal(game.playerView(absent.id).correct, 0);
  assert.equal(game.stateView().finishedCount, 3);
});

test('hidden leaderboard conceals ranking order, score and time until everyone finishes', () => {
  const { game } = setup();
  game.open();
  const first = game.join('First');
  const second = game.join('Second');
  game.start();
  submit(game, second, 0);
  game.setHide(true);
  const hidden = game.leaderboard();
  assert.deepEqual(hidden.map((player) => player.id), [first.id, second.id]);
  assert.ok(hidden.every((player) => player.correct === null && player.rank === null && player.totalTimeMs === null));
  assert.equal(hidden[1].progress, 1);
  assert.equal(game.leaderboard({ admin: true })[0].id, second.id);
  assert.throws(() => game.setHide('yes'), status(400));
  game.end();
  assert.equal(game.leaderboard()[0].id, second.id);
  assert.equal(game.leaderboard()[0].rank, 1);
  assert.equal(game.leaderboard()[0].correct, 1);
});

test('kick revokes player access and excludes scores while retaining the audit record', () => {
  const { game } = setup();
  game.open();
  const kicked = game.join('Removed');
  const kept = game.join('Remaining');
  game.start();
  submit(game, kicked, 0);
  game.kick(kicked.id);
  assert.throws(() => game.playerView(kicked.id), status(403));
  assert.throws(() => game.questionsForPlayer(kicked.id), status(403));
  assert.throws(() => submit(game, kicked, 1), status(403));
  assert.equal(game.stateView().playerCount, 1);
  assert.deepEqual(game.leaderboard().map((player) => player.id), [kept.id]);
  assert.equal(game.serialize().players.find((player) => player.id === kicked.id).answers.length, 1);
  assert.throws(() => game.kick('P-missing'), status(401));
});

test('recovery preserves question snapshot, answer locks, shuffle, identity and running time', () => {
  const { game, now, at } = setup();
  game.open();
  const player = game.join('Recovery');
  game.start();
  at(2_000);
  submit(game, player, 0);
  const before = game.questionsForPlayer(player.id);
  const saved = JSON.parse(JSON.stringify(game.serialize()));
  const editedBank = [{ question: 'Edited file', options: ['One', 'Two', 'Three', 'Four'], correctIndex: 0 }];
  at(100_000);
  const restored = new QuizGame({ questions: editedBank, saved, now });
  assert.equal(restored.gameId, game.gameId);
  assert.equal(restored.players.get(player.id).token, player.token);
  assert.deepEqual(restored.questionsForPlayer(player.id), before);
  assert.equal(restored.playerView(player.id).progress, 1);
  assert.throws(() => submit(restored, player, 0), status(409));
  submit(restored, player, 1);
  submit(restored, player, 2);
  assert.equal(restored.playerView(player.id).totalTimeMs, 99_000);
  restored.reset(editedBank);
  assert.equal(restored.questions.length, 1);
  assert.notEqual(restored.gameId, game.gameId);
  assert.equal(restored.phase, 'closed');
  assert.throws(() => restored.playerView(player.id), status(401));
  restored.open();
  assert.equal(restored.join('Next').id, 'P-002');
});

test('unoccupied restart refreshes questions and failed reset does not corrupt the live game', () => {
  const { game, now } = setup();
  const changed = [questions[1]];
  const restored = new QuizGame({ questions: changed, saved: game.serialize(), now });
  assert.deepEqual(restored.questions, changed);
  restored.open();
  restored.join('Current');
  const before = restored.serialize();
  assert.throws(() => restored.reset([]), status(400));
  assert.deepEqual(restored.serialize(), before);
});

test('large question banks are not truncated and leaderboard payload defaults to ten rows', () => {
  const bank = Array.from({ length: 401 }, (_, index) => ({ ...questions[index % 3], question: `Question ${index + 1}` }));
  const { game } = setup(bank);
  game.open();
  for (let i = 0; i < 160; i += 1) game.join(`Player ${i}`);
  game.start();
  assert.equal(game.stateView().totalQuestions, 401);
  assert.equal(game.questionsForPlayer('P-001').length, 401);
  assert.equal(game.leaderboard().length, 10);
  assert.equal(game.leaderboard({ admin: true, limit: Infinity }).length, 160);
});
