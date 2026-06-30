import type { GameResult } from "../types.js";

export const matchResults: readonly GameResult[] = [
  // Add completed matches here as final scores become available.
  {
    gameId: "g32",
    homeScore: 0,
    awayScore: 1,
  },
  {
    gameId: "g42",
    homeScore: 3,
    awayScore: 0,
  },
  {
    gameId: "g43",
    homeScore: 3,
    awayScore: 2,
  },
  {
    gameId: "g73",
    homeScore: 2,
    awayScore: 2,
    winningTeamId: 5,
    endingPhase: "pks",
  },
  {
    gameId: "g75",
    homeScore: 1,
    awayScore: 1,
    winningTeamId: 14,
    endingPhase: "pks",
  },
];
