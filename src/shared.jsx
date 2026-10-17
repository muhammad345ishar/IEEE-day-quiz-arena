import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { ArrowUpRight, Radio } from 'lucide-react';

export async function api(path, body) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error ?? 'The request failed. Try again.'); error.status = response.status; throw error; }
  return data;
}

/** Sockets only carry live views. Reconnect always asks the screen to resync via HTTP. */
export function useLive(role, onEvent, enabled = true) {
  const callback = useRef(onEvent), socketRef = useRef(null);
  callback.current = onEvent;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!enabled) { setConnected(false); return; }
    const socket = io({ auth: { role }, withCredentials: true, reconnectionDelay: 500, reconnectionDelayMax: 3000 });
    socketRef.current = socket;
    socket.on('connect', () => { setConnected(true); callback.current({ type: 'connect' }); });
    socket.on('disconnect', reason => {
      setConnected(false); callback.current({ type: 'disconnect', payload: { reason } });
      // A kicked player still needs the public lobby channel for the next round.
      if (reason === 'io server disconnect' && role === 'player') socket.connect();
    });
    socket.on('connect_error', error => { setConnected(false); callback.current({ type: 'connect_error', payload: { error: error.message } }); });
    for (const type of ['state', 'player', 'admin', 'leaderboard', 'session-invalid', 'server-error']) {
      socket.on(type, payload => callback.current({ type, payload }));
    }
    return () => { socket.removeAllListeners(); socket.disconnect(); socketRef.current = null; };
  }, [role, enabled]);
  return { connected, reconnect: () => { socketRef.current?.disconnect(); socketRef.current?.connect(); } };
}

export function formatTime(milliseconds, precise = false) {
  if (milliseconds === null || milliseconds === undefined) return '—';
  const ms = Math.max(0, Math.floor(milliseconds));
  const seconds = Math.floor(ms / 1000);
  const result = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return precise ? `${result}.${String(ms % 1000).padStart(3, '0')}` : result;
}

export function useServerClock(serverNow) {
  const anchor = useRef({ server: serverNow ?? Date.now(), local: performance.now() });
  const [clock, setClock] = useState(serverNow ?? Date.now());
  useEffect(() => { if (serverNow) { anchor.current = { server: serverNow, local: performance.now() }; setClock(serverNow); } }, [serverNow]);
  useEffect(() => {
    const timer = setInterval(() => setClock(anchor.current.server + performance.now() - anchor.current.local), 200);
    return () => clearInterval(timer);
  }, []);
  return clock;
}

export function Brand() {
  return <a href="/" className="brand" aria-label="IEEE Day Quiz Arena home"><img src="/ieee-cs-logo.svg" alt="IEEE Computer Society" width="174" height="54" /><span className="brand-divider" /><span className="brand-chapter">PIEAS<span>STUDENT CHAPTER</span></span></a>;
}

export function Header({ active = 'player', connected = true }) {
  return <header className="site-header"><Brand /><nav aria-label="Main navigation">
    <a href="/" aria-current={active === 'player' ? 'page' : undefined}>Quiz arena</a>
    <a href="/leaderboard" target="_blank" rel="noreferrer">Leaderboard <ArrowUpRight size={15} /></a>
    <a href="/admin" aria-current={active === 'admin' ? 'page' : undefined}>Admin console</a>
  </nav><span className={`connection ${connected ? '' : 'offline'}`}><span />{connected ? 'LOCAL & LIVE' : 'RECONNECTING'}</span></header>;
}

export function StatusBadge({ phase = 'closed', connected = true }) {
  const label = { closed: 'Getting ready', lobby: 'Lobby open', running: 'Quiz is live', finished: 'Quiz complete' }[phase];
  return <span className={`status-badge phase-${phase}`}><Radio size={14} />{connected ? label : 'Reconnecting…'}</span>;
}

export function Footer() {
  return <footer className="site-footer"><span>IEEE DAY <b>2026</b><i />Celebrating the minds that build tomorrow.</span><span>IEEE Computer Society · PIEAS</span></footer>;
}
