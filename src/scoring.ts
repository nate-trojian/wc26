import type { GameResult, LeaderboardEntry, Participant, PredictionsByGame } from "./types";

type PredictionsByEmail = Record<string, PredictionsByGame>;

function outcome(homeScore: number, awayScore: number) {
  return Math.sign(homeScore - awayScore);
}

export function scorePredictions(predictions: PredictionsByGame, results: readonly GameResult[]) {
  return results.reduce(
    (score, result) => {
      const prediction = predictions[result.gameId];
      if (!prediction) {
        return score;
      }

      const homeExact = prediction.homeScore === result.homeScore ? 1 : 0;
      const awayExact = prediction.awayScore === result.awayScore ? 1 : 0;
      const outcomeExact =
        outcome(prediction.homeScore, prediction.awayScore) === outcome(result.homeScore, result.awayScore) ? 1 : 0;

      return {
        points: score.points + homeExact + awayExact + outcomeExact,
        exactScores: score.exactScores + homeExact + awayExact,
        outcomes: score.outcomes + outcomeExact,
        predictedGames: score.predictedGames + 1,
      };
    },
    { points: 0, exactScores: 0, outcomes: 0, predictedGames: 0 },
  );
}

export function buildLeaderboard(
  participants: readonly Participant[],
  predictionsByEmail: PredictionsByEmail,
  results: readonly GameResult[],
): LeaderboardEntry[] {
  return participants
    .map((participant) => ({
      email: participant.email,
      name: participant.name,
      ...scorePredictions(predictionsByEmail[participant.email] ?? {}, results),
    }))
    .sort((left, right) => {
      if (right.points !== left.points) {
        return right.points - left.points;
      }

      if (right.exactScores !== left.exactScores) {
        return right.exactScores - left.exactScores;
      }

      if (right.outcomes !== left.outcomes) {
        return right.outcomes - left.outcomes;
      }

      return left.name.localeCompare(right.name);
    });
}
