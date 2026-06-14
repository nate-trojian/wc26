import { normalizeEmail } from "./allowedEmails.js";

export const adminEmail = "ntrojian@gmail.com";

export function isAdminEmail(email: string | null | undefined) {
  return normalizeEmail(email ?? "") === adminEmail;
}
