export type GameSetId = "first" | "second" | "third" | "knockout";

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
  isKnockout?: boolean;
  games: Game[];
};

export type EndingPhase = "regular" | "extra" | "pks";

export type Prediction = {
  homeScore: number;
  awayScore: number;
  winningTeamId?: number;
  selectedTeamScore?: number;
  endingPhase?: EndingPhase;
  updatedAt: string;
};

export type PredictionsByGame = Record<string, Prediction>;

export type PredictionsByEmail = Record<string, PredictionsByGame>;

export type Participant = {
  email: string;
  name: string;
};

export type GameResult = {
  gameId: string;
  homeScore: number;
  awayScore: number;
  winningTeamId?: number;
  endingPhase?: EndingPhase;
};

export type MatchStatusState = "pre" | "in" | "post";

export type MatchStatus = {
  gameId: string;
  state: MatchStatusState;
  statusName: string;
  displayClock?: string;
  completed: boolean;
  homeScore: number | null;
  awayScore: number | null;
  lastUpdatedAt: string;
  providerEventId?: string;
};

export type LeaderboardEntry = {
  email: string;
  name: string;
  points: number;
  exactScores: number;
  outcomes: number;
  predictedGames: number;
};

export type PredictionMatrixPayload = {
  participants: Participant[];
  predictionsByEmail: PredictionsByEmail;
};
