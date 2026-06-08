import "./styles.css";
import { isAllowedEmail, normalizeEmail } from "./config/allowedEmails";
import { participants } from "./config/participants";
import { gameSets, totalGames } from "./data/games";
import { matchResults } from "./data/results";
import { buildLeaderboard } from "./scoring";
import type { Game, GameSet, LeaderboardEntry, PredictionsByGame } from "./types";

const emailStorageKey = "wc26-email";
const localPredictionsStoragePrefix = "wc26-local-predictions";
const app = document.querySelector<HTMLDivElement>("#app");

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

function sectionIsClosed(set: GameSet) {
  const deadline = sectionDeadline(set);
  return deadline ? Date.now() >= deadline.getTime() : false;
}

function setMessage(message: string) {
  state.message = message;
  render();
}

function completedCount() {
  return Object.keys(state.predictions).length;
}

function runningStandaloneViteDev() {
  return import.meta.env.DEV;
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
      throw new Error(payload.error ?? "Could not load predictions.");
    }

    state.predictions = payload.predictions ?? {};
    state.message = "";
  } catch (error) {
    state.message = error instanceof Error ? error.message : "Could not load predictions.";
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

  const gameSet = gameSetForGame(game);
  if (gameSet && sectionIsClosed(gameSet)) {
    const deadline = sectionDeadline(gameSet);
    setMessage(`${gameSet.name} closed ${deadline ? formatDeadline(deadline) : "before kickoff"}.`);
    return;
  }

  const homeInput = document.querySelector<HTMLInputElement>(`#${game.id}-home`);
  const awayInput = document.querySelector<HTMLInputElement>(`#${game.id}-away`);
  const homeScore = Number(homeInput?.value);
  const awayScore = Number(awayInput?.value);

  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) {
    setMessage("Use whole-number scores.");
    return;
  }

  state.message = `Saving ${game.homeTeam} vs ${game.awayTeam}`;
  render();

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
    render();
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
    render();
  }
}

function login(email: string) {
  const normalized = normalizeEmail(email);

  if (!isAllowedEmail(normalized)) {
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
  const closed = gameSet ? sectionIsClosed(gameSet) : false;
  const homeValue = prediction?.homeScore ?? "";
  const awayValue = prediction?.awayScore ?? "";
  const savedLabel = prediction
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(prediction.updatedAt))
    : "";

  return `
    <article class="game-card">
      <div class="game-meta">
        <span>Match ${game.matchNumber}</span>
        <time>${formatGameTime(game.dateTime)}</time>
      </div>
      <div class="prediction-grid">
        <label class="team-score">
          <span>${game.homeTeam}</span>
          <input id="${game.id}-home" inputmode="numeric" type="number" min="0" max="99" value="${homeValue}" aria-label="${game.homeTeam} score" ${closed ? "disabled" : ""} />
        </label>
        <span class="versus">vs</span>
        <label class="team-score">
          <span>${game.awayTeam}</span>
          <input id="${game.id}-away" inputmode="numeric" type="number" min="0" max="99" value="${awayValue}" aria-label="${game.awayTeam} score" ${closed ? "disabled" : ""} />
        </label>
      </div>
      <div class="game-actions">
        <span>${savedLabel ? `Saved ${savedLabel}` : "Not saved"}</span>
        <button class="save-button" data-game-id="${game.id}" type="button" ${closed ? "disabled" : ""}>Save</button>
      </div>
    </article>
  `;
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
          <td>${entry.predictedGames}</td>
        </tr>
      `,
    )
    .join("");

  return `
    <section class="leaderboard-summary">
      <div>
        <span class="summary-value">${state.resultsCount}</span>
        <span class="summary-label">Finals</span>
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
            <th>Scores</th>
            <th>Outcomes</th>
            <th>Games</th>
          </tr>
        </thead>
        <tbody>
          ${leaderRows || `<tr><td colspan="6">No leaderboard entries yet.</td></tr>`}
        </tbody>
      </table>
    </section>
  `;
}

function renderDashboard() {
  const activeSet = gameSets.find((set) => set.id === state.activeSetId) ?? gameSets[0];
  const activeDeadline = activeSet ? sectionDeadline(activeSet) : null;
  const activeSetClosed = activeSet ? sectionIsClosed(activeSet) : false;
  const progress = Math.round((completedCount() / totalGames) * 100);

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

      <section class="summary-band">
        <div>
          <span class="summary-value">${completedCount()}</span>
          <span class="summary-label">Saved</span>
        </div>
        <div>
          <span class="summary-value">${totalGames}</span>
          <span class="summary-label">Games</span>
        </div>
        <div class="progress-track" aria-label="${progress}% complete">
          <span style="width: ${progress}%"></span>
        </div>
      </section>

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

        <section class="deadline-band ${activeSetClosed ? "closed" : ""}">
          <span>${activeSetClosed ? "Closed" : "Due"}</span>
          <strong>${activeDeadline ? formatDeadline(activeDeadline) : "TBD"}</strong>
        </section>
      </div>

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
}

function render() {
  if (!app) {
    return;
  }

  if (!state.email || !isAllowedEmail(state.email)) {
    renderLogin();
    return;
  }

  renderDashboard();
}

render();

if (state.email && isAllowedEmail(state.email)) {
  fetchPredictions(state.email);
}
