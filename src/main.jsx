import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, ArrowUpRight, Check, CheckCheck, Clock3, Hash, LockKeyhole, Radio, RotateCw, ShieldCheck, Sparkles, Trophy, Users, Zap } from 'lucide-react';
import '@fontsource-variable/inter';
import { api, Footer, formatTime, Header, StatusBadge, useLive, useServerClock } from './shared.jsx';
import Admin from './Admin.jsx';
import Leaderboard from './Leaderboard.jsx';
import './styles.css';
import { mergePlayerState } from './player-state.js';

function ArenaArt() {
  return <div className="arena-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="art-chip"><span /><Zap size={48} strokeWidth={1.5} /><span /></div><span className="orbit-dot dot-one" /><span className="orbit-dot dot-two" /><span className="art-label">A LITTLE CURIOSITY.<br />A LOT OF POSSIBILITY.</span><span className="art-coordinate">33.6525° N / PIEAS</span></div>;
}

function Rules({ total }) {
  return <div className="rules-strip"><div><span className="rule-number">01</span><div><b>{total ?? 'All'} questions. One arena.</b><p>Everyone gets the same challenge.</p></div></div><div><span className="rule-number">02</span><div><b>Think it through.</b><p>No question timers. Go at your pace.</p></div></div><div><span className="rule-number">03</span><div><b>Accuracy comes first.</b><p>Most correct wins. Time breaks ties.</p></div></div></div>;
}

function Timer({ startedAt, serverNow, finalTime }) {
  const now = useServerClock(serverNow);
  return <span className="quiz-timer"><Clock3 size={18} /><span><small>ELAPSED TIME</small><b>{formatTime(finalTime ?? (startedAt ? now - startedAt : 0))}</b></span></span>;
}

function Shape({ index }) {
  return <svg className="answer-shape" aria-hidden="true" viewBox="0 0 32 32">{index === 0 ? <path d="M16 3 31 29H1Z" /> : index === 1 ? <path d="m16 1 15 15-15 15L1 16Z" /> : index === 2 ? <circle cx="16" cy="16" r="14" /> : <rect x="3" y="3" width="26" height="26" rx="2" />}</svg>;
}

function Player() {
  const [data, setData] = useState({ state: null, player: null, questions: [], serverNow: null });
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [locked, setLocked] = useState(false);
  const dataRef = useRef(data), sequence = useRef(0), epoch = useRef(0), pending = useRef(false), questionHeading = useRef(null), resultHeading = useRef(null);
  dataRef.current = data;
  const refresh = async () => {
    const request = ++sequence.current;
    try {
      const fresh = await api('/api/player/me');
      if (request === sequence.current) { setData(current => mergePlayerState(current, fresh, true)); setLoading(false); }
      return fresh;
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        try {
          const fresh = await api('/api/state');
          if (request === sequence.current) { setData({ ...fresh, player: null, questions: [] }); setLoading(false); }
        } catch (failure) { if (request === sequence.current) { setError(failure.message); setLoading(false); } }
      } else if (request === sequence.current) { setError(err.message); setLoading(false); }
    }
  };
  const { connected, reconnect } = useLive('player', ({ type, payload }) => {
    if (type === 'connect') { refresh(); setError(''); }
    if (type === 'state') {
      const old = dataRef.current;
      if (old.state && payload.state.gameId !== old.state.gameId) { ++sequence.current; ++epoch.current; }
      setData(current => mergePlayerState(current, payload, true));
      if (payload.state.gameId !== old.state?.gameId || payload.state.phase !== old.state?.phase) refresh();
    }
    if (type === 'player') setData(current => mergePlayerState(current, payload));
    if (type === 'session-invalid') { ++sequence.current; ++epoch.current; setData(current => ({ ...current, player: null, questions: [] })); setNotice(payload.error); refresh(); }
    if (type === 'server-error') setError(payload.error);
  });
  useEffect(() => { refresh(); }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { if (!locked) return; const timer = setTimeout(() => setLocked(false), 500); return () => clearTimeout(timer); }, [locked]);
  useEffect(() => {
    if (data.player?.finished) resultHeading.current?.focus({ preventScroll: true });
    else if (data.state?.phase === 'running') questionHeading.current?.focus({ preventScroll: true });
  }, [data.player?.progress, data.state?.phase, data.questions.length, data.player?.finished]);
  const join = async event => {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    const startedEpoch = epoch.current;
    try { const fresh = await api('/api/player/join', { name }); if (epoch.current !== startedEpoch) return; ++sequence.current; setData(current => mergePlayerState(current, fresh)); reconnect(); }
    catch (err) { setError(err.message); }
    finally { pending.current = false; setBusy(false); }
  };
  const answer = async optionIndex => {
    if (pending.current || locked || !connected) return;
    pending.current = true; setBusy(true); setError('');
    const { state, player } = dataRef.current;
    const startedEpoch = epoch.current;
    try {
      const fresh = await api('/api/player/answer', { gameId: state.gameId, questionIndex: player.progress, optionIndex });
      if (epoch.current !== startedEpoch || dataRef.current.state?.gameId !== state.gameId) return;
      setData(current => mergePlayerState(current, fresh));
      setNotice('Answer locked.'); setLocked(true);
    } catch (err) {
      if (epoch.current !== startedEpoch) return;
      const fresh = await refresh();
      if (fresh?.player?.progress > player.progress) { setNotice('Your answer was saved and locked.'); setLocked(true); }
      else setError(err.status ? err.message : 'Connection interrupted. Your progress will sync when you reconnect.');
    } finally { pending.current = false; setBusy(false); }
  };
  const { state, player, questions, serverNow } = data;
  const phase = state?.phase ?? 'closed';
  const currentQuestion = questions[player?.progress];
  const started = !!player && ['running', 'finished'].includes(phase);
  return <div className="app-shell"><Header active="player" connected={connected} /><main className={`player-main ${started ? 'is-playing' : ''}`}>
    {error && <div className="error-message global-alert" role="alert">{error}<button className="btn-quiet" onClick={refresh}><RotateCw size={15} />Retry</button></div>}
    {notice && !started && <div className="info-message" role="status">{notice}</div>}
    {!started ? <>
      <section className="join-layout">
        <div className="hero-copy"><div className="eyebrow"><span className="small-orange-line" />IEEE DAY 2026 <span className="eyebrow-divider">/</span> PIEAS</div><h1>Big ideas.<br />Quick thinking.<br /><span>Your moment.</span></h1><p className="hero-description">Curiosity meets a little friendly competition.<br className="desktop-only" /> Step into the IEEE Day Quiz Arena.</p><ArenaArt /></div>
        <div className="entry-column"><div className="entry-topline"><span>THE QUIZ ARENA</span><StatusBadge phase={phase} connected={connected} /></div>
          <div className={`entry-card ${player ? 'waiting-card' : ''}`}>
            <div className="entry-card-icon">{player ? <CheckCheck size={27} /> : <ArrowUpRight size={28} />}</div>
            {player ? <><span className="eyebrow">YOU'RE IN, {player.name}</span><h2>Ready when<br />you are.</h2><p>The host will start the quiz for everyone.<br />Keep this screen open. Your moment is next.</p><div className="player-ticket"><span>YOUR PLAYER ID</span><strong>{player.id}</strong><small>Remember this ID for winner verification.</small></div><div className="waiting-status"><span className="live-dot" /><b>Waiting for the host to start</b></div><div className="entry-divider" /><div className="entry-meta"><span><Users size={17} />{state?.playerCount} in the arena</span><span><ShieldCheck size={16} />Your place is saved</span></div></> : <>
              <h2>Enter the arena.</h2><p>One name. One shared challenge.<br />Let's see what you've got.</p>
              <form onSubmit={join}><label className="field" htmlFor="player-name">Your name<input id="player-name" name="name" value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder="What should we call you?" autoComplete="name" required disabled={busy} /></label><p className="field-hint"><Hash size={14} />We'll assign you a unique player ID.</p><button className="btn btn-primary join-button" disabled={busy || loading || phase !== 'lobby' || !name.trim() || !connected} type="submit">{busy ? 'Joining the arena…' : phase === 'lobby' ? 'Join the arena' : phase === 'running' || phase === 'finished' ? 'Joining is closed' : 'Lobby opens soon'}<ArrowRight size={20} /></button></form>
              <div className="entry-divider" /><div className="entry-meta"><span><Users size={17} />{state?.playerCount ?? 0} players joined</span><span><Radio size={15} />Live on campus</span></div>
            </>}
          </div><div className="entry-note"><LockKeyhole size={15} />{player ? 'Your quiz starts automatically. No refresh needed.' : 'Just your name. No account. No downloads.'}</div>
          <a className="projector-link" href="/leaderboard" target="_blank" rel="noreferrer">Watch the leaderboard <ArrowUpRight size={16} /></a>
        </div>
      </section><Rules total={state?.totalQuestions} />
    </> : player.finished ? <section className="result-layout"><div className="result-kicker eyebrow"><CheckCheck size={17} />ALL ANSWERS LOCKED</div><div className="result-medal"><Trophy size={46} strokeWidth={1.5} /></div><h1 ref={resultHeading} tabIndex={-1}>You brought<br />your <span>brainpower.</span></h1><p className="result-greeting">Nicely played, <b>{player.name}</b>. Here's where you stand.</p><div className="result-id tag">PLAYER {player.id}</div><div className="result-stats"><div><small>CORRECT ANSWERS</small><strong>{player.correct}<em>/{state.totalQuestions}</em></strong></div><div><small>TOTAL TIME</small><strong className="result-time">{formatTime(player.totalTimeMs, true)}</strong></div><div><small>{phase === 'finished' ? 'FINAL RANK' : 'CURRENT RANK'}</small><strong><em>#</em>{player.rank}</strong></div></div><p className="muted">{player.forced ? 'The host ended the quiz. Unanswered questions received no credit.' : 'Every answer counted. Thanks for being part of IEEE Day.'}</p>{phase !== 'finished' && <p className="result-live"><span className="live-dot" />{state.finishedCount} of {state.playerCount} finished · Your rank updates live.</p>}<a className="btn btn-secondary" href="/leaderboard" target="_blank" rel="noreferrer">See the leaderboard<ArrowUpRight size={18} /></a><p className="result-verify"><ShieldCheck size={16} />Show your player ID to the host for verification.</p></section> : <section className="question-stage">
      <div className="quiz-player-strip"><span><span className="mini-avatar">{player.name.charAt(0).toUpperCase()}</span><b>{player.name}</b><span className="tag">{player.id}</span></span><StatusBadge phase={phase} connected={connected} /></div>
      <div className="question-meta"><div><span className="eyebrow">KEEP THE CURIOSITY GOING</span><p>Question <b>{Math.min(player.progress + 1, state.totalQuestions)}</b> of {state.totalQuestions}</p></div><Timer startedAt={state.startedAt} serverNow={serverNow} /></div>
      <progress className="quiz-progress" value={player.progress} max={state.totalQuestions} aria-label={`${player.progress} of ${state.totalQuestions} answers submitted`} />
      <div className="answer-feedback" role="status">{locked || notice ? <><Check size={16} />{notice || 'Answer locked.'}</> : <><LockKeyhole size={14} />Choose carefully. Each answer is final.</>}</div>
      {currentQuestion ? <><h1 className="question-heading" ref={questionHeading} tabIndex={-1}>{currentQuestion.question}</h1><div className="answer-grid">{currentQuestion.options.map((option, index) => <button type="button" key={`${player.progress}-${option.originalIndex}`} className={`answer-button answer-${index}`} disabled={busy || locked || !connected} onClick={() => answer(option.originalIndex)}><Shape index={index} /><span className="answer-text">{option.text}</span><span className="answer-position">{['TRIANGLE', 'DIAMOND', 'CIRCLE', 'SQUARE'][index]}</span></button>)}</div></> : <div className="empty-state"><RotateCw size={24} />Loading your questions…</div>}
      <div className="quiz-bottom"><span><Clock3 size={16} />No question time limit. Take a breath.</span><span>{player.progress}/{state.totalQuestions} answers locked</span></div>
      {!connected && <div className="info-message" role="status">Reconnecting… Your saved answers are safe. The quiz timer keeps running.</div>}
    </section>}
  </main><Footer /></div>;
}

function App() {
  const route = window.location.pathname.replace(/\/$/, '') || '/';
  if (route === '/admin') return <Admin />;
  if (route === '/leaderboard') return <Leaderboard />;
  return <Player />;
}

createRoot(document.getElementById('root')).render(<App />);
