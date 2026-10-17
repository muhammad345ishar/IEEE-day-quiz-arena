import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Clock3, Radio, ShieldCheck, Trophy, Users, WifiOff } from 'lucide-react';
import { api, Brand, formatTime, useLive, useServerClock } from './shared.jsx';
import './leaderboard.css';

const phaseLabel = { closed: 'GETTING READY', lobby: 'LOBBY OPEN', running: 'LIVE NOW', finished: 'FINAL RESULTS' };

function Confetti() {
  return <div className="board-confetti" aria-hidden="true">{Array.from({ length: 38 }, (_, index) => (
    <i key={index} style={{ '--piece': index, left: `${(index * 37) % 100}%`, animationDelay: `${(index % 9) * 0.17}s` }} />
  ))}</div>;
}

function Lobby({ state, config, players }) {
  const open = state.phase === 'lobby';
  const joinUrl = state.joinUrl || config?.joinUrl;
  return <main className="board-lobby">
    <section className="board-lobby-copy">
      <p className="board-eyebrow"><span />ONE CAMPUS. COUNTLESS POSSIBILITIES.</p>
      <h1>Your name.<br /><span>The big screen.</span></h1>
      <p className="board-lobby-description">A room full of curious minds.<br />One IEEE Day champion. Ready to be the one?</p>
      <div className="board-lobby-count"><Users aria-hidden="true" /><strong>{state.playerCount}</strong><span>minds in the arena<span>{open ? 'Join now. We start together.' : 'The lobby opens soon.'}</span></span></div>
      {players.length > 0 && <div className="board-joined" aria-label="Players in the lobby">
        {players.slice(0, 6).map((player) => <span key={player.id}><i />{player.name}<b>{player.id}</b></span>)}
        {state.playerCount > 6 && <span className="board-more">+{state.playerCount - 6} more</span>}
      </div>}
    </section>
    <section className="board-join-card" aria-label="Join the quiz">
      <div className="board-join-card-top"><span>YOUR NEXT MOVE</span><ArrowUpRight aria-hidden="true" size={30} /></div>
      <h2>Get in<br />the arena.</h2>
      <div className="board-qr-wrap">{config?.qrDataUrl
        ? <img src={config.qrDataUrl} alt={`Scan to join IEEE Day Quiz Arena at ${joinUrl}`} width="240" height="240" />
        : <div className="board-qr-placeholder">Preparing your join code…</div>}</div>
      <p className="board-scan-label">SCAN TO JOIN · NO DOWNLOAD NEEDED</p>
      {joinUrl && <a className="board-join-url" href={joinUrl}>{joinUrl}<ArrowUpRight aria-hidden="true" size={19} /></a>}
      <p className="board-network-hint">Connect to the same Wi-Fi as the host.</p>
    </section>
    <div className="board-lobby-decoration" aria-hidden="true">*</div>
  </main>;
}

function StandingsTable({ players, state, now }) {
  const concealed = state.hideLeaderboardNumbers && state.phase !== 'finished';
  return <div className={`board-standings ${concealed ? 'board-concealed' : ''}`}>
    <div className="board-table" role="table" aria-label={state.phase === 'finished' ? 'Final top ten leaderboard' : 'Live top ten leaderboard'} aria-rowcount={players.length + 1}>
      <div className="board-table-heading board-table-grid" role="row">
        <span role="columnheader">{concealed ? '' : 'RANK'}</span><span role="columnheader">PLAYER</span>
        <span className="board-id-column" role="columnheader">PLAYER ID</span><span role="columnheader">CORRECT</span>
        <span role="columnheader">TIME</span><span className="board-progress-column" role="columnheader">PROGRESS</span>
      </div>
      <div className="board-table-body" role="rowgroup" style={{ height: `calc(${players.length} * var(--board-row-step))` }}>
        {players.map((player, index) => {
          const currentTime = player.finished ? player.totalTimeMs : Math.max(0, now - (state.startedAt ?? now));
          const progress = state.totalQuestions ? Math.min(100, (player.progress / state.totalQuestions) * 100) : 0;
          return <div className={`board-table-row board-table-grid ${player.rank === 1 ? 'board-leader' : ''} ${player.finished ? 'board-row-finished' : ''}`} key={player.id} role="row" aria-rowindex={index + 2} style={{ transform: `translateY(calc(${index} * var(--board-row-step)))` }}>
            <span className="board-rank" role="cell">{concealed ? <span className="board-neutral-dot" /> : String(player.rank).padStart(2, '0')}</span>
            <span className="board-player" role="cell"><strong title={player.name}>{player.name}</strong><span className="board-player-meta"><span className="board-meta-id">{player.id}</span><i /><span>{player.progress}/{state.totalQuestions}<span className="board-meta-answered"> answered</span></span>{player.finished && <Check size={12} aria-label="Finished" />}</span></span>
            <span className="board-id-column board-id" role="cell">{player.id}</span>
            <span className="board-correct" role="cell">{player.correct === null ? <span className="board-hidden-value" aria-label="Hidden">—</span> : player.correct}<small>{player.correct !== null && `/${state.totalQuestions}`}</small></span>
            <span className="board-time" role="cell">{player.totalTimeMs === null ? <span className="board-hidden-value" aria-label="Hidden">—</span> : formatTime(currentTime, player.finished)}{player.finished && <Check className="board-time-check" aria-label={player.forced ? 'Force-finished' : 'Finished'} size={14} />}</span>
            <span className="board-progress-column board-progress" role="cell"><span>{player.progress}<small>/{state.totalQuestions}</small></span><span className="board-progress-track" aria-hidden="true"><i style={{ transform: `scaleX(${progress / 100})` }} /></span></span>
          </div>;
        })}
      </div>
    </div>
    {players.length === 0 && <div className="board-empty"><Users size={32} /><p>No players to display.</p></div>}
    {concealed && <div className="board-privacy-note"><ShieldCheck size={16} />Rankings, scores and times will be revealed when everyone finishes.</div>}
  </div>;
}

function LiveStandings({ players, state, serverNow }) {
  const now = useServerClock(serverNow);
  return <StandingsTable players={players} state={state} now={now} />;
}

function Podium({ players }) {
  const positions = players.length > 1 ? [players[1], players[0], players[2]].filter(Boolean) : players;
  return <section className="board-podium" aria-label="Top three finishers">
    <div className="board-podium-intro"><Trophy size={27} aria-hidden="true" /><span>THE IEEE DAY PODIUM</span></div>
    <h2>The minds<br /><em>on top.</em></h2>
    <div className="board-podium-places">{positions.map((player) => <article key={player.id} className={`board-podium-place board-place-${player.rank}`} aria-label={`Rank ${player.rank}: ${player.name}, ${player.id}`}>
      <div className="board-podium-person">{player.rank === 1 && <Trophy className="board-champion-icon" size={24} aria-hidden="true" />}<h3 title={player.name}>{player.name}</h3><span>{player.id}</span></div>
      <div className="board-podium-block"><strong>{String(player.rank).padStart(2, '0')}</strong><span>{player.correct} correct</span><time>{formatTime(player.totalTimeMs, true)}</time></div>
    </article>)}</div>
  </section>;
}

export default function Leaderboard() {
  const [data, setData] = useState(null);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const requestNumber = useRef(0);
  const reload = useCallback(async () => {
    const request = ++requestNumber.current;
    try {
      const result = await api('/api/leaderboard');
      if (request === requestNumber.current) { setData(result); setError(''); }
    } catch (problem) { if (request === requestNumber.current) setError(problem.message); }
  }, []);
  const { connected, reconnect } = useLive('leaderboard', ({ type, payload }) => {
    if (type === 'connect') {
      reload();
      api('/api/config').then(setConfig).catch((problem) => setError(problem.message));
    }
    if (type === 'leaderboard') { requestNumber.current += 1; setData(payload); setError(''); }
    if (type === 'state') setData((current) => current ? { ...current, state: payload.state, serverNow: payload.serverNow } : current);
    if (type === 'server-error') setError(payload?.error || 'The host needs attention. Waiting for an update.');
    if (type === 'connect_error') setError(payload?.error || 'The host is temporarily unavailable.');
  });
  useEffect(() => {
    reload();
    let active = true;
    api('/api/config').then((result) => { if (active) setConfig(result); }).catch((problem) => { if (active) setError(problem.message); });
    return () => { active = false; requestNumber.current += 1; };
  }, [reload]);
  const state = data?.state;
  const players = data?.players ?? [];
  const finished = state?.phase === 'finished';
  const lobby = state && ['closed', 'lobby'].includes(state.phase);
  return <div className={`board-page ${finished ? 'board-final' : ''} ${lobby ? 'board-lobby-page' : ''}`}>
    {finished && <Confetti key={state.gameId} />}
    <header className="board-header"><div className="board-brand"><Brand /></div><div className="board-event">IEEE DAY <b>2026</b><span>THE QUIZ ARENA</span></div><div className={`board-status ${connected ? '' : 'board-offline'}`} role="status">{connected ? <Radio size={16} /> : <WifiOff size={16} />}<span>{connected ? phaseLabel[state?.phase] || 'CONNECTING' : 'RECONNECTING'}</span></div></header>
    {error && <div className="board-error" role="alert"><span>{error}</span><button onClick={() => { reload(); reconnect(); }}>Reconnect</button></div>}
    {!data && <main className="board-loading"><Radio size={36} /><h1>Getting the arena ready.</h1><p>Connecting to the host laptop…</p></main>}
    {lobby && <Lobby state={state} config={config} players={players} />}
    {state && !lobby && <main className="board-results">
      <div className="board-results-heading"><div><p className="board-eyebrow">{finished ? 'ALL ANSWERS LOCKED. HERE ARE YOUR CHAMPIONS.' : 'EVERY ANSWER MOVES THE GAME.'}</p><h1>{finished ? 'The final leaderboard.' : 'Live leaderboard.'}<span /></h1></div><div className="board-finished-count"><strong>{state.finishedCount}<span>/{state.playerCount}</span></strong><span>{finished ? 'PLAYERS FINISHED' : 'FINISHED THE QUIZ'}</span></div></div>
      <div className="board-results-layout">{finished && players.length > 0 && <Podium players={players.slice(0, 3)} />}<section className="board-ranking-section" aria-label="Leaderboard standings">{finished && <div className="board-ranking-label"><span>FINAL STANDINGS</span><span>TOP {Math.min(10, state.playerCount)}</span></div>}{finished ? <StandingsTable players={players} state={state} now={data.serverNow} /> : <LiveStandings players={players} state={state} serverNow={data.serverNow} />}</section></div>
    </main>}
    <footer className="board-footer"><span>IEEE COMPUTER SOCIETY <i /> PIEAS STUDENT CHAPTER</span><span>{lobby ? 'CELEBRATING THE MINDS THAT BUILD TOMORROW.' : <><Clock3 size={13} />MOST CORRECT. FASTEST FINISH.</>}</span></footer>
  </div>;
}
