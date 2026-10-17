import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Check, CheckCircle2, ChevronDown, CircleStop, DoorOpen, Flag, KeyRound, LoaderCircle, LogOut, Play, QrCode, RefreshCw, RotateCcw, Search, ShieldCheck, SlidersHorizontal, Trophy, UserRoundX, Users, X } from 'lucide-react';
import { api, Footer, formatTime, Header, StatusBadge, useLive, useServerClock } from './shared.jsx';
import './admin.css';

const phaseCopy = {
  closed: ['Your stage is set.', 'Open the lobby and invite everyone into the arena.'],
  lobby: ['Ready when you are.', 'Players are joining. Start everyone together when the room is ready.'],
  running: ['The arena is live.', 'Every player has the same questions and a shared start time.'],
  finished: ['That’s a wrap.', 'Verify your winners, export the results, and celebrate the room.'],
};

function ConfirmDialog({ confirmation, busy, error, onClose, onConfirm }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return <dialog ref={dialogRef} className="admin-dialog" aria-labelledby="admin-dialog-title" aria-describedby="admin-dialog-description"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="admin-dialog-content">
      <div className="admin-dialog-top"><span className="admin-dialog-icon"><ShieldCheck size={25} /></span><button className="admin-icon-button" type="button" aria-label="Close confirmation" disabled={busy} onClick={onClose}><X size={20} /></button></div>
      <p className="eyebrow">HOST CONFIRMATION</p><h2 id="admin-dialog-title">{confirmation.title}</h2>
      <p id="admin-dialog-description" className="muted">{confirmation.description}</p>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="admin-dialog-actions"><button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose} autoFocus>Cancel</button><button type="button" className="btn admin-danger-button" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle className="admin-spin" size={17} /> : null}{confirmation.label}</button></div>
    </div>
  </dialog>;
}

/** IDs come from the search API; current live rows keep matching results fresh. */
function WinnerSearch({ players, gameId, totalQuestions, onError }) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [pending, setPending] = useState(false);
  const [searchError, setSearchError] = useState('');
  const sequence = useRef(0);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    const request = ++sequence.current;
    setMatches([]);
    setSearchError('');
    if (!query.trim()) { setPending(false); return; }
    setPending(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api(`/api/admin/verify?q=${encodeURIComponent(query.trim())}`);
        if (request === sequence.current) setMatches(result.players);
      } catch (error) {
        if (request === sequence.current) { setSearchError(error.message); errorHandler.current(error); }
      } finally { if (request === sequence.current) setPending(false); }
    }, 220);
    return () => { clearTimeout(timer); sequence.current += 1; };
  }, [query, gameId]);
  const current = new Map(players.map(player => [player.id, player]));
  const results = matches.map(player => current.get(player.id)).filter(Boolean);
  return <section className="panel admin-verification" aria-labelledby="admin-verify-heading">
    <div className="admin-panel-heading"><span className="admin-small-icon"><ShieldCheck size={19} /></span><div><p className="eyebrow">THE FINAL CHECK</p><h2 id="admin-verify-heading">Verify a winner</h2></div></div>
    <label className="admin-search-label" htmlFor="admin-winner-search">Player ID or name</label>
    <div className="admin-search-input"><Search size={18} aria-hidden="true" /><input id="admin-winner-search" className="field" value={query} onChange={event => setQuery(event.target.value)} placeholder="e.g. P-042 or a name" autoComplete="off" /></div>
    <div className="admin-search-results" aria-live="polite" aria-busy={pending}>
      {!query.trim() ? <p className="admin-help">Check the assigned ID before announcing a winner. Names can be shared.</p>
        : pending ? <p className="admin-help"><LoaderCircle className="admin-spin" size={15} /> Searching players…</p>
          : searchError ? <p className="error-message">{searchError}</p>
            : results.length === 0 ? <p className="admin-help">No players match “{query.trim()}”.</p>
              : <><p className="admin-match-count">{results.length} {results.length === 1 ? 'match' : 'matches — confirm the player ID'}</p>{results.map(player => <article className="admin-verified-player" key={player.id}>
                <div className="admin-verified-top"><div><strong>{player.name}</strong><span className="admin-player-id">{player.id}</span></div><span className="admin-rank">#{player.rank}</span></div>
                <div className="admin-verified-stats"><span>Correct <b>{player.correct}/{totalQuestions}</b></span><span>Total time <b>{formatTime(player.totalTimeMs, true)}</b></span></div>
                {!player.finished && <span className="admin-result-pending">Still playing · rank may change</span>}
              </article>)}</>}
    </div>
  </section>;
}

function QuestionPreview({ questions, totalQuestions }) {
  return <section className="panel admin-questions" aria-labelledby="admin-questions-heading">
    <details>
      <summary className="admin-bank-summary"><span className="admin-small-icon"><BookOpen size={21} /></span><span><span className="eyebrow">THE QUESTION BANK</span><strong id="admin-questions-heading">{totalQuestions} questions, ready to go.</strong></span><span className="tag">READ ONLY</span><ChevronDown className="admin-chevron" size={20} /></summary>
      <div className="admin-question-content"><p className="admin-help">Edit <code>questions.json</code>, save, and run <code>npm run build</code>. Reset the game to load your changes.</p>
        {questions.map((question, index) => <details key={`${index}:${question.question}`} className="admin-question-item">
          <summary><span className="admin-question-number">{String(index + 1).padStart(2, '0')}</span><span>{question.question}</span><ChevronDown size={16} /></summary>
          <ol className="admin-options-list">{question.options.map((option, optionIndex) => <li key={optionIndex} className={optionIndex === question.correctIndex ? 'admin-correct-option' : ''}><span>{String.fromCharCode(65 + optionIndex)}</span><p>{option}</p>{optionIndex === question.correctIndex && <CheckCircle2 size={17} aria-label="Correct answer" />}</li>)}</ol>
        </details>)}
      </div>
    </details>
  </section>;
}

export default function Admin() {
  const [session, setSession] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const [dialogError, setDialogError] = useState('');
  const mounted = useRef(true);
  const refreshSequence = useRef(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  function expireSession(message = 'Your session ended. Sign in again to continue.') {
    refreshSequence.current += 1;
    setSession(false);
    setSnapshot(null);
    setConfirmation(null);
    setLoginError(message);
  }

  // Full HTTP reads include the bank. Socket updates replace only live fields.
  function acceptSnapshot(next) {
    setSnapshot(previous => {
      if (previous && next.serverNow < previous.serverNow) {
        return next.questions && next.state.gameId === previous.state.gameId ? { ...previous, questions: next.questions } : previous;
      }
      const sameGame = previous?.state.gameId === next.state.gameId;
      return { ...previous, ...next, players: next.players ?? (sameGame ? previous?.players ?? [] : []), questions: next.questions ?? (sameGame ? previous?.questions ?? [] : []) };
    });
  }

  async function refresh() {
    const request = ++refreshSequence.current;
    try {
      const next = await api('/api/admin/state');
      if (!mounted.current || request !== refreshSequence.current) return false;
      acceptSnapshot(next);
      setSession(true);
      setError('');
      return true;
    } catch (caught) {
      if (!mounted.current || request !== refreshSequence.current) return false;
      if (caught.status === 401) {
        if (snapshotRef.current) expireSession();
        else setSession(false);
      } else setError(caught.message);
      return false;
    }
  }

  useEffect(() => {
    mounted.current = true;
    refresh();
    api('/api/config').then(next => { if (mounted.current) setConfig(next); }).catch(() => {});
    return () => { mounted.current = false; refreshSequence.current += 1; };
  }, []);

  const { connected, reconnect } = useLive('admin', ({ type, payload }) => {
    if (type === 'connect') { refresh(); return; }
    if (type === 'disconnect' && payload?.reason === 'io server disconnect') { refresh(); return; }
    if (type === 'admin') {
      const changedGame = snapshotRef.current && snapshotRef.current.state.gameId !== payload.state.gameId;
      acceptSnapshot(payload);
      if (changedGame) refresh();
    }
    if (type === 'server-error') setError(payload.error);
    if (type === 'connect_error' && /authenticat|sign in/i.test(payload.error)) expireSession();
  }, session === true);
  const clock = useServerClock(snapshot?.serverNow);

  async function login(event) {
    event.preventDefault();
    if (busy) return;
    setBusy('login');
    setLoginError('');
    try {
      await api('/api/admin/login', { username, password });
      setPassword('');
      const loaded = await refresh();
      if (!loaded && mounted.current) setLoginError('Signed in, but the control room could not load. Try signing in again.');
    } catch (caught) { setLoginError(caught.message); }
    finally { setBusy(''); }
  }

  async function logout() {
    setBusy('logout');
    try {
      await api('/api/admin/logout', {});
      expireSession('');
      setNotice('');
      setError('');
    } catch (caught) {
      if (caught.status === 401) expireSession('');
      else setError(caught.message);
    } finally { setBusy(''); }
  }

  async function execute(action, details = {}) {
    if (busy) return;
    setBusy(action);
    setError('');
    setDialogError('');
    setNotice('');
    try {
      const result = action === 'kick' ? await api('/api/admin/kick', { playerId: details.playerId })
        : action === 'settings' ? await api('/api/admin/settings', details)
          : await api('/api/admin/control', { action });
      acceptSnapshot(result);
      setConfirmation(null);
      await refresh();
      const messages = { open: 'The lobby is open. Players can join now.', start: 'Quiz started. Every player is on the same clock.', end: 'Quiz ended. All results are final.', reset: 'Game reset. The latest question bank is loaded.', kick: 'Player removed from this game.', settings: 'Leaderboard visibility updated.' };
      setNotice(messages[action]);
    } catch (caught) {
      if (caught.status === 401) expireSession();
      else { setError(caught.message); setDialogError(caught.message); }
    } finally { setBusy(''); }
  }

  function confirm(type, player) {
    setDialogError('');
    const confirmations = {
      end: { title: 'End the quiz for everyone?', description: 'All remaining players will finish now. Unanswered questions receive no credit, and everyone’s results become final.', label: 'End quiz' },
      reset: { title: 'Reset this game?', description: 'The current game will be archived. All players will need to join again, the question bank will reload, and the lobby will close.', label: 'Reset game' },
      kick: { title: `Remove ${player?.name ?? 'this player'}?`, description: `${player?.id ?? ''} will lose access to this game and be removed from the rankings. Their saved record will be retained.`, label: 'Remove player', playerId: player?.id },
    };
    setConfirmation({ type, ...confirmations[type] });
  }

  if (session === null) return <div className="admin-page"><Header active="admin" connected={!error} /><main className="admin-auth-loading"><span className="admin-login-mark"><ShieldCheck size={28} /></span><h1>{error ? 'Let’s reconnect.' : 'Opening the control room…'}</h1>{error ? <><p className="error-message" role="alert">{error}</p><button className="btn btn-primary" onClick={() => { setError(''); refresh(); }}><RefreshCw size={17} /> Try again</button></> : <LoaderCircle className="admin-spin" size={23} aria-label="Checking admin session" />}</main><Footer /></div>;

  if (!session) return <div className="admin-page"><Header active="admin" /><main className="admin-auth-layout">
    <section className="admin-auth-intro"><p className="eyebrow">IEEE DAY 2026 / HOST ACCESS</p><h1>Run <br />the room<span>.</span></h1><p>One shared start.<br />A room full of curious minds.<br />You’re in control.</p><div className="admin-auth-note"><ShieldCheck size={19} /><span>IEEE Computer Society<br /><strong>PIEAS Student Chapter</strong></span></div><span className="admin-auth-art" aria-hidden="true" /></section>
    <section className="admin-login-card" aria-labelledby="admin-login-heading"><span className="admin-login-mark"><KeyRound size={26} /></span><p className="eyebrow">THE CONTROL ROOM</p><h2 id="admin-login-heading">Welcome, host.</h2><p className="muted">Sign in to get your quiz underway.</p><form onSubmit={login} className="admin-login-form">
      <div><label htmlFor="admin-username">Username</label><input className="field" id="admin-username" name="username" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required autoFocus /></div>
      <div><label htmlFor="admin-password">Password</label><input className="field" id="admin-password" name="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></div>
      {loginError && <p className="error-message" role="alert">{loginError}</p>}
      <button className="btn btn-primary admin-login-submit" type="submit" disabled={Boolean(busy)}>{busy ? <LoaderCircle className="admin-spin" size={18} /> : null}{busy ? 'Signing in…' : 'Enter the control room'}{!busy && <ArrowRight size={19} />}</button>
    </form><p className="admin-login-help">Use the credentials in the host laptop’s <code>.env</code> file. New credentials appear in the terminal on first run.</p></section>
  </main><Footer /></div>;

  const state = snapshot?.state;
  if (!state) return null;
  const players = snapshot.players ?? [];
  const questions = snapshot.questions ?? [];
  const phase = state.phase;
  const joinUrl = config?.joinUrl ?? state.joinUrl;
  const activeTime = state.startedAt === null ? null : (state.endedAt ?? clock) - state.startedAt;
  const [controlTitle, controlDescription] = phaseCopy[phase];
  return <div className="admin-page"><Header active="admin" connected={connected} /><main className="admin-main">
    <div className="admin-page-heading"><div><p className="eyebrow">IEEE DAY 2026 / HOST CONSOLE</p><h1>Run the room<span>.</span></h1><p className="muted">A shared start. A fair finish. Everything you need to host.</p></div><div className="admin-heading-actions"><StatusBadge phase={phase} connected={connected} /><button className="btn btn-quiet" disabled={Boolean(busy)} onClick={logout}><LogOut size={16} /> Sign out</button></div></div>
    {!connected && <div className="admin-banner admin-connection-banner" role="status"><RefreshCw size={18} /><span>Reconnecting to the host. Live updates will resume automatically.</span><button type="button" className="btn btn-quiet" onClick={reconnect}>Retry</button></div>}
    {state.questionFileChanged && <div className="admin-banner" role="status"><BookOpen size={19} /><span><strong>The question file has changed.</strong> Reset to load the new bank. Current players keep their original questions.</span></div>}
    {error && <div className="error-message admin-page-error" role="alert">{error}<button type="button" className="admin-icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={17} /></button></div>}
    {notice && <div className="admin-notice" role="status"><Check size={17} />{notice}<button type="button" className="admin-icon-button" aria-label="Dismiss update" onClick={() => setNotice('')}><X size={16} /></button></div>}
    <div className="admin-stats">
      <article className="admin-stat"><div><span className="eyebrow">QUESTIONS LOADED</span><strong>{state.totalQuestions}<span>questions</span></strong><p>From your question bank</p></div><span className="admin-stat-icon"><BookOpen size={22} /></span></article>
      <article className="admin-stat"><div><span className="eyebrow">IN THE ARENA</span><strong>{state.playerCount}<span>players</span></strong><p>{phase === 'lobby' ? 'The lobby is open for joining' : 'Every player has a unique ID'}</p></div><span className="admin-stat-icon"><Users size={23} /></span></article>
      <article className="admin-stat"><div><span className="eyebrow">ACROSS THE FINISH LINE</span><strong>{state.finishedCount}<span>/ {state.playerCount} finished</span></strong><p>{phase === 'running' ? `${formatTime(activeTime)} elapsed` : phase === 'finished' ? 'Final results are ready' : 'Ready for the shared start'}</p></div><span className="admin-stat-icon"><Flag size={23} /></span></article>
    </div>
    <div className="admin-workspace"><div className="admin-main-column">
      <section className="admin-controls" aria-labelledby="admin-controls-heading"><div className="admin-control-top"><span className="eyebrow">01 / GAME CONTROLS</span><span className={`admin-phase-dot admin-dot-${phase}`}>{phase === 'running' ? 'LIVE NOW' : phase === 'finished' ? 'COMPLETE' : 'HOST CONTROL'}</span></div><div className="admin-control-copy"><h2 id="admin-controls-heading">{controlTitle}</h2><p>{controlDescription}</p></div>
        <button className="btn admin-start-button" disabled={Boolean(busy) || phase !== 'lobby' || state.playerCount === 0} onClick={() => execute('start')}>{busy === 'start' ? <LoaderCircle className="admin-spin" size={22} /> : <Play size={23} fill="currentColor" />}<span>START QUIZ<small>{phase === 'closed' ? 'Open the lobby first' : phase === 'lobby' && state.playerCount === 0 ? 'Waiting for the first player' : phase === 'running' ? 'Quiz in progress' : phase === 'finished' ? 'Reset to start a new round' : 'Everyone starts together'}</small></span><ArrowUpRight size={24} /></button>
        <div className="admin-secondary-controls"><button type="button" className="btn" disabled={Boolean(busy) || phase !== 'closed'} onClick={() => execute('open')}><DoorOpen size={17} />Open lobby</button><button type="button" className="btn" disabled={Boolean(busy) || phase !== 'running'} onClick={() => confirm('end')}><CircleStop size={17} />End quiz</button><button type="button" className="btn" disabled={Boolean(busy)} onClick={() => confirm('reset')}><RotateCcw size={16} />Reset game</button></div>
      </section>
      <section className="panel admin-player-panel" aria-labelledby="admin-players-heading"><div className="admin-panel-heading admin-player-heading"><div><p className="eyebrow">02 / LIVE PROGRESS</p><h2 id="admin-players-heading">The players <span>{state.playerCount}</span></h2></div><span className="admin-live-label"><i />Updates live</span></div>
        {players.length === 0 ? <div className="admin-empty-players"><span><Users size={27} /></span><h3>The room is yours.</h3><p>{phase === 'closed' ? 'Open the lobby, share the QR code, and welcome your first players.' : 'Share the joining link or QR code. Players will appear here as they join.'}</p></div> : <div className="admin-table-scroll" tabIndex={0} role="region" aria-label="Live player progress table"><table className="admin-player-table"><thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Progress</th><th scope="col">Correct</th><th scope="col">Time</th><th scope="col"><span className="admin-sr-only">Actions</span></th></tr></thead><tbody>{players.map(player => <tr key={player.id}><td className="admin-table-rank">{player.rank ? `#${player.rank}` : '—'}</td><td><strong className="admin-table-name">{player.name}</strong><span className="admin-player-id">{player.id}</span></td><td><span className="admin-progress-text">{player.progress}<span>/{state.totalQuestions}</span>{player.finished && <CheckCircle2 size={14} aria-label={player.forced ? 'Force finished' : 'Finished'} />}</span><span className="admin-progress-track"><span style={{ width: `${state.totalQuestions ? player.progress / state.totalQuestions * 100 : 0}%` }} /></span></td><td className="admin-table-number">{player.correct}</td><td className="admin-table-time">{formatTime(player.finished ? player.totalTimeMs : activeTime, player.finished)}</td><td><button type="button" className="admin-icon-button admin-kick-button" aria-label={`Remove ${player.name} (${player.id})`} title={`Remove ${player.id}`} disabled={Boolean(busy)} onClick={() => confirm('kick', player)}><UserRoundX size={17} /></button></td></tr>)}</tbody></table></div>}
        <div className="admin-player-panel-footer"><span>Ranked by correct answers, then total time.</span>{phase === 'finished' ? <a className="btn btn-quiet" href="/api/admin/results.csv" download><ArrowDownToLine size={16} /> Export final results</a> : <button type="button" className="btn btn-quiet" disabled title="Available when the quiz has finished"><ArrowDownToLine size={16} /> Export final results</button>}</div>
      </section>
      <QuestionPreview questions={questions} totalQuestions={state.totalQuestions} />
    </div><aside className="admin-side-column" aria-label="Joining and verification">
      <section className="panel admin-join-panel"><div className="admin-panel-heading"><span className="admin-small-icon"><QrCode size={21} /></span><div><p className="eyebrow">INVITE THE ROOM</p><h2>Scan. Join. Play.</h2></div></div><div className="admin-qr-wrap">{config?.qrDataUrl ? <img src={config.qrDataUrl} alt={`QR code to join at ${joinUrl}`} width="164" height="164" /> : <span className="admin-qr-placeholder"><QrCode size={52} /></span>}</div><p className="admin-join-caption">Connect to the same Wi-Fi and visit</p><a className="admin-join-url" href={joinUrl} target="_blank" rel="noreferrer">{joinUrl}</a><a className="btn btn-secondary admin-projector-link" href="/leaderboard" target="_blank" rel="noreferrer">Open projector display <ArrowUpRight size={16} /></a></section>
      <section className="panel admin-visibility" aria-labelledby="admin-visibility-heading"><div className="admin-panel-heading"><SlidersHorizontal size={18} /><h2 id="admin-visibility-heading">Keep the suspense</h2></div><label className="admin-switch-label"><span>Hide leaderboard numbers</span><span className="admin-switch"><input type="checkbox" checked={state.hideLeaderboardNumbers} disabled={Boolean(busy)} onChange={event => execute('settings', { hideLeaderboardNumbers: event.target.checked })} /><span className="admin-switch-track" /></span></label><p className="admin-help">Hide public ranks, correct counts, and times until the quiz ends. You can still see everything here.</p></section>
      <WinnerSearch players={players} gameId={state.gameId} totalQuestions={state.totalQuestions} onError={caught => { if (caught.status === 401) expireSession(); }} />
      <div className="admin-fairness-note"><Trophy size={18} /><p><strong>Most correct wins.</strong><br />Ties go to the shortest total time, then the earlier finisher.</p></div>
    </aside></div>
  </main><Footer />{confirmation && <ConfirmDialog confirmation={confirmation} busy={Boolean(busy)} error={dialogError} onClose={() => setConfirmation(null)} onConfirm={() => execute(confirmation.type, { playerId: confirmation.playerId })} />}</div>;
}
