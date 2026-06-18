import type { VercelRequest, VercelResponse } from "@vercel/node";
import { normalizeEmail } from "../src/config/allowedEmails.js";
import { gameSets } from "../src/data/games.js";
import { allowlistStorageErrorMessage, isAuthorizedParticipant } from "./participantStore.js";
import { predictionStorageErrorMessage, readPredictions, savePredictions } from "./predictionStore.js";
import { matchStatusStorageErrorMessage, readMatchStatuses } from "./matchStatusStore.js";
import { readResults, resultStorageErrorMessage } from "./resultStore.js";

type PredictionInput = {
  gameId: string;
  homeScore: number;
  awayScore: number;
};

const gameIds = new Set(gameSets.flatMap((set) => set.games.map((game) => game.id)));

function sendError(response: VercelResponse, status: number, message: string) {
  response.status(status).json({ error: message });
}

function accessTokenFromRequest(request: VercelRequest) {
  const header = request.headers["x-wc26-access-token"];
  return typeof header === "string" ? header : "";
}

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 99;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  let body: unknown;
  try {
    body = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body;
  } catch {
    return sendError(response, 400, "Request body must be valid JSON.");
  }

  const bodyRecord = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  const email =
    typeof request.query.email === "string"
      ? request.query.email
      : typeof bodyRecord?.email === "string"
        ? bodyRecord.email
        : "";

  try {
    if (!email || !(await isAuthorizedParticipant(email, accessTokenFromRequest(request)))) {
      return sendError(response, 403, "This email is not allowed to use the pool.");
    }
  } catch (error) {
    return sendError(response, 503, allowlistStorageErrorMessage(error));
  }

  if (request.method === "GET") {
    try {
      const results = await readResults();
      const matchStatuses = await readMatchStatuses();
      const predictions = await readPredictions(email);
      response.status(200).json({ email: normalizeEmail(email), predictions, results, matchStatuses });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : resultStorageErrorMessage(error) || matchStatusStorageErrorMessage(error) || predictionStorageErrorMessage(error);
      sendError(response, 503, message);
    }
    return;
  }

  if (request.method === "POST") {
    const input = bodyRecord?.prediction as PredictionInput | undefined;
    if (!input || !gameIds.has(input.gameId)) {
      return sendError(response, 400, "Prediction must reference a valid game.");
    }

    if (!validScore(input.homeScore) || !validScore(input.awayScore)) {
      return sendError(response, 400, "Scores must be whole numbers between 0 and 99.");
    }

    try {
      const finalGameIds = new Set((await readResults()).map((result) => result.gameId));
      if (finalGameIds.has(input.gameId)) {
        return sendError(response, 403, "This match is final. Predictions are locked.");
      }

      const predictions = await readPredictions(email);
      predictions[input.gameId] = {
        homeScore: input.homeScore,
        awayScore: input.awayScore,
        updatedAt: new Date().toISOString(),
      };

      await savePredictions(email, predictions);
      response.status(200).json({ email: normalizeEmail(email), predictions });
    } catch (error) {
      sendError(response, 503, predictionStorageErrorMessage(error));
    }
    return;
  }

  response.setHeader("Allow", "GET, POST");
  sendError(response, 405, "Method not allowed.");
}
