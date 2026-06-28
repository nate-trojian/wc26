import { gameSets } from "./data/games.js";
import type { Game, GameResult, LeaderboardEntry, Participant, Prediction, PredictionsByEmail, PredictionsByGame } from "./types.js";

const gamesById = new Map(gameSets.flatMap((set) => set.games.map((game) => [game.id, game] as const)));
const knockoutGameIds = new Set(gameSets.filter((set) => set.isKnockout).flatMap((set) => set.games.map((game) => game.id)));

function outcome(homeScore: number, awayScore: number) {
  return Math.sign(homeScore - awayScore);
}

function resultWinningTeamId(game: Game, result: GameResult) {
  if (result.winningTeamId) {
    return result.winningTeamId;
  }

  if (result.homeScore > result.awayScore) {
    return game.homeTeamId;
  }

  if (result.awayScore > result.homeScore) {
    return game.awayTeamId;
  }

  return undefined;
}

function selectedTeamFinalScore(game: Game, result: GameResult, winningTeamId: number) {
  if (winningTeamId === game.homeTeamId) {
    return result.homeScore;
  }

  if (winningTeamId === game.awayTeamId) {
    return result.awayScore;
  }

  return undefined;
}

function scoreKnockoutPrediction(prediction: Prediction, result: GameResult) {
  const game = gamesById.get(result.gameId);
  if (!game || !prediction.winningTeamId || prediction.selectedTeamScore === undefined || !prediction.endingPhase) {
    return { points: 0, exactScores: 0, outcomes: 0 };
  }

  const winningTeamId = resultWinningTeamId(game, result);
  const winnerExact = prediction.winningTeamId === winningTeamId ? 1 : 0;
  const selectedScore = selectedTeamFinalScore(game, result, prediction.winningTeamId);
  const scoreExact = selectedScore === prediction.selectedTeamScore ? 1 : 0;
  const phaseExact =
    result.endingPhase && prediction.endingPhase === result.endingPhase && (winnerExact || prediction.endingPhase === "pks")
      ? 1
      : 0;

  return {
    points: winnerExact * 2 + scoreExact + phaseExact,
    exactScores: scoreExact,
    outcomes: winnerExact,
  };
}

export function scorePredictions(predictions: PredictionsByGame, results: readonly GameResult[]) {
  return results.reduce(
    (score, result) => {
      const prediction = predictions[result.gameId];
      if (!prediction) {
        return score;
      }

      if (knockoutGameIds.has(result.gameId)) {
        const knockoutScore = scoreKnockoutPrediction(prediction, result);
        return {
          points: score.points + knockoutScore.points,
          exactScores: score.exactScores + knockoutScore.exactScores,
          outcomes: score.outcomes + knockoutScore.outcomes,
          predictedGames: score.predictedGames + 1,
        };
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
