# IEEE Day Quiz Arena — build plan

## Milestone 1: quiz foundation
Status: **complete — foundation gate passed.**

- Use the supplied root `questions.json`, with no embedded sample questions or editor.
- Validate syntax and every field with line/column diagnostics before the Vite build.
- Implement deterministic server shuffles, monotonic player IDs, grading, immutable answers, shared-start timing and ranking.
- Gate: unit tests for validation, all 24 shuffle permutations, ID uniqueness and ranking/ties.

## Milestone 2: server and recovery
Status: **complete — server, persistence, configuration, and API gates passed
before frontend integration.**

- Express + Socket.IO; server is authoritative, no answer key in player payloads.
- Admin session cookie, protected APIs and socket subscriptions, generated `.env` credentials when absent.
- Atomic JSON persistence, game archives on reset, IDs never reused, same browser resumes its player.
- Read questions on startup/reset; preserve the question snapshot of a recovered occupied game and clearly flag file changes for reset.
- Coalesce live updates, send top-ten only to projector subscribers, never broadcast full question lists on each answer.
- Gate: API/auth/answer-lock/reconnect/restart/reset/export tests before UI integration.

## Milestone 3: event screens
Status: **complete — production build and desktop/mobile browser gate passed.**

- React + Vite + Tailwind, local fonts and official Computer Society logo.
- Mobile player join, waiting room, accessible shaped/color choices, answer-lock feedback, timer and results.
- Admin dashboard: controls, players, question preview, verification, leaderboard privacy and CSV.
- Projector: live top ten, joining URL/QR, animated movement, final podium/confetti.
- Gate: production frontend build and desktop/mobile browser journeys.
- Recorded verification: desktop player/admin/projector screens; player and
  admin at 375px without horizontal page overflow; 89px mobile answer buttons;
  duplicate names with distinct IDs; shared start; stable shuffled options and
  progress after refresh; the complete 10-answer journey with an expected
  4-correct result; hidden public numbers; force-finish of remaining players;
  final podium; duplicate-name winner verification; read-only question bank;
  actual CSV download; reset and rejoin with new ID `P-003`.
- Delivery-order checks were added in `tests/player-state.test.js` so delayed
  HTTP snapshots cannot roll back newer socket progress or a finished result.

## Milestone 4: event rehearsal and handoff
Status: **complete — full suite, production build, 50/150-player rehearsals,
and clean startup on loopback and the LAN address passed.**

- An isolated, repeatable 50-bot full game including duplicate names and varied speeds; support `--players 150`.
- Verify final ranking and persisted answers/results, privacy and continued timers through restart.
- Document setup, LAN/firewall guidance, source editing, recovery, operations and architecture.
- Gate: full suite + 50/150-player rehearsals; leave clean production state.
- Final automated suite: **70/70 passing tests** in **10.87 seconds** (17 API,
  16 core, 12 questions, 10 persistence, 6 configuration, 8 player-state,
  1 abrupt-process-restart). The final production build passed.
- Load test: default 50 players, optional `--players 150`, isolated temporary
  game/server, root question bank, and reports at
  `artifacts/load-test-<count>.json`.
- Recorded 50-player result: **passed**, 500/500 saved answers, answer latency
  p95 **124.7 ms**, maximum **140.5 ms**, event-loop delay p95 **17.5 ms**.
- Recorded 150-player result: **passed**, 1,500/1,500 saved answers, answer
  latency p95 **367.3 ms**, maximum **416.0 ms**, event-loop delay p95 **64.7 ms**,
  151 peak sockets. Both runs verified recovery after restart and returned no
  privacy violations. Maximum live payloads: player **0.4 KB**, board **1.5 KB**.
- Loopback rehearsals cover the laptop server. Actual venue access-point
  capacity and simultaneous use by 150 physical phones remain unverified.
- Final `npm start` verified on `0.0.0.0:3000` via both loopback and the host's
  LAN address. Production state: closed lobby, 0 players, ID counter 0,
  10 questions, leaderboard privacy off. The generated `.env` is mode `0600`;
  credential values are not included in documentation.

## Design direction
Orange, ink and warm off-white, bold local sans-serif type, thin rules, generous spacing, rounded rectangular controls. Real IEEE Computer Society logo from computer.org. Player actions are 48px or larger and options combine a shape, color and text. Projector has a dark stage theme and large type. Respect reduced-motion preferences.

## HTTP and Socket contract
JSON success responses use `{ ...data }`; errors use `{ error: "message" }` and appropriate status. Requests are same-origin and use credentials. All mutation requests are JSON (except CSV download).

- `GET /api/state` → `{ state, serverNow }`. `state`: `{ gameId, phase: 'closed'|'lobby'|'running'|'finished', totalQuestions, playerCount, finishedCount, startedAt, endedAt, hideLeaderboardNumbers, joinUrl, questionFileChanged }`.
- `GET /api/config` → `{ joinUrl, qrDataUrl }`.
- `POST /api/player/join { name }` → player session cookie + `{ player, questions, state, serverNow }`.
- `GET /api/player/me` → `{ player, questions, state, serverNow }`, 401 if not joined. `questions` is empty before start; while running/finished all questions are `{ question, options:[{ text, originalIndex }] }` in stable shared question order, uniquely shuffled per player.
- `POST /api/player/answer { gameId, questionIndex, optionIndex }` → `{ player, state, serverNow }`. Index is ORIGINAL option index, integer 0..3. Exactly next question only; stale game IDs rejected.
- `player`: `{ id, name, progress, finished, forced, totalTimeMs, correct, rank }`; correct/rank/totalTimeMs null until that player finishes; no per-question correctness ever returned.
- `POST /api/admin/login { username, password }` → session cookie + `{ ok:true }`.
- `POST /api/admin/logout` → expire/revoke session.
- `GET /api/admin/state` → `{ state, players, questions, serverNow }`; players ranked with score/progress/time, questions full original including key (admin only).
- `POST /api/admin/control { action: 'open'|'start'|'end'|'reset' }` → `{ state, serverNow }`.
- `POST /api/admin/settings { hideLeaderboardNumbers: boolean }`.
- `POST /api/admin/kick { playerId }`.
- `GET /api/admin/verify?q=...` → `{ players }`; searches ID/name, duplicate names retained.
- `GET /api/admin/results.csv` → final CSV only (rank,name,ID,correct,total time in seconds to 3 decimals).
- `GET /api/leaderboard` → `{ state, players, serverNow }` top ten; conceal rank, correct and time while hiding is on and game isn't finished, neutral join order. Progress remains visible.
- Socket.IO same-origin cookie sessions. Connect `auth:{ role:'player'|'admin'|'leaderboard' }` (default spectator); validate admin role at connection AND before each admin subscription/event. There are no socket mutation events; all writes use guarded HTTP routes.
- Events: `state` → `{ state, serverNow }` to all; `leaderboard` → `{ state, players, serverNow }` to projector role; `admin` → `{ state, players, serverNow }` to authenticated admins (no repeated question bank); `player` → `{ player, state, serverNow }` to that player's cookie session; `session-invalid` on kick/reset. On any reconnect refetch `/me` or admin state. State events on phase change prompt player question reload.

## Fairness and recovery details
All players start against one server timestamp. Browser timer is an estimate synchronized to `serverNow`; submitted timestamps are ignored. Finishing locks server elapsed milliseconds and a finish sequence; ranking is correct descending, time ascending, then earlier finish sequence. Unfinished entries use current server elapsed time and are labelled in progress. Force-end gives unanswered questions zero credit. Offline players keep running. Kicked players are excluded from rankings but retained in saved records. Reset archives the current game, reloads questions and closes the lobby; browser identities reset but ID counter persists. Keep `.data` and `.env` private and outside the static root.
