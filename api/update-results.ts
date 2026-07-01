import type { VercelRequest, VercelResponse } from "@vercel/node";
import { espnEventIds } from "../src/data/espnEvents.js";
import { gameSets } from "../src/data/games.js";
import type {
  EndingPhase,
  Game,
  GameResult,
  MatchStatus,
  MatchStatusState,
} from "../src/types.js";
import { readMatchStatuses, saveMatchStatuses } from "./matchStatusStore.js";
import {
  readResults,
  resultStorageErrorMessage,
  saveResults,
} from "./resultStore.js";

type EspnCompetitor = {
  id: string;
  homeAway: "home" | "away";
  score: string;
  winner?: boolean;
  team: {
    id: string;
    abbreviation?: string;
    displayName: string;
    shortDisplayName?: string;
  };
};

type EspnCompetition = {
  id: string;
  date: string;
  status: {
    displayClock?: string;
    type: {
      name: string;
      state: string;
      completed: boolean;
    };
  };
  competitors: EspnCompetitor[];
};

type EspnEvent = {
  id: string;
  date: string;
  name: string;
  competitions: EspnCompetition[];
};

type EspnScoreboardResponse = {
  events?: EspnEvent[];
};

const defaultProbeLimit = 3;
const defaultProbeUnknownGameDays = 14;
const livePollBeforeMinutes = 15;
const livePollAfterMinutes = 180;

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
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
  const queryToken =
    typeof request.query.secret === "string" ? request.query.secret : "";
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

function espnDateKey(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${values.year}${values.month}${values.day}`;
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

function allKnownGames() {
  return gameSets.flatMap((set) => set.games);
}

function liveGames(now: Date, existingResults: readonly GameResult[]) {
  const existingGameIds = new Set(
    existingResults.map((result) => result.gameId),
  );
  const livePollAfterMs = livePollAfterMinutes * 60 * 1000;

  return allKnownGames().filter((game) => {
    if (existingGameIds.has(game.id)) {
      return false;
    }

    const kickoff = parseGameDate(game.dateTime);
    if (Number.isNaN(kickoff.getTime())) {
      return false;
    }

    const elapsedMs = now.getTime() - kickoff.getTime();
    return elapsedMs <= livePollAfterMs;
  });
}

function probeGames(
  now: Date,
  existingResults: readonly GameResult[],
  limit: number,
) {
  const existingGameIds = new Set(
    existingResults.map((result) => result.gameId),
  );

  return allKnownGames()
    .filter((game) => {
      if (existingGameIds.has(game.id)) {
        return false;
      }

      const kickoff = parseGameDate(game.dateTime);
      return (
        !Number.isNaN(kickoff.getTime()) && kickoff.getTime() >= now.getTime()
      );
    })
    .sort(
      (left, right) =>
        parseGameDate(left.dateTime).getTime() -
        parseGameDate(right.dateTime).getTime(),
    )
    .slice(0, limit);
}

function competitorsForEvent(event: EspnEvent) {
  const competition = event.competitions[0];
  const home = competition?.competitors.find(
    (competitor) => competitor.homeAway === "home",
  );
  const away = competition?.competitors.find(
    (competitor) => competitor.homeAway === "away",
  );

  return { competition, home, away };
}

function eventTeamNames(event: EspnEvent) {
  const { home, away } = competitorsForEvent(event);
  return [home?.team.displayName, away?.team.displayName].filter(
    (teamName): teamName is string => Boolean(teamName),
  );
}

function isStoredFixtureEvent(
  event: EspnEvent,
  games: readonly Game[],
  timeZone: string,
) {
  if (new Set(Object.values(espnEventIds)).has(event.id)) {
    return true;
  }

  const { home, away } = competitorsForEvent(event);
  if (!home || !away) {
    return false;
  }

  const eventKickoff = parseGameDate(event.competitions[0]?.date ?? event.date);
  if (Number.isNaN(eventKickoff.getTime())) {
    return false;
  }

  const eventDateKey = espnDateKey(eventKickoff, timeZone);
  return games.some((game) => {
    const gameKickoff = parseGameDate(game.dateTime);
    if (
      Number.isNaN(gameKickoff.getTime()) ||
      espnDateKey(gameKickoff, timeZone) !== eventDateKey
    ) {
      return false;
    }

    return (
      (sameTeam(game.homeTeam, home.team.displayName) &&
        sameTeam(game.awayTeam, away.team.displayName)) ||
      (sameTeam(game.homeTeam, away.team.displayName) &&
        sameTeam(game.awayTeam, home.team.displayName))
    );
  });
}

function summarizeOtherTeamMatch(
  event: EspnEvent,
  knownTeamNames: ReadonlySet<string>,
) {
  return {
    ...summarizeEvent(event),
    matchedTeams: eventTeamNames(event).filter((teamName) =>
      knownTeamNames.has(normalizeTeamName(teamName)),
    ),
  };
}

function findEventForGame(game: Game, events: readonly EspnEvent[]) {
  const eventId = espnEventIds[game.id];
  if (eventId !== undefined) {
    return events.find((event) => event.id === eventId);
  }

  return events.find((event) => {
    const { home, away } = competitorsForEvent(event);
    return Boolean(
      home &&
      away &&
      sameTeam(game.homeTeam, home.team.displayName) &&
      sameTeam(game.awayTeam, away.team.displayName),
    );
  });
}

function summarizeEvent(event: EspnEvent) {
  const { competition, home, away } = competitorsForEvent(event);

  return {
    eventId: event.id,
    name: event.name,
    homeTeamId: home?.team.id ?? null,
    homeTeam: home?.team.displayName ?? null,
    homeAbbreviation: home?.team.abbreviation ?? null,
    awayTeamId: away?.team.id ?? null,
    awayTeam: away?.team.displayName ?? null,
    awayAbbreviation: away?.team.abbreviation ?? null,
    kickoff: competition?.date ?? event.date,
    status: competition?.status.type.name ?? null,
    completed: competition?.status.type.completed ?? false,
    homeScore: home ? Number(home.score) : null,
    awayScore: away ? Number(away.score) : null,
  };
}

function resultFromEvent(game: Game, event: EspnEvent): GameResult | null {
  const { competition, home, away } = competitorsForEvent(event);
  const homeScore = Number(home?.score);
  const awayScore = Number(away?.score);

  if (
    !competition?.status.type.completed ||
    !Number.isInteger(homeScore) ||
    !Number.isInteger(awayScore)
  ) {
    return null;
  }

  const endingPhase = endingPhaseFromStatus(competition.status.type.name);

  return {
    gameId: game.id,
    homeScore,
    awayScore,
    winningTeamId: home?.winner
      ? game.homeTeamId
      : away?.winner
        ? game.awayTeamId
        : homeScore > awayScore
          ? game.homeTeamId
          : awayScore > homeScore
            ? game.awayTeamId
            : undefined,
    ...(endingPhase ? { endingPhase } : {}),
  };
}

function endingPhaseFromStatus(
  statusName: string | null | undefined,
): EndingPhase | undefined {
  const normalized = (statusName ?? "").toLowerCase();
  if (normalized === "full_time" || normalized === "status_full_time") {
    return "regular";
  }

  if (normalized.includes("pen") || normalized.includes("shootout")) {
    return "pks";
  }

  if (normalized.includes("extra")) {
    return "extra";
  }

  if (normalized.includes("regular")) {
    return "regular";
  }

  return undefined;
}

function statusStateFromEvent(event: EspnEvent): MatchStatusState {
  const state = event.competitions[0]?.status.type.state;
  return state === "in" || state === "post" ? state : "pre";
}

function readableStatusName(statusName: string | null | undefined) {
  const statusLabels: Record<string, string> = {
    STATUS_IN_PROGRESS: "Live",
    STATUS_FIRST_HALF: "1H",
    STATUS_HALFTIME: "HT",
    STATUS_SECOND_HALF: "2H",
    STATUS_FULL_TIME: "FT",
    STATUS_FINAL: "Final",
    STATUS_SCHEDULED: "Scheduled",
    STATUS_HALFTIME_ET: "HT ET",
    STATUS_FIRST_HALF_ET: "1H ET",
    STATUS_SECOND_HALF_ET: "2H ET",
    STATUS_SHOOTOUT: "PEN",
    STATUS_OVERTIME: "ET",
    STATUS_FINAL_PEN: "FT PEN",
    STATUS_END_OF_EXTRATIME: "PEN",
  };

  return statusName ? (statusLabels[statusName] ?? statusName) : "Unknown";
}

function matchStatusFromEvent(
  game: Game,
  event: EspnEvent,
  lastUpdatedAt: string,
): MatchStatus {
  const { competition, home, away } = competitorsForEvent(event);
  const homeScore = Number(home?.score);
  const awayScore = Number(away?.score);

  return {
    gameId: game.id,
    state: statusStateFromEvent(event),
    statusName: readableStatusName(competition?.status.type.name),
    displayClock: competition?.status.displayClock,
    completed: competition?.status.type.completed ?? false,
    homeScore: Number.isInteger(homeScore) ? homeScore : null,
    awayScore: Number.isInteger(awayScore) ? awayScore : null,
    lastUpdatedAt,
    providerEventId: event.id,
  };
}

function dateKeysForGames(games: readonly Game[], timeZone: string) {
  return Array.from(
    new Set(
      games.map((game) => espnDateKey(parseGameDate(game.dateTime), timeZone)),
    ),
  );
}

function probeDateKeys(now: Date, games: readonly Game[], timeZone: string) {
  const dates = new Set(dateKeysForGames(games, timeZone));
  for (let offset = 0; offset < defaultProbeUnknownGameDays; offset += 1) {
    const date = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    dates.add(espnDateKey(date, timeZone));
  }

  return Array.from(dates).sort();
}

async function fetchEventsForDateKeys(dates: readonly string[]) {
  const host = process.env.ESPN_SCOREBOARD_HOST ?? "site.api.espn.com";
  const responses = await Promise.all(
    dates.map(async (date) => {
      const url = new URL(
        `https://${host}/apis/site/v2/sports/soccer/fifa.world/scoreboard`,
      );
      url.searchParams.set("dates", date);

      const espnResponse = await fetch(url);
      const payload = (await espnResponse.json()) as EspnScoreboardResponse;

      if (!espnResponse.ok) {
        throw new Error(
          `ESPN scoreboard request failed with ${espnResponse.status}.`,
        );
      }

      if (!Array.isArray(payload.events)) {
        throw new Error("ESPN scoreboard response did not include events.");
      }

      return payload.events;
    }),
  );

  return responses.flat();
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
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
    const lastUpdatedAt = now.toISOString();
    const probe = request.query.probe === "true";
    const includeUnknownGames = request.query.includeUnknownGames === "true";
    const probeLimit =
      typeof request.query.limit === "string"
        ? Math.max(
            1,
            Math.min(
              24,
              Number.parseInt(request.query.limit, 10) || defaultProbeLimit,
            ),
          )
        : defaultProbeLimit;
    const games = probe
      ? probeGames(now, existingResults, probeLimit)
      : liveGames(now, existingResults);
    if (!probe && games.length === 0) {
      return response.status(200).json({
        probe,
        checked: 0,
        saved: 0,
        resultsCount: existingResults.length,
      });
    }

    const timezone = process.env.ESPN_TIMEZONE ?? "America/New_York";
    const dateKeys =
      probe && includeUnknownGames
        ? probeDateKeys(now, games, timezone)
        : dateKeysForGames(games, timezone);
    const events = await fetchEventsForDateKeys(dateKeys);
    if (probe) {
      const knownGames = allKnownGames();
      const knownTeamNames = new Set(
        knownGames.flatMap((game) => [
          normalizeTeamName(game.homeTeam),
          normalizeTeamName(game.awayTeam),
        ]),
      );
      const otherTeamMatches = includeUnknownGames
        ? events
            .filter((event) => {
              const matchesKnownTeam = eventTeamNames(event).some((teamName) =>
                knownTeamNames.has(normalizeTeamName(teamName)),
              );

              return (
                matchesKnownTeam &&
                !isStoredFixtureEvent(event, knownGames, timezone)
              );
            })
            .map((event) => summarizeOtherTeamMatch(event, knownTeamNames))
        : undefined;

      return response.status(200).json({
        probe: true,
        includeUnknownGames,
        checked: games.length,
        dateKeys,
        saved: 0,
        resultsCount: existingResults.length,
        candidateEvents: events.map(summarizeEvent),
        ...(otherTeamMatches ? { otherTeamMatches } : {}),
        fixtureChecks: games.map((game) => {
          const event = findEventForGame(game, events);

          return {
            gameId: game.id,
            matchNumber: game.matchNumber,
            expected: {
              homeTeam: game.homeTeam,
              awayTeam: game.awayTeam,
              kickoff: game.dateTime,
            },
            matched: Boolean(event),
            matchMethod:
              event && espnEventIds[game.id] !== undefined
                ? "eventId"
                : "teamName",
            provider: event ? summarizeEvent(event) : null,
          };
        }),
      });
    }

    const statusUpdates = games.flatMap((game) => {
      const event = findEventForGame(game, events);
      return event ? [matchStatusFromEvent(game, event, lastUpdatedAt)] : [];
    });

    if (statusUpdates.length > 0) {
      const existingStatuses = await readMatchStatuses();
      await saveMatchStatuses([...existingStatuses, ...statusUpdates]);
    }

    const newResults = games.flatMap((game) => {
      const event = findEventForGame(game, events);
      const result = event ? resultFromEvent(game, event) : null;
      return result ? [result] : [];
    });

    if (newResults.length > 0) {
      await saveResults([...existingResults, ...newResults]);
    }

    response.status(200).json({
      checked: games.length,
      statusesSaved: statusUpdates.length,
      saved: newResults.length,
      resultsCount: existingResults.length + newResults.length,
      savedGameIds: newResults.map((result) => result.gameId),
      unmatchedGameIds: games
        .filter(
          (game) => !newResults.some((result) => result.gameId === game.id),
        )
        .map((game) => game.id),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : resultStorageErrorMessage(error);
    sendError(response, 503, message);
  }
}
