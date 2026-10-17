# IEEE Day Quiz Arena

A live quiz for the IEEE Computer Society chapter's IEEE Day event at PIEAS.
One laptop hosts the Node.js application. Participants join on phones over the
same local network, and a separate leaderboard view fills the projector.

## Install and run

Use Node.js **22.12 or newer**. From this project directory:

```sh
npm install
npm run build
npm start
```

Installation needs internet to download dependencies. Once installed and built,
the app runs locally without CDNs, external APIs, or internet access. Express
serves the built React frontend; fonts, icons, the logo, and QR generation are
local.

The server binds to `0.0.0.0` on port **3000** by default and prints the LAN
joining URL and a QR code. Open the printed address on participants' phones.
On the host laptop, the admin console is also available at
`http://localhost:3000/admin`. Use these routes at the server address:

| Route | Screen |
| --- | --- |
| `/` | Player join, questions, and result |
| `/admin` | Organizer login and game controls |
| `/leaderboard` | Projector lobby, live top ten, and podium |

Connect the laptop and phones to the same Wi-Fi or local hotspot. Allow the
Node.js process through the host firewall for local network access. If phones
cannot reach the printed URL, check that the access point permits devices to
communicate with one another; guest Wi-Fi sometimes isolates clients. Keep the
laptop awake during the quiz. Phones on 2.4 GHz and 5 GHz can share the same
quiz if the access point bridges those bands onto the same LAN. Prefer a
proper event access point for a large audience and check its client capacity.
The load rehearsal exercises server clients on loopback; it does not measure
the venue's Wi-Fi radio capacity or verify 150 physical phones.

## Admin credentials

Put the organizer credentials in a root `.env` file:

```dotenv
ADMIN_USER=event-admin
ADMIN_PASS=replace-with-a-private-password
```

If either credential is missing or empty, startup generates only the missing
value, saves it to `.env`, and prints only the newly generated field. Existing
credentials are preserved and are never printed again on later starts. The
file is restricted to owner read/write permissions (`0600`).

Admin login creates an `HttpOnly`, `SameSite=Strict` session cookie. Sessions
last 12 hours and are revoked by logout or a server restart. Every admin API
and admin Socket.IO subscription checks that session. The organizer signs in
again after a restart; player sessions and the game recover from disk.

## Optional host configuration

These settings may also be added to `.env`:

```dotenv
PORT=3000
# Set this only if automatic LAN address selection chooses the wrong adapter:
# LAN_HOST=192.168.1.20
# DATA_DIR=.data
```

| Setting | Default and behavior |
| --- | --- |
| `PORT` | `3000`; must be an integer from `1` to `65535`. |
| `LAN_HOST` | The detected external IPv4 address, or `127.0.0.1` when no LAN adapter is found. Supply only an IP address or hostname, without `http://` or a port. It changes the printed joining URL and QR; the server still binds to `0.0.0.0`. |
| `DATA_DIR` | `.data` in the project root. Relative paths resolve from the project root; an absolute path is also supported. Keep the same directory to retain IDs and game recovery. |

Environment variables override `.env` for `PORT`, `LAN_HOST`, and `DATA_DIR`.
Admin credentials are read from `.env`. Restart the server after changing host
configuration. If the selected port is occupied, choose a free one and restart.

## Edit the questions

The **only** question source is root `questions.json`. The supplied question
bank is included there. The admin page shows a read-only preview; it has no
question editor.

The file must be a JSON array with this shape:

```json
[
  {
    "question": "Which option is correct?",
    "options": ["First option", "Second option", "Third option", "Fourth option"],
    "correctIndex": 2
  }
]
```

`correctIndex` is zero-based: `0` means the first option and `3` means the
fourth. Every question needs non-empty text, exactly four non-empty option
strings, and an integer `correctIndex` from `0` through `3`. There is no fixed
question-count limit.

After editing and saving, run:

```sh
npm run build
```

The build validates JSON syntax and every question before building the
frontend. Invalid content reports the file, line, column, and problem, and
stops the build. The server also reads and validates the file at every startup
and game reset. Reset the game to load edits for a new round.

If a server restart recovers an occupied game, its saved question snapshot is
kept for that round so participants all answer the same bank. The admin view
flags any difference between that snapshot and the current file. A reset
loads the edited bank for the next round.

## Run the event

1. Start the server, sign in at `/admin`, and confirm the question count.
2. Open the lobby. Put `/leaderboard` on the projector and let participants
   join using only their names. Duplicate names are supported; each player is
   assigned a unique ID such as `P-042`.
3. Press **START QUIZ**. Everyone receives the same questions in the same
   order and starts against one server timestamp. Joining closes once the
   quiz has started.
4. Watch player progress and use the ID/name verification search as needed.
   The optional privacy setting conceals public leaderboard ranks, scores,
   and times until the game has finished.
5. Wait for everyone to finish, or use **End quiz** to force-finish remaining
   players. Unanswered questions earn no credit.
6. Verify winners by their assigned IDs and export final results as CSV.
   Reset when ready for another round; the reset archives the previous game,
   reloads questions, and closes the lobby.

There are no per-question timers, points, streaks, or speed bonuses. Players
answer at their own pace. An answer locks after submission and cannot be
changed. Feedback says "Answer locked" without revealing correctness. On
finishing, each player sees their correct count, server-measured total time,
and current rank.

Ranking is correct answers descending, then total elapsed time ascending. If
those are equal, the earlier server-recorded finish wins. The server's clock
determines results; the on-screen timer is a synchronized display. Disconnecting
does not pause elapsed time.

## Identity, answer order, and recovery

The server allocates IDs from a persisted monotonic counter. IDs are not
reused after a kick, reset, or restart. Players refresh or reconnect in the same
browser to resume their existing session. A reset invalidates previous player
sessions so each new round starts cleanly.

Each player gets a deterministic option order seeded by their ID and question
number. Refreshing preserves that order. Colored shapes belong to button
positions, while the option text is shuffled. Player payloads include each
option's original index, which is what an answer submits; they never include
`correctIndex`. Only the server maps and grades the submitted answer.

The live state is held in memory and written atomically to private JSON files.
With the default `DATA_DIR`, the files are:

| File | Contents |
| --- | --- |
| `.data/state.json` | Current game, original question snapshot, player session tokens, answers, results, shared start, elapsed times, and finish order. |
| `.data/id-counter.json` | The highest reserved player ID number. It survives reset and prevents reissuing IDs after restart. |
| `.data/archives/<game-id>.json` | The full previous game snapshot written when the organizer resets. |

The server reserves an ID on disk before saving its player record, and only
acknowledges a join or answer after the relevant snapshot has been written.
A restart restores acknowledged answers. Kicked players stay in saved records
while being excluded from rankings. Temporary writes are renamed atomically;
files use `0600` permissions and data directories use `0700`.

Use **Reset game** for a new round. Keep and back up the data directory,
especially `id-counter.json`, to preserve the ID history. Deleting the directory
also deletes recovery data and the counter. Neither `.data` nor `.env` is
served to browsers. Press `Ctrl+C` for an orderly shutdown. If saved JSON is
invalid or the disk cannot save, startup/actions report an error instead of
silently discarding the existing game; retain the files while resolving the
reported problem.

## Tests and rehearsal

```sh
npm run test:unit
npm run test:api
npm test
npm run test:load
npm run test:load -- --players 150
```

The unit suite covers question validation, stable player shuffles, grading
across all 24 option permutations, ID uniqueness, ranking, and finish-order
ties. API tests cover authentication, answer locking, reconnects, reset,
restart recovery, and CSV export. The default load rehearsal creates 50 fake
players, including duplicate names and different answering speeds, and plays a
complete game. The `--players` option raises the rehearsal to 150 players.

The load script starts its own server on a free loopback port with a temporary
data directory and the root question bank. It does not use the organizer's
credentials or overwrite the event game. It checks completed results, unique
IDs, shuffled choices, answer locks, privacy, and saved state while measuring
request latency and event-loop responsiveness. Reports are written to
`artifacts/load-test-50.json` and `artifacts/load-test-150.json` for the commands
above. The temporary server and game data are cleaned up after the rehearsal.

Verification recorded on 17 October 2026: **70 automated tests passed**
(17 API, 16 game-core, 12 question-validation, 10 persistence, 6 configuration,
8 player-state, and 1 abrupt-process-restart test). The full suite completed in
10.87 seconds, and the final production build passed. Browser checks passed for the player, admin, and
leaderboard screens on desktop, and player/admin at 375px with no horizontal
page overflow. The mobile answer buttons measured 89px high. The browser
journey covered duplicate names with distinct IDs, the shared start, stable
shuffles and saved progress after refresh, all 10 answers and the expected
4-correct result, hidden leaderboard numbers, force-ending remaining players,
the podium, duplicate-name verification, the read-only question preview, an
actual CSV download, and rejoining after reset with a new `P-003` ID.

Both complete-game load rehearsals passed on the host laptop using Node.js
26.3.0 and the supplied 10-question bank:

| Players | Saved answers | Answer latency, p95 | Slowest answer request | Event-loop delay, p95 |
| --- | --- | --- | --- | --- |
| 50 | 500 / 500 | 124.7 ms | 140.5 ms | 17.5 ms |
| 150 | 1,500 / 1,500 | 367.3 ms | 416.0 ms | 64.7 ms |

The 150-player run maintained 150 player sockets plus the projector socket.
Both runs verified restart recovery and returned no privacy violations; the
largest measured live player payload was 0.4 KB and leaderboard payload was
1.5 KB. These latency figures include server handling and acknowledged disk
persistence over loopback. They describe these rehearsal runs, not a guarantee
for every laptop or wireless network.

The detailed results are in [the 50-player report](artifacts/load-test-50.json)
and [the 150-player report](artifacts/load-test-150.json). Passing loopback tests
does not establish venue Wi-Fi capacity. See `PLAN.md` for milestone gates and
the HTTP/Socket.IO contract.

The final startup check verified the built app through both loopback and the
host's LAN address. The production game was left clean: lobby closed, no
players, 10 loaded questions, and leaderboard privacy off. Sign in at `/admin`,
choose **Open lobby**, invite players, then press **START QUIZ** when ready.

## How the code fits together

- `questions.json` is content. `server/questions.js` validates that content and
  reports source locations. `scripts/validate-questions.js` runs the validator
  before Vite is allowed to produce a new frontend build.
- `server/game.js` implements `QuizGame`, which moves the round through closed,
  lobby, running, and finished states. Its `answer` method accepts only the
  next question, grades the original option index, and records server time.
  `getOptionOrder` runs seeded Fisher–Yates, `shuffleOptions` strips the answer
  key from player views, and `rankPlayers` applies the score/time/finish order.
- `server/config.js` reads `.env`, generates missing credentials, validates
  the port, chooses the advertised LAN address, and resolves the data directory.
  `server/index.js` checks for a frontend build, creates the server, prints the
  LAN URL/terminal QR, and handles shutdown signals.
- `server/app.js` wires Express and Socket.IO to the game. HTTP routes handle
  joins, answer submission, admin login, controls, settings, verification, and
  CSV. Admin sessions stay in server memory and authenticate privileged reads
  and writes. Socket.IO carries scoped live views; projector updates contain
  only the top ten, and question banks are not rebroadcast on each answer.
- `server/persistence.js` implements `JsonStore`. It batches closely spaced
  saves, reserves ID counters before snapshots, writes private JSON through
  temporary files and atomic renames, and archives the current round on reset.
  Save promises resolve after durable writes, so an acknowledged answer can
  be recovered after restart. The persistence path takes one defensive snapshot
  copy in the store; it avoids cloning the entire game twice for every answer.
- `src/main.jsx` mounts the selected route and implements the player journey.
  `src/Admin.jsx` handles the authenticated control room, read-only question
  preview, confirmation dialogs, and winner search. `src/Leaderboard.jsx`
  renders the projector lobby, top-ten ranking, and final podium.
- `src/shared.jsx` supplies `api` for same-origin JSON requests, `useLive` for
  scoped socket subscriptions and reconnects, `useServerClock` for a smooth
  timer anchored to server time, and common branding/components. The browser
  timer is a display; trusted elapsed time is always computed by the server.
- `src/player-state.js` exports the pure `mergePlayerState` function. It keeps
  a late HTTP response from overwriting newer socket progress or rolling a
  finished player backward, while accepting the safe question bank for the
  same game. Unit tests exercise these delivery-order cases.
- `src/styles.css`, `src/admin.css`, and `src/leaderboard.css` define the three
  responsive views. `vite.config.js` enables React and Tailwind; Vite packages
  these files, the local Inter font, and `public/` assets into `dist/`, which
  Express serves. `index.html` is the frontend entry document.
- `tests/` checks correctness, configuration, authentication, persistence,
  recovery after an abrupt process kill, concurrent finishers, and UI state
  merging. `scripts/load-test.js` rehearses a full quiz
  with concurrent clients. `npm test` runs all `tests/*.test.js` files; the
  shorter `test:unit` command runs only game-core and question-validation tests.

The local IEEE Computer Society logo comes from the official
[computer.org website](https://www.computer.org/); its source attribution is
in `public/BRAND-SOURCE.txt`. Event-specific design decisions are recorded in
`design-system/ieee-day-quiz-arena/EVENT-OVERRIDES.md`.
