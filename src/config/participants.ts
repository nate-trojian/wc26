import type { Participant } from "../types.js";

export const participants = [
  {
    email: "you@example.com",
    name: "You",
  },
] as const satisfies readonly Participant[];
