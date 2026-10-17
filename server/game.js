import { createHash, randomBytes, randomUUID } from 'node:crypto';

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'GameError';
    this.status = status;
  }
}

export function formatPlayerId(counter) {
  if (!Number.isSafeInteger(counter) || counter < 1) {
    throw new GameError('Player ID counter must be a positive safe integer.');
  }
  return `P-${String(counter).padStart(3, '0')}`;
}

/** Fisher–Yates with a deterministic stream, unique to the player/question seed. */
export function getOptionOrder(playerId, questionIndex) {
  if (typeof playerId !== 'string' || !Number.isInteger(questionIndex) || questionIndex < 0) {
    throw new GameError('A player ID and a valid question index are required.');
  }
  let seed = createHash('sha256').update(`${playerId}:${questionIndex + 1}`).digest().readUInt32LE(0);
  const random = () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const order = [0, 1, 2, 3];
  for (let position = order.length - 1; position > 0; position -= 1) {
    const other = Math.floor(random() * (position + 1));
    [order[position], order[other]] = [order[other], order[position]];
  }
  return order;
}

export function shuffleOptions(question, playerId, questionIndex) {
  return {
    question: question.question,
    options: getOptionOrder(playerId, questionIndex).map((originalIndex) => ({
      text: question.options[originalIndex], originalIndex,
    })),
  };
}

export function gradeAnswer(question, originalOptionIndex) {
  if (!Number.isInteger(originalOptionIndex) || originalOptionIndex < 0 || originalOptionIndex > 3) {
    throw new GameError('optionIndex must be an integer from 0 to 3.');
  }
  return originalOptionIndex === question.correctIndex;
}

function elapsed(player, now, startedAt) {
  if (player.totalTimeMs !== null && player.totalTimeMs !== undefined) return player.totalTimeMs;
  const start = player.startedAt ?? startedAt;
  return start === null || start === undefined ? 0 : Math.max(0, now - start);
}

/** Stable fallback order matters when unfinished players currently have equal scores. */
export function rankPlayers(players, now = Date.now(), startedAt = null) {
  const list = players instanceof Map ? [...players.values()] : [...players];
  return list.filter((player) => !player.kicked).map((player) => ({
    ...player,
    totalTimeMs: elapsed(player, now, startedAt),
  })).sort((left, right) => (
    right.correct - left.correct
    || left.totalTimeMs - right.totalTimeMs
    || (left.finishedAt ?? Infinity) - (right.finishedAt ?? Infinity)
    || (left.finishSequence ?? Infinity) - (right.finishSequence ?? Infinity)
    || (left.joinedAt ?? 0) - (right.joinedAt ?? 0)
    || left.id.localeCompare(right.id, 'en', { numeric: true })
  )).map((player, index) => ({ ...player, rank: index + 1 }));
}

function copyQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new GameError('At least one question is required.');
  }
  return questions.map((question, index) => {
    if (!question || typeof question.question !== 'string' || !question.question.trim()
      || !Array.isArray(question.options) || question.options.length !== 4
      || question.options.some((option) => typeof option !== 'string' || !option.trim())
      || !Number.isInteger(question.correctIndex) || question.correctIndex < 0 || question.correctIndex > 3) {
      throw new GameError(`Question ${index + 1} is invalid. Validate questions.json before starting.`);
    }
    return { question: question.question, options: [...question.options], correctIndex: question.correctIndex };
  });
}

function savedCounter(saved) {
  if (!Number.isSafeInteger(saved.idCounter) || saved.idCounter < 0) {
    throw new Error('Saved game has an invalid player ID counter; refusing to reuse player IDs.');
  }
  let maximum = saved.idCounter;
  const seen = new Set();
  for (const player of saved.players) {
    const match = /^P-(\d+)$/.exec(player.id);
    const number = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(number) || number < 1 || seen.has(player.id)) {
      throw new Error('Saved game has invalid or duplicate player IDs.');
    }
    if (typeof player.token !== 'string' || !player.token || !Array.isArray(player.answers)) {
      throw new Error(`Saved game has an invalid player record: ${player.id}.`);
    }
    seen.add(player.id);
    maximum = Math.max(maximum, number);
  }
  return maximum;
}

export class QuizGame {
  constructor({ questions, saved = null, now = Date.now } = {}) {
    this.now = now;
    this.idCounter = 0;
    this.finishCounter = 0;
    this.players = new Map();
    this.questions = copyQuestions(questions);
    this.gameId = randomUUID();
    this.phase = 'closed';
    this.startedAt = null;
    this.endedAt = null;
    this.hideLeaderboardNumbers = false;
    if (saved) {
      if (!Array.isArray(saved.players) || !['closed', 'lobby', 'running', 'finished'].includes(saved.phase)
        || typeof saved.gameId !== 'string' || !saved.gameId) {
        throw new Error('Saved game is invalid; restore the saved file before starting.');
      }
      this.idCounter = savedCounter(saved);
      this.players = new Map(saved.players.map((player) => [player.id, structuredClone(player)]));
      // An occupied recovered game must keep exactly the questions its players received.
      if (saved.players.length > 0 || ['running', 'finished'].includes(saved.phase)) {
        this.questions = copyQuestions(saved.questions);
      }
      this.gameId = saved.gameId;
      this.phase = saved.phase;
      this.startedAt = saved.startedAt ?? null;
      this.endedAt = saved.endedAt ?? null;
      this.hideLeaderboardNumbers = Boolean(saved.hideLeaderboardNumbers);
      this.finishCounter = Math.max(saved.finishCounter ?? 0, ...saved.players.map((player) => player.finishSequence ?? 0));
    }
  }

  activePlayers() {
    return [...this.players.values()].filter((player) => !player.kicked);
  }

  requirePlayer(id) {
    const player = this.players.get(id);
    if (!player) throw new GameError('Player session not found. Join the current game.', 401);
    if (player.kicked) throw new GameError('You have been removed from this game.', 403);
    return player;
  }

  join(name) {
    if (this.phase !== 'lobby') throw new GameError('The lobby is not open for joining.', 409);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
      throw new GameError('Enter a name between 1 and 80 characters.');
    }
    if (this.idCounter === Number.MAX_SAFE_INTEGER) throw new GameError('Player ID capacity reached.', 503);
    const player = {
      id: formatPlayerId(++this.idCounter),
      name: name.trim(),
      token: randomBytes(32).toString('base64url'),
      joinedAt: this.now(),
      startedAt: null,
      answers: [],
      correct: 0,
      finishedAt: null,
      totalTimeMs: null,
      finishSequence: null,
      forced: false,
      kicked: false,
      kickedAt: null,
    };
    this.players.set(player.id, player);
    return player;
  }

  open() {
    if (this.phase !== 'closed') throw new GameError('Reset the game before opening a new lobby.', 409);
    this.phase = 'lobby';
    return this.stateView();
  }

  start() {
    if (this.phase !== 'lobby') throw new GameError('Open the lobby before starting the quiz.', 409);
    if (this.activePlayers().length === 0) throw new GameError('At least one player must join before starting.', 409);
    this.startedAt = this.now();
    this.phase = 'running';
    for (const player of this.activePlayers()) player.startedAt = this.startedAt;
    return this.stateView();
  }

  finishPlayer(player, at, forced) {
    if (player.finishedAt !== null) return;
    player.finishedAt = at;
    player.totalTimeMs = Math.max(0, at - this.startedAt);
    player.finishSequence = ++this.finishCounter;
    player.forced = forced;
  }

  finishIfComplete(at) {
    if (this.phase === 'running' && this.activePlayers().every((player) => player.finishedAt !== null)) {
      this.phase = 'finished';
      this.endedAt = at;
    }
  }

  answer(id, { gameId, questionIndex, optionIndex } = {}) {
    const player = this.requirePlayer(id);
    if (gameId !== this.gameId) throw new GameError('This answer belongs to an old game. Reload to rejoin.', 409);
    if (this.phase !== 'running') throw new GameError('The quiz is not accepting answers.', 409);
    if (player.finishedAt !== null) throw new GameError('You have already finished the quiz.', 409);
    if (!Number.isInteger(questionIndex) || questionIndex !== player.answers.length) {
      throw new GameError('Only the next unanswered question can be submitted. Answers are locked.', 409);
    }
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 3) {
      throw new GameError('optionIndex must be an integer from 0 to 3.');
    }
    const at = this.now();
    const correct = gradeAnswer(this.questions[questionIndex], optionIndex);
    player.answers.push({ questionIndex, optionIndex, correct, submittedAt: at });
    if (correct) player.correct += 1;
    if (player.answers.length === this.questions.length) this.finishPlayer(player, at, false);
    this.finishIfComplete(at);
    return this.playerView(id);
  }

  end() {
    if (this.phase !== 'running') throw new GameError('Only a running quiz can be ended.', 409);
    const at = this.now();
    for (const player of this.activePlayers()) this.finishPlayer(player, at, true);
    this.phase = 'finished';
    this.endedAt = at;
    return this.stateView();
  }

  kick(id) {
    const player = this.requirePlayer(id);
    player.kicked = true;
    player.kickedAt = this.now();
    this.finishIfComplete(player.kickedAt);
    return this.stateView();
  }

  reset(questions) {
    const freshQuestions = copyQuestions(questions);
    this.questions = freshQuestions;
    this.players = new Map();
    this.gameId = randomUUID();
    this.phase = 'closed';
    this.startedAt = null;
    this.endedAt = null;
    this.finishCounter = 0;
    return this.stateView();
  }

  setHide(hide) {
    if (typeof hide !== 'boolean') throw new GameError('hideLeaderboardNumbers must be a boolean.');
    this.hideLeaderboardNumbers = hide;
    return this.stateView();
  }

  questionsForPlayer(id) {
    this.requirePlayer(id);
    if (!['running', 'finished'].includes(this.phase)) return [];
    return this.questions.map((question, index) => shuffleOptions(question, id, index));
  }

  playerView(id) {
    const player = this.requirePlayer(id);
    const finished = player.finishedAt !== null;
    return {
      id: player.id, name: player.name, progress: player.answers.length,
      finished, forced: player.forced,
      totalTimeMs: finished ? player.totalTimeMs : null,
      correct: finished ? player.correct : null,
      rank: finished ? rankPlayers(this.players, this.now(), this.startedAt).find((entry) => entry.id === id).rank : null,
    };
  }

  leaderboard({ admin = false, limit = 10 } = {}) {
    const conceal = this.hideLeaderboardNumbers && this.phase !== 'finished' && !admin;
    // Sorting by score would reveal hidden scores, so private leaderboards use join order.
    const ordered = conceal ? this.activePlayers() : rankPlayers(this.players, this.now(), this.startedAt);
    return ordered.slice(0, limit).map((player) => ({
      id: player.id, name: player.name, progress: player.answers.length,
      finished: player.finishedAt !== null, forced: player.forced,
      correct: conceal ? null : player.correct,
      totalTimeMs: conceal ? null : elapsed(player, this.now(), this.startedAt),
      rank: conceal ? null : player.rank,
    }));
  }

  stateView() {
    const active = this.activePlayers();
    return {
      gameId: this.gameId, phase: this.phase, totalQuestions: this.questions.length,
      playerCount: active.length,
      finishedCount: active.filter((player) => player.finishedAt !== null).length,
      startedAt: this.startedAt, endedAt: this.endedAt,
      hideLeaderboardNumbers: this.hideLeaderboardNumbers,
    };
  }

  serialize({ clone = true } = {}) {
    const snapshot = {
      version: 1, gameId: this.gameId, phase: this.phase, questions: this.questions,
      idCounter: this.idCounter, finishCounter: this.finishCounter,
      startedAt: this.startedAt, endedAt: this.endedAt,
      hideLeaderboardNumbers: this.hideLeaderboardNumbers,
      players: [...this.players.values()],
    };
    // JsonStore.save already makes a synchronous detached copy. Its caller can
    // skip a second full copy; other consumers retain safe snapshot semantics.
    return clone ? structuredClone(snapshot) : snapshot;
  }
}
