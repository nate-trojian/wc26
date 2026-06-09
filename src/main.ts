import "./styles.css";
import { isAllowedEmail, normalizeEmail } from "./config/allowedEmails.js";
import { participants } from "./config/participants.js";
import { gameSets } from "./data/games.js";
import { matchResults } from "./data/results.js";
import { teamEspnLinks } from "./data/teamLinks.js";
import { buildLeaderboard } from "./scoring.js";
import type { Game, GameResult, GameSet, LeaderboardEntry, PredictionsByGame } from "./types.js";

const emailStorageKey = "wc26-email";
const localPredictionsStoragePrefix = "wc26-local-predictions";
const app = document.querySelector<HTMLDivElement>("#app");
const validateEmailsLocally = import.meta.env.DEV;

type ActiveView = "predictions" | "leaderboard";

type AppState = {
  email: string | null;
  predictions: PredictionsByGame;
  leaderboard: LeaderboardEntry[];
  leaderboardLoaded: boolean;
  resultsCount: number;
  activeSetId: string;
  activeView: ActiveView;
  loading: boolean;
  leaderboardLoading: boolean;
  message: string;
};

const state: AppState = {
  email: localStorage.getItem(emailStorageKey),
  predictions: {},
  leaderboard: [],
  leaderboardLoaded: false,
  resultsCount: matchResults.length,
  activeSetId: gameSets[0]?.id ?? "first",
  activeView: "predictions",
  loading: false,
  leaderboardLoading: false,
  message: "",
};

function parseGameDate(value: string) {
  const normalized = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  return new Date(normalized);
}

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

function sectionDeadline(set: GameSet) {
  const firstGame = set.games[0];
  if (!firstGame) {
    return null;
  }

  const firstGameDate = parseGameDate(firstGame.dateTime);
  if (Number.isNaN(firstGameDate.getTime())) {
    return null;
  }

  return new Date(firstGameDate.getTime() - 30 * 60 * 1000);
}

function gameSetForGame(game: Game) {
  return gameSets.find((set) => set.games.some((item) => item.id === game.id));
}

function resultForGame(gameId: string): GameResult | undefined {
  return matchResults.find((result) => result.gameId === gameId);
}

function scoreOutcome(homeScore: number, awayScore: number) {
  return Math.sign(homeScore - awayScore);
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

function pointsEarned(
  prediction: { homeScore: number; awayScore: number } | undefined,
  result: GameResult | undefined,
) {
  if (!prediction || !result) {
    return 0;
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
  const deadline = sectionDeadline(set);
  return deadline ? Date.now() >= deadline.getTime() : false;
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

function runningStandaloneViteDev() {
  return import.meta.env.DEV;
}

function canUseEmailLocally(email: string) {
  return !validateEmailsLocally || isAllowedEmail(email);
}

function rejectStoredEmail(message: string) {
  localStorage.removeItem(emailStorageKey);
  state.email = null;
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

async function fetchPredictions(email: string) {
  if (runningStandaloneViteDev()) {
    state.predictions = loadLocalPredictions(email);
    state.message = "";
    render();
    return;
  }

  state.loading = true;
  render();

  try {
    const response = await fetch(`/api/predictions?email=${encodeURIComponent(email)}`);
    const payload = await readJsonResponse(response);

    if (!response.ok) {
      if (response.status === 403) {
        rejectStoredEmail(payload.error ?? "This email is not on the allowed list.");
      }
      throw new Error(payload.error ?? "Could not load predictions.");
    }

    state.predictions = payload.predictions ?? {};
    state.message = "";
  } catch (error) {
    if (state.email) {
      state.message = error instanceof Error ? error.message : "Could not load predictions.";
    }
  } finally {
    state.loading = false;
    render();
  }
}

async function fetchLeaderboard() {
  if (!state.email) {
    return;
  }

  if (runningStandaloneViteDev()) {
    state.leaderboard = buildLeaderboard(participants, loadAllLocalPredictions(), matchResults);
    state.resultsCount = matchResults.length;
    state.leaderboardLoaded = true;
    render();
    return;
  }

  state.leaderboardLoading = true;
  render();

  try {
    const response = await fetch(`/api/leaderboard?email=${encodeURIComponent(state.email)}`);
    const payload = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(payload.error ?? "Could not load leaderboard.");
    }

    state.leaderboard = payload.leaderboard ?? [];
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

  if (gameSet && sectionIsClosed(gameSet)) {
    const deadline = sectionDeadline(gameSet);
    setMessage(`${gameSet.name} closed ${deadline ? formatDeadline(deadline) : "before kickoff"}.`, game.id, anchorTop);
    return;
  }

  const homeInput = document.querySelector<HTMLInputElement>(`#${game.id}-home`);
  const awayInput = document.querySelector<HTMLInputElement>(`#${game.id}-away`);
  const homeScore = Number(homeInput?.value);
  const awayScore = Number(awayInput?.value);

  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) {
    setMessage("Use whole-number scores.", game.id, anchorTop);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: state.email,
        prediction: {
          gameId: game.id,
          homeScore,
          awayScore,
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

function login(email: string) {
  const normalized = normalizeEmail(email);

  if (!canUseEmailLocally(normalized)) {
    state.message = "This email is not on the allowed list.";
    render();
    return;
  }

  localStorage.setItem(emailStorageKey, normalized);
  state.email = normalized;
  state.activeView = "predictions";
  state.leaderboardLoaded = false;
  fetchPredictions(normalized);
}

function logout() {
  localStorage.removeItem(emailStorageKey);
  state.email = null;
  state.predictions = {};
  state.leaderboard = [];
  state.leaderboardLoaded = false;
  state.resultsCount = matchResults.length;
  state.activeView = "predictions";
  state.message = "";
  render();
}

function renderLogin() {
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
        </form>
        ${state.message ? `<p class="status error">${state.message}</p>` : ""}
      </section>
    </main>
  `;

  document.querySelector<HTMLFormElement>("#login-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    login(String(form.get("email") ?? ""));
  });
}

function renderGame(game: Game) {
  const prediction = state.predictions[game.id];
  const gameSet = gameSetForGame(game);
  const result = resultForGame(game.id);
  const isFinal = Boolean(result);
  const closed = isFinal || (gameSet ? sectionIsClosed(gameSet) : false);
  const homeValue = prediction?.homeScore ?? "";
  const awayValue = prediction?.awayScore ?? "";
  const homeResultClass =
    result && prediction ? (prediction.homeScore === result.homeScore ? "score-correct" : "score-wrong") : "";
  const awayResultClass =
    result && prediction ? (prediction.awayScore === result.awayScore ? "score-correct" : "score-wrong") : "";
  const predictedOutcome = prediction ? outcomeLabel(game, prediction.homeScore, prediction.awayScore) : "";
  const outcomeResultClass =
    result && prediction
      ? scoreOutcome(prediction.homeScore, prediction.awayScore) === scoreOutcome(result.homeScore, result.awayScore)
        ? "outcome-correct"
        : "outcome-wrong"
      : "";
  const earnedPoints = pointsEarned(prediction, result);
  const savedLabel = prediction
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(prediction.updatedAt))
    : "";

  return `
    <article class="game-card ${isFinal ? "final" : ""}" data-game-card-id="${game.id}">
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
          : ""
      }
      <div class="prediction-grid">
        <div class="team-score">
          ${renderTeamLink(game.homeTeamId, game.homeTeam)}
          <input class="${homeResultClass}" id="${game.id}-home" inputmode="numeric" type="number" min="0" max="99" value="${homeValue}" aria-label="${game.homeTeam} score" ${closed ? "disabled" : ""} />
        </div>
        <span class="versus">vs</span>
        <div class="team-score">
          ${renderTeamLink(game.awayTeamId, game.awayTeam)}
          <input class="${awayResultClass}" id="${game.id}-away" inputmode="numeric" type="number" min="0" max="99" value="${awayValue}" aria-label="${game.awayTeam} score" ${closed ? "disabled" : ""} />
        </div>
      </div>
      <div id="${game.id}-outcome" class="predicted-outcome ${outcomeResultClass}">
        <span>Predicted outcome</span>
        <strong>${predictedOutcome || "Not predicted"}</strong>
      </div>
      ${
        result
          ? `<div class="points-earned">
              <span>Points earned</span>
              <strong>${earnedPoints}/3</strong>
            </div>`
          : ""
      }
      <div class="game-actions">
        <span>${isFinal ? "Final score posted" : savedLabel ? `Saved ${savedLabel}` : "Not saved"}</span>
        <button class="save-button" data-game-id="${game.id}" type="button" ${closed ? "disabled" : ""}>
          ${isFinal ? "Locked" : "Save"}
        </button>
      </div>
    </article>
  `;
}

function updatePredictedOutcome(game: Game) {
  const homeScore = inputScore(document.querySelector<HTMLInputElement>(`#${game.id}-home`));
  const awayScore = inputScore(document.querySelector<HTMLInputElement>(`#${game.id}-away`));
  const outcome = document.querySelector<HTMLDivElement>(`#${game.id}-outcome`);
  const outcomeValue = outcome?.querySelector("strong");

  if (!outcome || !outcomeValue) {
    return;
  }

  outcome.classList.remove("outcome-correct", "outcome-wrong");

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
    </nav>
  `;
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

function renderDashboard() {
  const activeSet = gameSets.find((set) => set.id === state.activeSetId) ?? gameSets[0];
  const activeDeadline = activeSet ? sectionDeadline(activeSet) : null;
  const activeSetClosed = activeSet ? sectionIsClosed(activeSet) : false;
  const activeSavedCount = activeSet ? completedCount(activeSet.games) : 0;
  const activeGamesCount = activeSet?.games.length ?? 0;
  const progress = activeGamesCount > 0 ? Math.round((activeSavedCount / activeGamesCount) * 100) : 0;

  app!.innerHTML = `
    <main class="app-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">WC26 Pool</p>
          <h1>${state.activeView === "leaderboard" ? "Leaderboard" : "Predictions"}</h1>
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
          : `
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
      state.activeView = (button.dataset.view as ActiveView | undefined) ?? state.activeView;
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-set-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeSetId = button.dataset.setId ?? state.activeSetId;
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
  activeSet.games.forEach((game) => {
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

  if (!state.email || !canUseEmailLocally(state.email)) {
    renderLogin();
    return;
  }

  renderDashboard();
}

render();

if (state.email && canUseEmailLocally(state.email)) {
  fetchPredictions(state.email);
}
