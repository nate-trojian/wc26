import type { VercelRequest, VercelResponse } from "@vercel/node";
import { list, put } from "@vercel/blob";
import { isAllowedEmail, normalizeEmail } from "../src/config/allowedEmails";
import { gameSets } from "../src/data/games";
import { matchResults } from "../src/data/results";
import type { PredictionsByGame } from "../src/types";

type PredictionInput = {
  gameId: string;
  homeScore: number;
  awayScore: number;
};

const gameIds = new Set(gameSets.flatMap((set) => set.games.map((game) => game.id)));
const finalGameIds = new Set(matchResults.map((result) => result.gameId));

function predictionPath(email: string) {
  const safeEmail = encodeURIComponent(normalizeEmail(email));
  return `predictions/${safeEmail}.json`;
}

function sendError(response: VercelResponse, status: number, message: string) {
  response.status(status).json({ error: message });
}

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 99;
}

async function readPredictions(email: string): Promise<PredictionsByGame> {
  const pathname = predictionPath(email);
  const existing = await list({ prefix: pathname, limit: 1 });
  const match = existing.blobs.find((blob) => blob.pathname === pathname);

  if (!match) {
    return {};
  }

  const result = await fetch(match.url);
  if (!result.ok) {
    throw new Error(`Could not load saved predictions for ${email}`);
  }

  return (await result.json()) as PredictionsByGame;
}

async function savePredictions(email: string, predictions: PredictionsByGame) {
  await put(predictionPath(email), JSON.stringify(predictions, null, 2), {
    access: "public",
    allowOverwrite: true,
    contentType: "application/json",
  });
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const body = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body;
  const email = typeof request.query.email === "string" ? request.query.email : body?.email;

  if (!email || !isAllowedEmail(email)) {
    return sendError(response, 403, "This email is not allowed to use the pool.");
  }

  if (request.method === "GET") {
    const predictions = await readPredictions(email);
    response.status(200).json({ email: normalizeEmail(email), predictions });
    return;
  }

  if (request.method === "POST") {
    const input = body?.prediction as PredictionInput | undefined;
    if (!input || !gameIds.has(input.gameId)) {
      return sendError(response, 400, "Prediction must reference a valid game.");
    }

    if (!validScore(input.homeScore) || !validScore(input.awayScore)) {
      return sendError(response, 400, "Scores must be whole numbers between 0 and 99.");
    }

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
    return;
  }

  response.setHeader("Allow", "GET, POST");
  sendError(response, 405, "Method not allowed.");
}
