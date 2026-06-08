import type { Participant } from "../types";

export const participants = [
  {
    email: "you@example.com",
    name: "You",
  },
] as const satisfies readonly Participant[];
