import "./styles.css";
import { isAllowedEmail, normalizeEmail } from "./config/allowedEmails";
import { gameSets, totalGames } from "./data/games";
import type { Game, PredictionsByGame } from "./types";

const emailStorageKey = "wc26-email";
const app = document.querySelector<HTMLDivElement>("#app");

type AppState = {
  email: string | null;
  predictions: PredictionsByGame;
  activeSetId: string;
  loading: boolean;
  message: string;
};

const state: AppState = {
  email: localStorage.getItem(emailStorageKey),
  predictions: {},
  activeSetId: gameSets[0]?.id ?? "first",
  loading: false,
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

function setMessage(message: string) {
  state.message = message;
  render();
}

function completedCount() {
  return Object.keys(state.predictions).length;
}

function runningStandaloneViteDev() {
  return import.meta.env.DEV && window.location.port === "5173";
}

async function readJsonResponse(response: Response) {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Prediction API unavailable.");
  }

  return response.json();
}

async function fetchPredictions(email: string) {
  if (runningStandaloneViteDev()) {
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

async function savePrediction(game: Game) {
  if (!state.email) {
    return;
  }

  if (runningStandaloneViteDev()) {
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
    state.message = "Saved";
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
  fetchPredictions(normalized);
}

function logout() {
  localStorage.removeItem(emailStorageKey);
  state.email = null;
  state.predictions = {};
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
          <input id="${game.id}-home" inputmode="numeric" type="number" min="0" max="99" value="${homeValue}" aria-label="${game.homeTeam} score" />
        </label>
        <span class="versus">vs</span>
        <label class="team-score">
          <span>${game.awayTeam}</span>
          <input id="${game.id}-away" inputmode="numeric" type="number" min="0" max="99" value="${awayValue}" aria-label="${game.awayTeam} score" />
        </label>
      </div>
      <div class="game-actions">
        <span>${savedLabel ? `Saved ${savedLabel}` : "Not saved"}</span>
        <button class="save-button" data-game-id="${game.id}" type="button">Save</button>
      </div>
    </article>
  `;
}

function renderDashboard() {
  const activeSet = gameSets.find((set) => set.id === state.activeSetId) ?? gameSets[0];
  const progress = Math.round((completedCount() / totalGames) * 100);

  app!.innerHTML = `
    <main class="app-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">WC26 Pool</p>
          <h1>Predictions</h1>
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

      ${state.message ? `<p class="status">${state.message}</p>` : ""}
      ${state.loading ? `<p class="status">Loading</p>` : ""}

      <section class="games-list">
        ${activeSet.games.map(renderGame).join("")}
      </section>
    </main>
  `;

  document.querySelector<HTMLButtonElement>("#logout")?.addEventListener("click", logout);
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
