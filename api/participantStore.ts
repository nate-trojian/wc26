import { createHash, timingSafeEqual } from "node:crypto";
import { get } from "@vercel/blob";
import { allowedEmails, normalizeEmail } from "../src/config/allowedEmails.js";
import { participants as localParticipants } from "../src/config/participants.js";
import type { Participant } from "../src/types.js";
import { cacheTtlMs, readThroughCache } from "./serverCache.js";

type ParticipantWithToken = Participant & {
  tokenHash?: string;
};

type BlobAllowlist = string[] | { emails?: readonly string[]; participants?: readonly ParticipantWithToken[] };

const allowlistStorageUnavailableMessage =
  "Email allowlist storage is not configured. Connect a Vercel Blob store for this deployment.";
const allowlistCacheTtlMs = cacheTtlMs("ALLOWLIST_CACHE_TTL_MS", Number.POSITIVE_INFINITY);

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

function normalizeParticipantWithToken(participant: ParticipantWithToken): ParticipantWithToken {
  return {
    ...normalizeParticipant(participant),
    tokenHash: participant.tokenHash,
  };
}

function participantsFromBlob(payload: BlobAllowlist): Participant[] {
  if (Array.isArray(payload)) {
    return payload.map(participantFromEmail);
  }

  const { emails, participants } = payload;

  if (Array.isArray(participants)) {
    return participants.map(normalizeParticipantWithToken);
  }

  if (Array.isArray(emails)) {
    return emails.map(participantFromEmail);
  }

  throw new AllowlistStorageError("Email allowlist storage is invalid. Expected emails or participants JSON.");
}

function hashAccessToken(accessToken: string) {
  return createHash("sha256").update(accessToken).digest("hex");
}

function hexToBytes(value: string) {
  return Uint8Array.from(value.match(/.{1,2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function hashesMatch(candidate: string, expected: string) {
  const candidateBytes = hexToBytes(candidate);
  const expectedBytes = hexToBytes(expected);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

function allowlistStorageError(error: unknown) {
  if (error instanceof AllowlistStorageError) {
    return error;
  }

  console.error("Email allowlist storage failed", error);
  const message = error instanceof Error ? error.message : "Check the Vercel Blob allowlist for this deployment.";
  return new AllowlistStorageError(`Email allowlist storage is unavailable. ${message}`);
}

async function readParticipantsFromBlob(): Promise<readonly Participant[]> {
  try {
    const saved = await get(allowlistBlobPath(), {
      access: "private",
      useCache: true,
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

export async function readParticipants(): Promise<readonly Participant[]> {
  if (!shouldReadAllowlistFromBlob()) {
    return localParticipants;
  }

  return readThroughCache(`allowlist:${allowlistBlobPath()}`, allowlistCacheTtlMs, readParticipantsFromBlob);
}

export async function isAllowedParticipantEmail(email: string) {
  const normalized = normalizeEmail(email);
  if (!shouldReadAllowlistFromBlob()) {
    return allowedEmails.includes(normalized as (typeof allowedEmails)[number]);
  }

  const participants = await readParticipants();
  return participants.some((participant) => participant.email === normalized);
}

export async function isAuthorizedParticipant(email: string, accessToken: string) {
  const normalized = normalizeEmail(email);
  if (!shouldReadAllowlistFromBlob()) {
    return allowedEmails.includes(normalized as (typeof allowedEmails)[number]);
  }

  if (!accessToken) {
    return false;
  }

  const participants = (await readParticipants()) as readonly ParticipantWithToken[];
  const participant = participants.find((item) => item.email === normalized);
  if (!participant?.tokenHash) {
    return false;
  }

  return hashesMatch(hashAccessToken(accessToken), participant.tokenHash);
}

export function allowlistStorageErrorMessage(error: unknown) {
  return error instanceof AllowlistStorageError
    ? error.message
    : "Email allowlist storage is unavailable. Check the Vercel Blob allowlist for this deployment.";
}
