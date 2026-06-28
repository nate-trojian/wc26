import "./styles.css";
import { isAdminEmail } from "./config/admin.js";
import { isAllowedEmail, normalizeEmail } from "./config/allowedEmails.js";
import { participants } from "./config/participants.js";
import { gameSets } from "./data/games.js";
import { matchResults as seedMatchResults } from "./data/results.js";
import { teamEspnLinks } from "./data/teamLinks.js";
import {
  deadlineIsClosed,
  gamePredictionDeadline,
  nextPredictionDeadline,
  parseGameDate,
  setPredictionDeadline,
} from "./deadlines.js";
import { buildLeaderboard } from "./scoring.js";
import type {
  EndingPhase,
  Game,
  GameResult,
  GameSet,
  GameSetId,
  LeaderboardEntry,
  MatchStatus,
  Participant,
  Prediction,
  PredictionMatrixPayload,
  PredictionsByEmail,
  PredictionsByGame,
} from "./types.js";

const emailStorageKey = "wc26-email";
const accessTokenStorageKey = "wc26-access-token";
const localPredictionsStoragePrefix = "wc26-local-predictions";
const currentGameWindowBeforeMs = 45 * 60 * 1000;
const currentGameWindowAfterMs = 135 * 60 * 1000;
const scoreRefreshMs = 5 * 60 * 1000;
const idleScoreRefreshMs = 30 * 60 * 1000;
const app = document.querySelector<HTMLDivElement>("#app");
const validateEmailsLocally = import.meta.env.DEV;
const requireAccessToken = !import.meta.env.DEV;

type ActiveView = "predictions" | "leaderboard" | "predictionMatrix";
const endingPhaseLabels: Record<EndingPhase, string> = {
  regular: "Regular time",
  extra: "Extra time",
  pks: "PKs",
};
const endingPhaseControlLabels: Record<EndingPhase, string> = {
  regular: "Reg",
  extra: "ET",
  pks: "PKs",
};

type AppState = {
  email: string | null;
  accessToken: string | null;
  predictions: PredictionsByGame;
  matchResults: readonly GameResult[];
  matchStatuses: readonly MatchStatus[];
  leaderboard: LeaderboardEntry[];
  predictionMatrix: PredictionMatrixPayload | null;
  leaderboardLoaded: boolean;
  resultsCount: number;
  activeSetId: GameSetId;
  activeView: ActiveView;
  loading: boolean;
  leaderboardLoading: boolean;
  message: string;
};

function defaultActiveSetId(now = Date.now()): GameSetId {
  return (
    gameSets
      .map((set) => ({ id: set.id, startsAt: set.games[0] ? parseGameDate(set.games[0].dateTime).getTime() : NaN }))
      .filter(({ startsAt }) => !Number.isNaN(startsAt) && startsAt <= now)
      .sort((a, b) => b.startsAt - a.startsAt)[0]?.id ??
    gameSets[0]?.id ??
    "first"
  );
}

const state: AppState = {
  email: localStorage.getItem(emailStorageKey),
  accessToken: localStorage.getItem(accessTokenStorageKey),
  predictions: {},
  matchResults: seedMatchResults,
  matchStatuses: [],
  leaderboard: [],
  predictionMatrix: null,
  leaderboardLoaded: false,
  resultsCount: seedMatchResults.length,
  activeSetId: defaultActiveSetId(),
  activeView: "predictions",
  loading: false,
  leaderboardLoading: false,
  message: "",
};

function formatGameTime(value: string) {
  const date = parseGameDate(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatDeadline(date: Date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function gameSetForGame(game: Game) {
  return gameSets.find((set) => set.games.some((item) => item.id === game.id));
}

function resultForGame(gameId: string): GameResult | undefined {
  return state.matchResults.find((result) => result.gameId === gameId);
}

function matchStatusForGame(gameId: string): MatchStatus | undefined {
  return state.matchStatuses.find((status) => status.gameId === gameId);
}

function readableStatusName(statusName: string) {
  const statusLabels: Record<string, string> = {
    STATUS_IN_PROGRESS: "Live",
    STATUS_FIRST_HALF: "1H",
    STATUS_HALFTIME: "HT",
    STATUS_SECOND_HALF: "2H",
    STATUS_FULL_TIME: "FT",
    STATUS_FINAL: "Final",
    STATUS_SCHEDULED: "Scheduled",
  };

  return statusLabels[statusName] ?? statusName;
}

function liveStatusLabel(status: MatchStatus) {
  const statusName = readableStatusName(status.statusName);
  return status.displayClock ? `${statusName} ${status.displayClock}` : statusName;
}

function scoreOutcome(homeScore: number, awayScore: number) {
  return Math.sign(homeScore - awayScore);
}

function isKnockoutGame(game: Game) {
  return Boolean(gameSetForGame(game)?.isKnockout);
}

function outcomeLabel(game: Game, homeScore: number, awayScore: number) {
  const outcome = scoreOutcome(homeScore, awayScore);
  if (outcome > 0) {
    return `${game.homeTeam} win`;
  }

  if (outcome < 0) {
    return `${game.awayTeam} win`;
  }

  return "Draw";
}

function resultWinningTeamId(game: Game, result: GameResult) {
  if (result.winningTeamId) {
    return result.winningTeamId;
  }

  if (result.homeScore > result.awayScore) {
    return game.homeTeamId;
  }

  if (result.awayScore > result.homeScore) {
    return game.awayTeamId;
  }

  return undefined;
}

function selectedTeamScoreForResult(game: Game, result: GameResult, teamId: number) {
  if (teamId === game.homeTeamId) {
    return result.homeScore;
  }

  if (teamId === game.awayTeamId) {
    return result.awayScore;
  }

  return undefined;
}

function teamNameForId(game: Game, teamId: number | undefined) {
  if (teamId === game.homeTeamId) {
    return game.homeTeam;
  }

  if (teamId === game.awayTeamId) {
    return game.awayTeam;
  }

  return "";
}

function knockoutPredictionLabel(game: Game, prediction: Prediction | undefined) {
  if (!prediction?.winningTeamId || prediction.selectedTeamScore === undefined || !prediction.endingPhase) {
    return "";
  }

  return `${teamNameForId(game, prediction.winningTeamId)} ${prediction.selectedTeamScore}, ${endingPhaseLabels[prediction.endingPhase]}`;
}

function knockoutOutcomeClass(game: Game, prediction: Prediction | undefined, result: GameResult | undefined) {
  if (!prediction?.winningTeamId || !result) {
    return "";
  }

  return prediction.winningTeamId === resultWinningTeamId(game, result) ? "outcome-correct" : "outcome-wrong";
}

function pointsEarned(game: Game, prediction: Prediction | undefined, result: GameResult | undefined) {
  if (!prediction || !result) {
    return 0;
  }

  if (isKnockoutGame(game)) {
    if (!prediction.winningTeamId || prediction.selectedTeamScore === undefined || !prediction.endingPhase) {
      return 0;
    }

    const winnerExact = prediction.winningTeamId === resultWinningTeamId(game, result) ? 1 : 0;
    const selectedScore = selectedTeamScoreForResult(game, result, prediction.winningTeamId);
    const scoreExact = selectedScore === prediction.selectedTeamScore ? 1 : 0;
    const phaseExact =
      result.endingPhase && prediction.endingPhase === result.endingPhase && (winnerExact || prediction.endingPhase === "pks")
        ? 1
        : 0;

    return winnerExact * 2 + scoreExact + phaseExact;
  }

  const homeExact = prediction.homeScore === result.homeScore ? 1 : 0;
  const awayExact = prediction.awayScore === result.awayScore ? 1 : 0;
  const outcomeExact =
    scoreOutcome(prediction.homeScore, prediction.awayScore) === scoreOutcome(result.homeScore, result.awayScore)
      ? 1
      : 0;

  return homeExact + awayExact + outcomeExact;
}

function renderTeamLink(teamId: number, teamName: string) {
  const href = teamEspnLinks[teamId as keyof typeof teamEspnLinks];
  if (!href) {
    return `<span>${teamName}</span>`;
  }

  return `<a class="team-link" href="${href}" target="_blank" rel="noopener noreferrer">${teamName}</a>`;
}

function inputScore(input: HTMLInputElement | null) {
  const value = input?.value.trim() ?? "";
  if (value === "") {
    return null;
  }

  const score = Number(value);
  return Number.isInteger(score) && score >= 0 ? score : null;
}

function sectionIsClosed(set: GameSet) {
  return deadlineIsClosed(setPredictionDeadline(set));
}

function gameIsClosed(game: Game, set: GameSet) {
  return deadlineIsClosed(gamePredictionDeadline(game, set));
}

function gameHasUpcomingEarlyLock(game: Game, set: GameSet) {
  return Boolean(
    set.isKnockout &&
      set.games.length > 1 &&
      set.games[0]?.id === game.id &&
      !deadlineIsClosed(gamePredictionDeadline(game, set)),
  );
}

function gameCardSelector(gameId: string) {
  return `[data-game-card-id="${CSS.escape(gameId)}"]`;
}

function gameCardTop(gameId: string) {
  return document.querySelector<HTMLElement>(gameCardSelector(gameId))?.getBoundingClientRect().top;
}

function renderKeepingGameInPlace(gameId: string, targetTop = gameCardTop(gameId)) {
  const beforeCard = document.querySelector<HTMLElement>(gameCardSelector(gameId));
  const beforeTop = targetTop ?? beforeCard?.getBoundingClientRect().top;

  render();

  if (beforeTop === undefined) {
    return;
  }

  const afterCard = document.querySelector<HTMLElement>(gameCardSelector(gameId));
  const scroller = afterCard?.closest<HTMLElement>(".matches-scroll");

  if (!afterCard || !scroller) {
    return;
  }

  scroller.scrollTop += afterCard.getBoundingClientRect().top - beforeTop;
}

function setMessage(message: string, anchoredGameId?: string, anchorTop?: number) {
  state.message = message;
  if (anchoredGameId) {
    renderKeepingGameInPlace(anchoredGameId, anchorTop);
    return;
  }

  render();
}

function completedCount(games: readonly Game[]) {
  return games.filter((game) => state.predictions[game.id]).length;
}

function jumpTargetForSet(set: GameSet, now = Date.now()) {
  const gamesByKickoff = set.games
    .map((game) => ({ game, kickoff: parseGameDate(game.dateTime).getTime() }))
    .filter(({ kickoff }) => !Number.isNaN(kickoff))
    .sort((a, b) => a.kickoff - b.kickoff);

  return (
    gamesByKickoff.find(
      ({ kickoff }) => now >= kickoff - currentGameWindowBeforeMs && now <= kickoff + currentGameWindowAfterMs,
    )?.game ??
    gamesByKickoff.find(({ kickoff }) => kickoff > now)?.game ??
    null
  );
}

function hasCurrentGameRefreshWindow(now = Date.now()) {
  return gameSets
    .flatMap((set) => set.games)
    .some((game) => {
      const kickoff = parseGameDate(game.dateTime).getTime();
      return (
        !Number.isNaN(kickoff) &&
        now >= kickoff - currentGameWindowBeforeMs &&
        now <= kickoff + currentGameWindowAfterMs
      );
    });
}

function nextScoreRefreshMs() {
  return hasCurrentGameRefreshWindow() ? scoreRefreshMs : idleScoreRefreshMs;
}

function jumpToGame(gameId: string) {
  const card = document.querySelector<HTMLElement>(gameCardSelector(gameId));
  if (!card) {
    return;
  }

  card.scrollIntoView({ behavior: "smooth", block: "start" });
}

function runningStandaloneViteDev() {
  return import.meta.env.DEV;
}

function canUseEmailLocally(email: string) {
  return !validateEmailsLocally || isAllowedEmail(email);
}

function canUseStoredCredentials() {
  return Boolean(state.email && (!requireAccessToken || state.accessToken));
}

function authHeaders(): Record<string, string> {
  return state.accessToken ? { "X-WC26-Access-Token": state.accessToken } : {};
}

function rejectStoredEmail(message: string) {
  localStorage.removeItem(emailStorageKey);
  localStorage.removeItem(accessTokenStorageKey);
  state.email = null;
  state.accessToken = null;
  state.predictions = {};
  state.message = message;
}

function localPredictionsStorageKey(email: string) {
  return `${localPredictionsStoragePrefix}:${normalizeEmail(email)}`;
}

function loadLocalPredictions(email: string): PredictionsByGame {
  try {
    const stored = localStorage.getItem(localPredictionsStorageKey(email));
    return stored ? (JSON.parse(stored) as PredictionsByGame) : {};
  } catch {
    return {};
  }
}

function saveLocalPredictions(email: string, predictions: PredictionsByGame) {
  localStorage.setItem(localPredictionsStorageKey(email), JSON.stringify(predictions));
}

function loadAllLocalPredictions() {
  return Object.fromEntries(
    participants.map((participant) => [participant.email, loadLocalPredictions(participant.email)] as const),
  );
}

async function readJsonResponse(response: Response) {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Prediction API unavailable.");
  }

  return response.json();
}

async function fetchPredictions(email: string, options: { silent?: boolean } = {}) {
  if (runningStandaloneViteDev()) {
    state.predictions = loadLocalPredictions(email);
    state.matchResults = seedMatchResults;
    state.matchStatuses = [];
    state.resultsCount = seedMatchResults.length;
    state.message = "";
    render();
    return;
  }

  if (!options.silent) {
    state.loading = true;
    render();
  }

  try {
    const params = new URLSearchParams({ email });
    if (options.silent) {
      params.set("scoresOnly", "true");
    }

    const response = await fetch(`/api/predictions?${params.toString()}`, {
      headers: authHeaders(),
    });
    const payload = await readJsonResponse(response);

    if (!response.ok) {
      if (response.status === 403) {
        rejectStoredEmail(payload.error ?? "This email is not on the allowed list.");
      }
      throw new Error(payload.error ?? "Could not load predictions.");
    }

    if (payload.predictions) {
      state.predictions = payload.predictions;
    }
    state.matchResults = payload.results ?? [];
    state.matchStatuses = payload.matchStatuses ?? [];
    state.resultsCount = state.matchResults.length;
    if (!options.silent) {
      state.message = "";
    }
  } catch (error) {
    if (state.email && !options.silent) {
      state.message = error instanceof Error ? error.message : "Could not load predictions.";
    }
  } finally {
    if (!options.silent) {
      state.loading = false;
    }
    render();
  }
}

async function fetchLeaderboard() {
  if (!state.email) {
    return;
  }

  if (runningStandaloneViteDev()) {
    const predictionsByEmail = loadAllLocalPredictions();
    state.leaderboard = buildLeaderboard(participants, predictionsByEmail, state.matchResults);
    state.predictionMatrix = canViewPredictionMatrix()
      ? { participants: [...participants], predictionsByEmail }
      : null;
    state.resultsCount = state.matchResults.length;
    state.leaderboardLoaded = true;
    render();
    return;
  }

  state.leaderboardLoading = true;
  render();

  try {
    const response = await fetch(`/api/leaderboard?email=${encodeURIComponent(state.email)}`, {
      headers: authHeaders(),
    });
    const payload = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(payload.error ?? "Could not load leaderboard.");
    }

    state.leaderboard = payload.leaderboard ?? [];
    state.predictionMatrix = canViewPredictionMatrix() ? (payload.predictionMatrix ?? null) : null;
    state.resultsCount = payload.resultsCount ?? 0;
    state.leaderboardLoaded = true;
  } catch (error) {
    state.message = error instanceof Error ? error.message : "Could not load leaderboard.";
  } finally {
    state.leaderboardLoading = false;
    render();
  }
}

async function savePrediction(game: Game) {
  if (!state.email) {
    return;
  }

  const anchorTop = gameCardTop(game.id);
  const gameSet = gameSetForGame(game);
  const result = resultForGame(game.id);
  if (result) {
    setMessage(`${game.homeTeam} vs ${game.awayTeam} is final. Predictions are locked.`, game.id, anchorTop);
    return;
  }

  if (gameSet && gameIsClosed(game, gameSet)) {
    const deadline = gamePredictionDeadline(game, gameSet);
    setMessage(`${game.homeTeam} vs ${game.awayTeam} closed ${deadline ? formatDeadline(deadline) : "before kickoff"}.`, game.id, anchorTop);
    return;
  }

  const homeInput = document.querySelector<HTMLInputElement>(`#${game.id}-home`);
  const awayInput = document.querySelector<HTMLInputElement>(`#${game.id}-away`);
  const knockout = isKnockoutGame(game);
  const winnerInput = document.querySelector<HTMLInputElement>(`#${game.id}-winner`);
  const selectedScoreInput = document.querySelector<HTMLInputElement>(`#${game.id}-selected-score`);
  const phaseInput = document.querySelector<HTMLInputElement>(`input[name="${game.id}-ending-phase"]:checked`);
  const winningTeamId = Number(winnerInput?.value);
  const selectedTeamScore = Number(selectedScoreInput?.value);
  const endingPhase = phaseInput?.value as EndingPhase | undefined;
  const homeScore = knockout && winningTeamId === game.homeTeamId ? selectedTeamScore : Number(homeInput?.value);
  const awayScore = knockout && winningTeamId === game.awayTeamId ? selectedTeamScore : Number(awayInput?.value);

  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) {
    setMessage("Use whole-number scores.", game.id, anchorTop);
    return;
  }

  if (
    knockout &&
    (winningTeamId !== game.homeTeamId &&
      winningTeamId !== game.awayTeamId ||
      !Number.isInteger(selectedTeamScore) ||
      selectedTeamScore < 0 ||
      !endingPhase ||
      !Object.keys(endingPhaseLabels).includes(endingPhase))
  ) {
    setMessage("Pick a winner, that team's score, and the ending phase.", game.id, anchorTop);
    return;
  }

  state.message = `Saving ${game.homeTeam} vs ${game.awayTeam}`;
  renderKeepingGameInPlace(game.id, anchorTop);

  if (runningStandaloneViteDev()) {
    state.predictions = {
      ...state.predictions,
      [game.id]: {
        homeScore,
        awayScore,
        ...(knockout
          ? {
              winningTeamId,
              selectedTeamScore,
              endingPhase,
            }
          : {}),
        updatedAt: new Date().toISOString(),
      },
    };
    saveLocalPredictions(state.email, state.predictions);
    state.leaderboardLoaded = false;
    state.message = "";
    renderKeepingGameInPlace(game.id, anchorTop);
    return;
  }

  try {
    const response = await fetch("/api/predictions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        email: state.email,
        prediction: {
          gameId: game.id,
          homeScore,
          awayScore,
          ...(knockout
            ? {
                winningTeamId,
                selectedTeamScore,
                endingPhase,
              }
            : {}),
        },
      }),
    });
    const payload = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(payload.error ?? "Could not save prediction.");
    }

    state.predictions = payload.predictions ?? {};
    state.leaderboardLoaded = false;
    state.message = "";
  } catch (error) {
    state.message = error instanceof Error ? error.message : "Could not save prediction.";
  } finally {
    renderKeepingGameInPlace(game.id, anchorTop);
  }
}

function login(email: string, accessToken: string) {
  const normalized = normalizeEmail(email);
  const token = accessToken.trim();

  if (!canUseEmailLocally(normalized)) {
    state.message = "This email is not on the allowed list.";
    render();
    return;
  }

  if (requireAccessToken && !token) {
    state.message = "Enter your access token.";
    render();
    return;
  }

  localStorage.setItem(emailStorageKey, normalized);
  if (token) {
    localStorage.setItem(accessTokenStorageKey, token);
  } else {
    localStorage.removeItem(accessTokenStorageKey);
  }
  state.email = normalized;
  state.accessToken = token;
  state.activeView = "predictions";
  state.predictionMatrix = null;
  state.leaderboardLoaded = false;
  fetchPredictions(normalized);
}

function logout() {
  localStorage.removeItem(emailStorageKey);
  localStorage.removeItem(accessTokenStorageKey);
  state.email = null;
  state.accessToken = null;
  state.predictions = {};
  state.leaderboard = [];
  state.predictionMatrix = null;
  state.leaderboardLoaded = false;
  state.matchResults = seedMatchResults;
  state.matchStatuses = [];
  state.resultsCount = seedMatchResults.length;
  state.activeView = "predictions";
  state.message = "";
  render();
}

function renderLogin() {
  const accessTokenField = requireAccessToken
    ? `
          <label for="access-token">Access token</label>
          <div class="login-row">
            <input id="access-token" name="access-token" type="password" autocomplete="current-password" required />
          </div>
        `
    : "";

  app!.innerHTML = `
    <main class="login-shell">
      <section class="login-panel">
        <div>
          <p class="eyebrow">WC26 Pool</p>
          <h1>Score Predictions</h1>
        </div>
        <form id="login-form" class="login-form">
          <label for="email">Email</label>
          <div class="login-row">
            <input id="email" name="email" type="email" autocomplete="email" required />
            <button type="submit">Log In</button>
          </div>
          ${accessTokenField}
        </form>
        ${state.message ? `<p class="status error">${state.message}</p>` : ""}
      </section>
    </main>
  `;

  document.querySelector<HTMLFormElement>("#login-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    login(String(form.get("email") ?? ""), String(form.get("access-token") ?? ""));
  });
}

function renderGame(game: Game) {
  const prediction = state.predictions[game.id];
  const gameSet = gameSetForGame(game);
  const result = resultForGame(game.id);
  const liveStatus = matchStatusForGame(game.id);
  const knockout = isKnockoutGame(game);
  const showLiveScore =
    !result &&
    liveStatus?.state === "in" &&
    liveStatus.homeScore !== null &&
    liveStatus.awayScore !== null;
  const isFinal = Boolean(result);
  const closed = isFinal || (gameSet ? gameIsClosed(game, gameSet) : false);
  const homeValue = prediction?.homeScore ?? "";
  const awayValue = prediction?.awayScore ?? "";
  const selectedScoreValue = prediction?.selectedTeamScore ?? "";
  const winnerValue = prediction?.winningTeamId ?? "";
  const endingPhaseValue = prediction?.endingPhase ?? "regular";
  const homeResultClass =
    result && prediction ? (prediction.homeScore === result.homeScore ? "score-correct" : "score-wrong") : "";
  const awayResultClass =
    result && prediction ? (prediction.awayScore === result.awayScore ? "score-correct" : "score-wrong") : "";
  const predictedOutcome = knockout
    ? knockoutPredictionLabel(game, prediction)
    : prediction
      ? outcomeLabel(game, prediction.homeScore, prediction.awayScore)
      : "";
  const outcomeResultClass =
    knockout
      ? knockoutOutcomeClass(game, prediction, result)
      : result && prediction
      ? scoreOutcome(prediction.homeScore, prediction.awayScore) === scoreOutcome(result.homeScore, result.awayScore)
        ? "outcome-correct"
        : "outcome-wrong"
      : "";
  const earnedPoints = pointsEarned(game, prediction, result);
  const maxPoints = knockout ? 4 : 3;
  const savedLabel = prediction
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(prediction.updatedAt))
    : "";
  const earlyLockClass = gameSet && gameHasUpcomingEarlyLock(game, gameSet) ? "early-lock" : "";

  return `
    <article class="game-card ${earlyLockClass} ${isFinal ? "final" : ""}" data-game-card-id="${game.id}">
      <div class="game-meta">
        <span>Match ${game.matchNumber}</span>
        <time>${formatGameTime(game.dateTime)}</time>
      </div>
      ${
        result
          ? `<div class="final-score" aria-label="Final score">
              <span>Final</span>
              <strong>
                ${renderTeamLink(game.homeTeamId, game.homeTeam)}
                ${result.homeScore}-${result.awayScore}
                ${renderTeamLink(game.awayTeamId, game.awayTeam)}
              </strong>
            </div>`
          : showLiveScore
            ? `<div class="live-score" aria-label="Live score">
              <span>${liveStatusLabel(liveStatus)}</span>
              <strong>
                ${renderTeamLink(game.homeTeamId, game.homeTeam)}
                ${liveStatus.homeScore}-${liveStatus.awayScore}
                ${renderTeamLink(game.awayTeamId, game.awayTeam)}
              </strong>
            </div>`
          : ""
      }
      ${
        knockout
          ? `<div class="knockout-prediction-grid">
              <label>
                <span>Winner</span>
                <div class="winner-button-group" role="group" aria-label="Winning team">
                  <button class="${winnerValue === game.homeTeamId ? "selected" : ""}" type="button" data-winner-team-id="${game.homeTeamId}" data-winner-game-id="${game.id}" ${closed ? "disabled" : ""}>${game.homeTeam}</button>
                  <button class="${winnerValue === game.awayTeamId ? "selected" : ""}" type="button" data-winner-team-id="${game.awayTeamId}" data-winner-game-id="${game.id}" ${closed ? "disabled" : ""}>${game.awayTeam}</button>
                </div>
                <input id="${game.id}-winner" type="hidden" value="${winnerValue}" />
              </label>
              <label>
                <span>Score</span>
                <input id="${game.id}-selected-score" inputmode="numeric" type="number" min="0" max="99" value="${selectedScoreValue}" aria-label="Selected team's score" ${closed ? "disabled" : ""} />
              </label>
              <div class="ending-phase-group" role="radiogroup" aria-label="Ending phase">
                <span>End</span>
                <div>
                  ${Object.entries(endingPhaseControlLabels)
                    .map(
                      ([phase, label]) => `
                        <label>
                          <input type="radio" name="${game.id}-ending-phase" value="${phase}" ${endingPhaseValue === phase ? "checked" : ""} ${closed ? "disabled" : ""} />
                          <span>${label}</span>
                        </label>
                      `,
                    )
                    .join("")}
                </div>
              </div>
            </div>
            <input id="${game.id}-home" type="hidden" value="${homeValue}" />
            <input id="${game.id}-away" type="hidden" value="${awayValue}" />`
          : `<div class="prediction-grid">
              <div class="team-score">
                ${renderTeamLink(game.homeTeamId, game.homeTeam)}
                <input class="${homeResultClass}" id="${game.id}-home" inputmode="numeric" type="number" min="0" max="99" value="${homeValue}" aria-label="${game.homeTeam} score" ${closed ? "disabled" : ""} />
              </div>
              <span class="versus">vs</span>
              <div class="team-score">
                ${renderTeamLink(game.awayTeamId, game.awayTeam)}
                <input class="${awayResultClass}" id="${game.id}-away" inputmode="numeric" type="number" min="0" max="99" value="${awayValue}" aria-label="${game.awayTeam} score" ${closed ? "disabled" : ""} />
              </div>
            </div>`
      }
      <div id="${game.id}-outcome" class="predicted-outcome ${outcomeResultClass}">
        <span>${knockout ? "Knockout pick" : "Predicted outcome"}</span>
        <strong>${predictedOutcome || "Not predicted"}</strong>
      </div>
      ${
        result
          ? `<div class="points-earned">
              <span>Points earned</span>
              <strong>${earnedPoints}/${maxPoints}</strong>
            </div>`
          : ""
      }
      <div class="game-actions">
        <span>${
          isFinal
            ? "Final score posted"
            : showLiveScore
              ? "Match in progress"
              : savedLabel
                ? `Saved ${savedLabel}`
                : "Not saved"
        }</span>
        <button class="save-button" data-game-id="${game.id}" type="button" ${closed ? "disabled" : ""}>
          ${isFinal ? "Locked" : "Save"}
        </button>
      </div>
    </article>
  `;
}

function updatePredictedOutcome(game: Game) {
  const outcome = document.querySelector<HTMLDivElement>(`#${game.id}-outcome`);
  const outcomeValue = outcome?.querySelector("strong");

  if (!outcome || !outcomeValue) {
    return;
  }

  outcome.classList.remove("outcome-correct", "outcome-wrong");

  if (isKnockoutGame(game)) {
    const winnerInput = document.querySelector<HTMLInputElement>(`#${game.id}-winner`);
    const selectedScore = inputScore(document.querySelector<HTMLInputElement>(`#${game.id}-selected-score`));
    const endingPhase = document.querySelector<HTMLInputElement>(`input[name="${game.id}-ending-phase"]:checked`)?.value as
      | EndingPhase
      | undefined;
    const winningTeamId = Number(winnerInput?.value);

    if (
      (winningTeamId !== game.homeTeamId && winningTeamId !== game.awayTeamId) ||
      selectedScore === null ||
      !endingPhase
    ) {
      outcomeValue.textContent = "Not predicted";
      return;
    }

    outcomeValue.textContent = `${teamNameForId(game, winningTeamId)} ${selectedScore}, ${endingPhaseLabels[endingPhase]}`;

    const result = resultForGame(game.id);
    if (result) {
      outcome.classList.add(winningTeamId === resultWinningTeamId(game, result) ? "outcome-correct" : "outcome-wrong");
    }
    return;
  }

  const homeScore = inputScore(document.querySelector<HTMLInputElement>(`#${game.id}-home`));
  const awayScore = inputScore(document.querySelector<HTMLInputElement>(`#${game.id}-away`));

  if (homeScore === null || awayScore === null) {
    outcomeValue.textContent = "Not predicted";
    return;
  }

  outcomeValue.textContent = outcomeLabel(game, homeScore, awayScore);

  const result = resultForGame(game.id);
  if (!result) {
    return;
  }

  outcome.classList.add(
    scoreOutcome(homeScore, awayScore) === scoreOutcome(result.homeScore, result.awayScore)
      ? "outcome-correct"
      : "outcome-wrong",
  );
}

function renderViewTabs() {
  return `
    <nav class="view-tabs" aria-label="Pages">
      <button class="${state.activeView === "predictions" ? "active" : ""}" data-view="predictions" type="button">
        Predictions
      </button>
      <button class="${state.activeView === "leaderboard" ? "active" : ""}" data-view="leaderboard" type="button">
        Leaderboard
      </button>
      ${
        canViewPredictionMatrix()
          ? `<button class="desktop-only-view ${state.activeView === "predictionMatrix" ? "active" : ""}" data-view="predictionMatrix" type="button">
              Picks
            </button>`
          : ""
      }
    </nav>
  `;
}

function renderSetTabs(activeSet: GameSet) {
  return `
    <div class="section-toolbar">
      <nav class="set-tabs" aria-label="Game sets">
        ${gameSets
          .map(
            (set) => `
              <button class="${set.id === activeSet.id ? "active" : ""}" data-set-id="${set.id}" type="button">
                ${set.name}
              </button>
            `,
          )
          .join("")}
      </nav>
    </div>
  `;
}

function canViewPredictionMatrix() {
  return isAdminEmail(state.email);
}

function predictionMatrixPayload() {
  if (state.activeView === "predictionMatrix" && !state.leaderboardLoaded && !state.leaderboardLoading) {
    queueMicrotask(fetchLeaderboard);
  }

  return state.predictionMatrix;
}

function renderLeaderboard() {
  if (state.activeView === "leaderboard" && !state.leaderboardLoaded && !state.leaderboardLoading) {
    queueMicrotask(fetchLeaderboard);
  }

  const leaderRows = state.leaderboard
    .map(
      (entry, index) => `
        <tr class="${entry.email === state.email ? "current-user" : ""}">
          <td class="rank-cell">${index + 1}</td>
          <td>
            <strong>${entry.name}</strong>
            <span>${entry.email}</span>
          </td>
          <td>${entry.points}</td>
          <td>${entry.exactScores}</td>
          <td>${entry.outcomes}</td>
        </tr>
      `,
    )
    .join("");

  return `
    <section class="leaderboard-summary">
      <div>
        <span class="summary-value">${state.resultsCount}</span>
        <span class="summary-label">Games played</span>
      </div>
      <div>
        <span class="summary-value">${state.leaderboard.length}</span>
        <span class="summary-label">Players</span>
      </div>
    </section>

    ${state.leaderboardLoading ? `<p class="status">Loading leaderboard</p>` : ""}

    <section class="leaderboard-table-wrap" aria-label="Leaderboard standings">
      <table class="leaderboard-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Name</th>
            <th>Points</th>
            <th>Exact scores</th>
            <th>Outcomes</th>
          </tr>
        </thead>
        <tbody>
          ${leaderRows || `<tr><td colspan="5">No leaderboard entries yet.</td></tr>`}
        </tbody>
      </table>
    </section>
  `;
}

function scorePartClass(predictedScore: number, finalScore: number) {
  return predictedScore === finalScore ? "score-correct" : "score-wrong";
}

function predictionOutcomeClass(
  prediction: { homeScore: number; awayScore: number } | undefined,
  result: GameResult | undefined,
) {
  if (!prediction || !result) {
    return "";
  }

  return scoreOutcome(prediction.homeScore, prediction.awayScore) === scoreOutcome(result.homeScore, result.awayScore)
    ? "outcome-correct"
    : "outcome-wrong";
}

function renderPredictionCell(
  game: Game,
  result: GameResult | undefined,
  predictionsByEmail: PredictionsByEmail,
  participant: Participant,
  revealPicks: boolean,
) {
  const prediction = predictionsByEmail[participant.email]?.[game.id];

  if (!revealPicks) {
    return `<td class="prediction-matrix-cell pending">TBD</td>`;
  }

  if (!prediction) {
    return `<td class="prediction-matrix-cell empty">-</td>`;
  }

  if (isKnockoutGame(game)) {
    return `
      <td class="prediction-matrix-cell ${knockoutOutcomeClass(game, prediction, result)}">
        <span class="knockout-pick-cell">
          <strong>${teamNameForId(game, prediction.winningTeamId) || "TBD"}</strong>
          <span>${prediction.selectedTeamScore ?? "-"} · ${
            prediction.endingPhase ? endingPhaseLabels[prediction.endingPhase] : "TBD"
          }</span>
        </span>
      </td>
    `;
  }

  const homeClass = result ? scorePartClass(prediction.homeScore, result.homeScore) : "";
  const awayClass = result ? scorePartClass(prediction.awayScore, result.awayScore) : "";

  return `
    <td class="prediction-matrix-cell ${predictionOutcomeClass(prediction, result)}">
      <span class="score-box-pair">
        <span class="score-box ${homeClass}">${prediction.homeScore}</span>
        <span class="score-separator">-</span>
        <span class="score-box ${awayClass}">${prediction.awayScore}</span>
      </span>
    </td>
  `;
}

function renderPredictionMatrix(activeSet: GameSet) {
  const matrix = predictionMatrixPayload();
  const matrixParticipants = matrix?.participants ?? [];
  const predictionsByEmail = matrix?.predictionsByEmail ?? {};
  const games = activeSet.games;
  const revealPicks = sectionIsClosed(activeSet);

  return `
    <div class="prediction-matrix-view">
      ${renderSetTabs(activeSet)}

      <section class="leaderboard-summary">
        <div>
          <span class="summary-value">${games.length}</span>
          <span class="summary-label">Games</span>
        </div>
        <div>
          <span class="summary-value">${matrixParticipants.length}</span>
          <span class="summary-label">Players</span>
        </div>
        <p>${
          revealPicks
            ? "Scores show exact-goal correctness; cells show outcome correctness after a final result is posted."
            : "Picks for this set are hidden until predictions lock."
        }</p>
      </section>

      ${state.leaderboardLoading ? `<p class="status">Loading picks</p>` : ""}

      <section class="prediction-matrix-wrap" aria-label="${activeSet.name} predictions by player">
        <table class="prediction-matrix-table">
          <thead>
            <tr>
              <th class="game-column">Game</th>
              <th>Final</th>
              ${matrixParticipants.map((participant) => `<th>${participant.name}<span>${participant.email}</span></th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${
              matrix
                ? games
                    .map((game) => {
                      const result = resultForGame(game.id);
                      return `
                        <tr>
                          <th scope="row" class="game-column">
                            <span>Match ${game.matchNumber}</span>
                            <strong>${game.homeTeam} vs ${game.awayTeam}</strong>
                          </th>
                          <td class="final-matrix-cell">${result ? `${result.homeScore}-${result.awayScore}` : "TBD"}</td>
                          ${matrixParticipants
                            .map((participant) =>
                              renderPredictionCell(game, result, predictionsByEmail, participant, revealPicks),
                            )
                            .join("")}
                        </tr>
                      `;
                    })
                    .join("")
                : `<tr><td colspan="${Math.max(2, matrixParticipants.length + 2)}">No picks loaded yet.</td></tr>`
            }
          </tbody>
        </table>
      </section>
    </div>
    <p class="status mobile-picks-status">Picks are available on larger screens.</p>
  `;
}

function renderDashboard() {
  if (!canViewPredictionMatrix() && state.activeView === "predictionMatrix") {
    state.activeView = "predictions";
  }

  const activeSet = gameSets.find((set) => set.id === state.activeSetId) ?? gameSets[0];
  const activeDeadline = activeSet ? nextPredictionDeadline(activeSet) : null;
  const activeSetClosed = activeSet ? sectionIsClosed(activeSet) : false;
  const activeSavedCount = activeSet ? completedCount(activeSet.games) : 0;
  const activeGamesCount = activeSet?.games.length ?? 0;
  const jumpTargetGame = activeSet && activeSetClosed ? jumpTargetForSet(activeSet) : null;
  const progress = activeGamesCount > 0 ? Math.round((activeSavedCount / activeGamesCount) * 100) : 0;

  app!.innerHTML = `
    <main class="app-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">WC26 Pool</p>
          <h1>${
            state.activeView === "leaderboard"
              ? "Leaderboard"
              : state.activeView === "predictionMatrix"
                ? "Picks"
                : "Predictions"
          }</h1>
        </div>
        <div class="account">
          <span>${state.email}</span>
          <button id="logout" type="button">Log Out</button>
        </div>
      </header>

      ${renderViewTabs()}

      ${state.message ? `<p class="status">${state.message}</p>` : ""}

      ${
        state.activeView === "leaderboard"
          ? renderLeaderboard()
          : state.activeView === "predictionMatrix"
            ? renderPredictionMatrix(activeSet)
            : `
      ${renderSetTabs(activeSet)}

      <section class="summary-band">
        <div>
          <span class="summary-value">${activeSavedCount}</span>
          <span class="summary-label">Saved</span>
        </div>
        <div>
          <span class="summary-value">${activeGamesCount}</span>
          <span class="summary-label">Games</span>
        </div>
        <div class="progress-track" aria-label="${progress}% complete">
          <span style="width: ${progress}%"></span>
        </div>
        <div class="deadline-band ${activeSetClosed ? "closed" : ""}">
          <span>${activeSetClosed ? "Closed" : "Due"}</span>
          <strong>${activeDeadline ? formatDeadline(activeDeadline) : "TBD"}</strong>
        </div>
        ${
          jumpTargetGame
            ? `<button id="jump-current-game" class="jump-current-button" type="button">Jump to Current Game</button>`
            : ""
        }
      </section>

      ${state.loading ? `<p class="status">Loading</p>` : ""}

      <div class="matches-separator" aria-hidden="true"></div>
      <section class="matches-scroll" aria-label="${activeSet.name}">
        <div class="games-list">
          ${activeSet.games.map(renderGame).join("")}
        </div>
      </section>
    `
      }
    </main>
  `;

  document.querySelector<HTMLButtonElement>("#logout")?.addEventListener("click", logout);
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextView = (button.dataset.view as ActiveView | undefined) ?? state.activeView;
      state.activeView = nextView === "predictionMatrix" && !canViewPredictionMatrix() ? "predictions" : nextView;
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-set-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextSet = gameSets.find((set) => set.id === button.dataset.setId);
      state.activeSetId = nextSet?.id ?? state.activeSetId;
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-game-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const game = gameSets.flatMap((set) => set.games).find((item) => item.id === button.dataset.gameId);
      if (game) {
        savePrediction(game);
      }
    });
  });
  document.querySelector<HTMLButtonElement>("#jump-current-game")?.addEventListener("click", () => {
    if (jumpTargetGame) {
      jumpToGame(jumpTargetGame.id);
    }
  });
  activeSet.games.forEach((game) => {
    if (isKnockoutGame(game)) {
      document.querySelectorAll<HTMLButtonElement>(`[data-winner-game-id="${game.id}"][data-winner-team-id]`).forEach((button) => {
        button.addEventListener("click", () => {
          const winnerInput = document.querySelector<HTMLInputElement>(`#${game.id}-winner`);
          if (winnerInput) {
            winnerInput.value = button.dataset.winnerTeamId ?? "";
          }
          document
            .querySelectorAll<HTMLButtonElement>(`[data-winner-game-id="${game.id}"][data-winner-team-id]`)
            .forEach((winnerButton) => {
              winnerButton.classList.toggle("selected", winnerButton === button);
            });
          updatePredictedOutcome(game);
        });
      });
      document.querySelector<HTMLInputElement>(`#${game.id}-selected-score`)?.addEventListener("input", () => {
        updatePredictedOutcome(game);
      });
      document.querySelectorAll<HTMLInputElement>(`input[name="${game.id}-ending-phase"]`).forEach((radio) => {
        radio.addEventListener("change", () => {
          updatePredictedOutcome(game);
        });
      });
      return;
    }

    document.querySelector<HTMLInputElement>(`#${game.id}-home`)?.addEventListener("input", () => {
      updatePredictedOutcome(game);
    });
    document.querySelector<HTMLInputElement>(`#${game.id}-away`)?.addEventListener("input", () => {
      updatePredictedOutcome(game);
    });
  });
}

function render() {
  if (!app) {
    return;
  }

  if (!canUseStoredCredentials() || !canUseEmailLocally(state.email ?? "")) {
    renderLogin();
    return;
  }

  renderDashboard();
}

render();

function refreshScores() {
  if (canUseStoredCredentials() && canUseEmailLocally(state.email ?? "")) {
    fetchPredictions(state.email!, { silent: true });
  }
}

function scheduleScoreRefresh() {
  window.setTimeout(() => {
    refreshScores();
    scheduleScoreRefresh();
  }, nextScoreRefreshMs());
}

if (canUseStoredCredentials() && canUseEmailLocally(state.email ?? "")) {
  fetchPredictions(state.email!);
}

scheduleScoreRefresh();
