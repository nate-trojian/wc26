import type { Game, GameSet } from "./types.js";

const predictionLockOffsetMs = 30 * 60 * 1000;

export function parseGameDate(value: string) {
  const normalized = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  return new Date(normalized);
}

function deadlineBeforeGame(game: Game | undefined) {
  if (!game) {
    return null;
  }

  const gameDate = parseGameDate(game.dateTime);
  if (Number.isNaN(gameDate.getTime())) {
    return null;
  }

  return new Date(gameDate.getTime() - predictionLockOffsetMs);
}

export function setPredictionDeadline(set: GameSet) {
  return deadlineBeforeGame(set.isKnockout ? (set.games[1] ?? set.games[0]) : set.games[0]);
}

export function gamePredictionDeadline(game: Game, set: GameSet) {
  if (!set.isKnockout) {
    return setPredictionDeadline(set);
  }

  const gameIndex = set.games.findIndex((item) => item.id === game.id);
  return deadlineBeforeGame(gameIndex === 0 ? game : (set.games[1] ?? game));
}

export function nextPredictionDeadline(set: GameSet, now = Date.now()) {
  const deadlines = set.games
    .map((game) => gamePredictionDeadline(game, set))
    .filter((deadline): deadline is Date => Boolean(deadline))
    .sort((a, b) => a.getTime() - b.getTime());

  return deadlines.find((deadline) => now < deadline.getTime()) ?? setPredictionDeadline(set);
}

export function deadlineIsClosed(deadline: Date | null, now = Date.now()) {
  return deadline ? now >= deadline.getTime() : false;
}
