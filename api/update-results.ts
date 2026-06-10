import type { VercelRequest, VercelResponse } from "@vercel/node";
import { gameSets } from "../src/data/games.js";
import type { Game, GameResult } from "../src/types.js";
import { readResults, resultStorageErrorMessage, saveResults } from "./resultStore.js";

type ApiFootballFixture = {
  fixture: {
    date: string;
    status: {
      short: string;
    };
  };
  teams: {
    home: {
      name: string;
    };
    away: {
      name: string;
    };
  };
  goals: {
    home: number | null;
    away: number | null;
  };
};

type ApiFootballResponse = {
  response?: ApiFootballFixture[];
  errors?: unknown;
};

const finalStatuses = new Set(["FT", "AET", "PEN"]);
const defaultPollDelayMinutes = 150;
const catchupWindowHours = 48;
const defaultProbeLimit = 3;

const teamAliases: Record<string, string> = {
  bosniaherzegovina: "bosniaandherzegovina",
  czechia: "czechrepublic",
  congodr: "drcongo",
  curacao: "curacao",
  ivorycoast: "cotedivoire",
  southkorea: "korearepublic",
  turkiye: "turkey",
  unitedstates: "usa",
};

function sendError(response: VercelResponse, status: number, message: string) {
  response.status(status).json({ error: message });
}

function accessTokenFromRequest(request: VercelRequest) {
  const authorization = request.headers.authorization;
  const bearerToken =
    typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const queryToken = typeof request.query.secret === "string" ? request.query.secret : "";
  return bearerToken || queryToken;
}

function isAuthorizedCronRequest(request: VercelRequest) {
  const cronSecret = process.env.CRON_SECRET;
  return Boolean(cronSecret) && accessTokenFromRequest(request) === cronSecret;
}

function parseGameDate(value: string) {
  const normalized = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  return new Date(normalized);
}

function dateKey(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeTeamName(value: string) {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");

  return teamAliases[normalized] ?? normalized;
}

function sameTeam(left: string, right: string) {
  return normalizeTeamName(left) === normalizeTeamName(right);
}

function dueGames(now: Date, existingResults: readonly GameResult[]) {
  const existingGameIds = new Set(existingResults.map((result) => result.gameId));
  const pollDelayMs = Number(process.env.RESULT_POLL_DELAY_MINUTES ?? defaultPollDelayMinutes) * 60 * 1000;
  const catchupWindowMs = catchupWindowHours * 60 * 60 * 1000;

  return gameSets
    .flatMap((set) => set.games)
    .filter((game) => {
      if (existingGameIds.has(game.id)) {
        return false;
      }

      const kickoff = parseGameDate(game.dateTime);
      if (Number.isNaN(kickoff.getTime())) {
        return false;
      }

      const elapsedMs = now.getTime() - kickoff.getTime();
      return elapsedMs >= pollDelayMs && elapsedMs <= catchupWindowMs;
    });
}

function probeGames(now: Date, existingResults: readonly GameResult[], limit: number) {
  const existingGameIds = new Set(existingResults.map((result) => result.gameId));

  return gameSets
    .flatMap((set) => set.games)
    .filter((game) => {
      if (existingGameIds.has(game.id)) {
        return false;
      }

      const kickoff = parseGameDate(game.dateTime);
      return !Number.isNaN(kickoff.getTime()) && kickoff.getTime() >= now.getTime();
    })
    .sort((left, right) => parseGameDate(left.dateTime).getTime() - parseGameDate(right.dateTime).getTime())
    .slice(0, limit);
}

function findFixtureForGame(game: Game, fixtures: readonly ApiFootballFixture[]) {
  return fixtures.find(
    (fixture) => sameTeam(game.homeTeam, fixture.teams.home.name) && sameTeam(game.awayTeam, fixture.teams.away.name),
  );
}

function resultFromFixture(game: Game, fixture: ApiFootballFixture): GameResult | null {
  const { home, away } = fixture.goals;
  if (!finalStatuses.has(fixture.fixture.status.short) || home === null || away === null) {
    return null;
  }

  return {
    gameId: game.id,
    homeScore: home,
    awayScore: away,
  };
}

async function fetchFixtures(games: readonly Game[]) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    throw new Error("API_FOOTBALL_KEY is not configured.");
  }

  const leagueId = process.env.API_FOOTBALL_LEAGUE_ID ?? "1";
  const season = process.env.API_FOOTBALL_SEASON ?? "2026";
  const timezone = process.env.API_FOOTBALL_TIMEZONE ?? "America/New_York";
  const host = process.env.API_FOOTBALL_HOST ?? "v3.football.api-sports.io";
  const kickoffDates = games.map((game) => parseGameDate(game.dateTime)).sort((left, right) => left.getTime() - right.getTime());
  const from = dateKey(kickoffDates[0], timezone);
  const to = dateKey(kickoffDates[kickoffDates.length - 1], timezone);
  const url = new URL(`https://${host}/fixtures`);

  url.searchParams.set("league", leagueId);
  url.searchParams.set("season", season);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("timezone", timezone);

  const apiResponse = await fetch(url, {
    headers: {
      "x-apisports-key": apiKey,
    },
  });
  const payload = (await apiResponse.json()) as ApiFootballResponse;

  if (!apiResponse.ok) {
    throw new Error(`API-Football request failed with ${apiResponse.status}.`);
  }

  if (!Array.isArray(payload.response)) {
    throw new Error("API-Football response did not include fixtures.");
  }

  return payload.response;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return sendError(response, 405, "Method not allowed.");
  }

  if (!isAuthorizedCronRequest(request)) {
    return sendError(response, 401, "Unauthorized.");
  }

  try {
    const existingResults = await readResults();
    const now = new Date();
    const probe = request.query.probe === "true";
    const probeLimit =
      typeof request.query.limit === "string"
        ? Math.max(1, Math.min(20, Number.parseInt(request.query.limit, 10) || defaultProbeLimit))
        : defaultProbeLimit;
    const games = probe ? probeGames(now, existingResults, probeLimit) : dueGames(now, existingResults);
    if (games.length === 0) {
      return response.status(200).json({ probe, checked: 0, saved: 0, resultsCount: existingResults.length });
    }

    const fixtures = await fetchFixtures(games);
    if (probe) {
      return response.status(200).json({
        probe: true,
        checked: games.length,
        saved: 0,
        resultsCount: existingResults.length,
        fixtureChecks: games.map((game) => {
          const fixture = findFixtureForGame(game, fixtures);

          return {
            gameId: game.id,
            matchNumber: game.matchNumber,
            expected: {
              homeTeam: game.homeTeam,
              awayTeam: game.awayTeam,
              kickoff: game.dateTime,
            },
            matched: Boolean(fixture),
            provider: fixture
              ? {
                  homeTeam: fixture.teams.home.name,
                  awayTeam: fixture.teams.away.name,
                  kickoff: fixture.fixture.date,
                  status: fixture.fixture.status.short,
                  homeScore: fixture.goals.home,
                  awayScore: fixture.goals.away,
                  final: finalStatuses.has(fixture.fixture.status.short),
                }
              : null,
          };
        }),
      });
    }

    const newResults = games.flatMap((game) => {
      const fixture = findFixtureForGame(game, fixtures);
      const result = fixture ? resultFromFixture(game, fixture) : null;
      return result ? [result] : [];
    });

    if (newResults.length > 0) {
      await saveResults([...existingResults, ...newResults]);
    }

    response.status(200).json({
      checked: games.length,
      saved: newResults.length,
      resultsCount: existingResults.length + newResults.length,
      savedGameIds: newResults.map((result) => result.gameId),
      unmatchedGameIds: games
        .filter((game) => !newResults.some((result) => result.gameId === game.id))
        .map((game) => game.id),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : resultStorageErrorMessage(error);
    sendError(response, 503, message);
  }
}
