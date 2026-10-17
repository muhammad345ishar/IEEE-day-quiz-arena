/** Preserve newer socket progress when an earlier HTTP response arrives late. */
export function mergePlayerState(current, incoming, allowNewGame = false) {
  const sameGame = !current.state || current.state.gameId === incoming.state?.gameId;
  if (!sameGame) return allowNewGame ? { ...incoming, player: incoming.player ?? null, questions: incoming.questions ?? [] } : current;
  const old = incoming.serverNow < (current.serverNow ?? 0);
  const regresses = current.player && incoming.player && current.player.id === incoming.player.id && (incoming.player.progress < current.player.progress || (current.player.finished && !incoming.player.finished));
  const phaseOrder = { closed: 0, lobby: 1, running: 2, finished: 3 };
  const earlierPhase = phaseOrder[incoming.state?.phase] < phaseOrder[current.state?.phase];
  return {
    ...current, ...incoming,
    state: old || earlierPhase ? current.state : incoming.state ?? current.state,
    serverNow: Math.max(current.serverNow ?? 0, incoming.serverNow ?? 0),
    player: (old && current.player) || regresses ? current.player : incoming.player === undefined ? current.player : incoming.player,
    // A safe bank for the same game is useful even if its progress snapshot is old.
    questions: incoming.questions?.length ? incoming.questions : current.questions ?? [],
  };
}
