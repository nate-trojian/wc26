import type { Participant } from "../types.js";

export const participants = [
  {
    email: "ntrojian@gmail.com",
    name: "ntrojian@gmail.com",
  },
  {
    email: "you@example.com",
    name: "You",
  },
] as const satisfies readonly Participant[];
