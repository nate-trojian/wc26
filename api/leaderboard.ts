import type { VercelRequest, VercelResponse } from "@vercel/node";
import { list } from "@vercel/blob";
import { isAllowedEmail, normalizeEmail } from "../src/config/allowedEmails";
import { participants } from "../src/config/participants";
import { matchResults } from "../src/data/results";
import { buildLeaderboard } from "../src/scoring";
import type { PredictionsByGame } from "../src/types";

function predictionPath(email: string) {
  const safeEmail = encodeURIComponent(normalizeEmail(email));
  return `predictions/${safeEmail}.json`;
}

function sendError(response: VercelResponse, status: number, message: string) {
  response.status(status).json({ error: message });
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

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return sendError(response, 405, "Method not allowed.");
  }

  const email = typeof request.query.email === "string" ? request.query.email : "";
  if (!email || !isAllowedEmail(email)) {
    return sendError(response, 403, "This email is not allowed to use the pool.");
  }

  const predictionsByEmail = Object.fromEntries(
    await Promise.all(
      participants.map(async (participant) => [participant.email, await readPredictions(participant.email)] as const),
    ),
  );

  response.status(200).json({
    leaderboard: buildLeaderboard(participants, predictionsByEmail, matchResults),
    resultsCount: matchResults.length,
  });
}
