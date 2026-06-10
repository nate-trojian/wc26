import type { VercelRequest, VercelResponse } from "@vercel/node";
import { normalizeEmail } from "../src/config/allowedEmails.js";
import { buildLeaderboard } from "../src/scoring.js";
import type { Participant } from "../src/types.js";
import { allowlistStorageErrorMessage, isAuthorizedParticipant, readParticipants } from "./participantStore.js";
import { predictionStorageErrorMessage, readPredictions } from "./predictionStore.js";
import { readResults, resultStorageErrorMessage } from "./resultStore.js";

function sendError(response: VercelResponse, status: number, message: string) {
  response.status(status).json({ error: message });
}

function accessTokenFromRequest(request: VercelRequest) {
  const header = request.headers["x-wc26-access-token"];
  return typeof header === "string" ? header : "";
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return sendError(response, 405, "Method not allowed.");
  }

  const email = typeof request.query.email === "string" ? request.query.email : "";
  let participants: readonly Participant[];
  try {
    participants = await readParticipants();
    const normalizedEmail = normalizeEmail(email);
    const participantExists = participants.some((participant) => participant.email === normalizedEmail);
    if (!email || !participantExists || !(await isAuthorizedParticipant(email, accessTokenFromRequest(request)))) {
      return sendError(response, 403, "This email is not allowed to use the pool.");
    }
  } catch (error) {
    return sendError(response, 503, allowlistStorageErrorMessage(error));
  }

  try {
    const matchResults = await readResults();
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
    const message = error instanceof Error ? error.message : resultStorageErrorMessage(error) || predictionStorageErrorMessage(error);
    sendError(response, 503, message);
  }
}
