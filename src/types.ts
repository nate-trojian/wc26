export type GameSetId = "first" | "second" | "third";

export type Game = {
  id: string;
  matchNumber: number;
  dateTime: string;
  homeTeamId: number;
  homeTeam: string;
  awayTeamId: number;
  awayTeam: string;
};

export type GameSet = {
  id: GameSetId;
  name: string;
  games: Game[];
};

export type Prediction = {
  homeScore: number;
  awayScore: number;
  updatedAt: string;
};

export type PredictionsByGame = Record<string, Prediction>;
