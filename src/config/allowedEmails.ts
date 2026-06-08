export const allowedEmails = [
  "you@example.com",
] as const;

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isAllowedEmail(email: string) {
  return allowedEmails.includes(normalizeEmail(email) as (typeof allowedEmails)[number]);
}
