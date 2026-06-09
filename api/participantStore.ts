import { get } from "@vercel/blob";
import { allowedEmails, normalizeEmail } from "../src/config/allowedEmails.js";
import { participants as localParticipants } from "../src/config/participants.js";
import type { Participant } from "../src/types.js";

type BlobAllowlist = string[] | { emails?: readonly string[]; participants?: readonly Participant[] };

const allowlistStorageUnavailableMessage =
  "Email allowlist storage is not configured. Connect a Vercel Blob store for this deployment.";

export class AllowlistStorageError extends Error {
  constructor(message = allowlistStorageUnavailableMessage) {
    super(message);
    this.name = "AllowlistStorageError";
  }
}

function blobAuthOptions() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return token ? { token } : {};
}

function shouldReadAllowlistFromBlob() {
  return process.env.ALLOWLIST_SOURCE === "blob" || process.env.VERCEL_ENV === "production";
}

function allowlistBlobPath() {
  return process.env.ALLOWLIST_BLOB_PATH ?? "allowlist.json";
}

function participantFromEmail(email: string): Participant {
  const normalized = normalizeEmail(email);
  return {
    email: normalized,
    name: normalized,
  };
}

function normalizeParticipant(participant: Participant): Participant {
  return {
    email: normalizeEmail(participant.email),
    name: participant.name.trim() || normalizeEmail(participant.email),
  };
}

function participantsFromBlob(payload: BlobAllowlist): Participant[] {
  if (Array.isArray(payload)) {
    return payload.map(participantFromEmail);
  }

  const { emails, participants } = payload;

  if (Array.isArray(participants)) {
    return participants.map(normalizeParticipant);
  }

  if (Array.isArray(emails)) {
    return emails.map(participantFromEmail);
  }

  throw new AllowlistStorageError("Email allowlist storage is invalid. Expected emails or participants JSON.");
}

function allowlistStorageError(error: unknown) {
  if (error instanceof AllowlistStorageError) {
    return error;
  }

  console.error("Email allowlist storage failed", error);
  const message = error instanceof Error ? error.message : "Check the Vercel Blob allowlist for this deployment.";
  return new AllowlistStorageError(`Email allowlist storage is unavailable. ${message}`);
}

export async function readParticipants(): Promise<readonly Participant[]> {
  if (!shouldReadAllowlistFromBlob()) {
    return localParticipants;
  }

  try {
    const saved = await get(allowlistBlobPath(), {
      access: "private",
      useCache: false,
      ...blobAuthOptions(),
    });

    if (!saved) {
      throw new AllowlistStorageError();
    }

    return participantsFromBlob((await new Response(saved.stream).json()) as BlobAllowlist);
  } catch (error) {
    throw allowlistStorageError(error);
  }
}

export async function isAllowedParticipantEmail(email: string) {
  const normalized = normalizeEmail(email);
  if (!shouldReadAllowlistFromBlob()) {
    return allowedEmails.includes(normalized as (typeof allowedEmails)[number]);
  }

  const participants = await readParticipants();
  return participants.some((participant) => participant.email === normalized);
}

export function allowlistStorageErrorMessage(error: unknown) {
  return error instanceof AllowlistStorageError
    ? error.message
    : "Email allowlist storage is unavailable. Check the Vercel Blob allowlist for this deployment.";
}
