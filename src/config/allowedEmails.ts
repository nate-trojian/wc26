import { participants } from "./participants.js";

export const allowedEmails = participants.map((participant) => participant.email);

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isAllowedEmail(email: string) {
  return allowedEmails.includes(normalizeEmail(email) as (typeof allowedEmails)[number]);
}
