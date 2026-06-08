import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isAllowedEmail, normalizeEmail } from "../src/config/allowedEmails";
import { participants } from "../src/config/participants";
import { matchResults } from "../src/data/results";
import { buildLeaderboard } from "../src/scoring";
import { predictionStorageErrorMessage, readPredictions } from "./predictionStore";

function sendError(response: VercelResponse, status: number, message: string) {
  response.status(status).json({ error: message });
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

  try {
    const predictionsByEmail = Object.fromEntries(
      await Promise.all(
        participants.map(async (participant) => [participant.email, await readPredictions(participant.email)] as const),
      ),
    );

    response.status(200).json({
      leaderboard: buildLeaderboard(participants, predictionsByEmail, matchResults),
      resultsCount: matchResults.length,
    });
  } catch (error) {
    sendError(response, 503, predictionStorageErrorMessage(error));
  }
}
