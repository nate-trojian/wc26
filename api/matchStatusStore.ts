import { get, put, type BlobAccessType } from "@vercel/blob";
import type { MatchStatus } from "../src/types.js";
import { cacheTtlMs, readThroughCache, writeThroughCache } from "./serverCache.js";

const matchStatusStorageUnavailableMessage =
  "Match status storage is not configured. Connect a Vercel Blob store for this deployment.";
const matchStatusCacheTtlMs = cacheTtlMs("MATCH_STATUSES_CACHE_TTL_MS", 60 * 1000);
const blobCacheMaxAgeSeconds = Math.max(60, Math.ceil(matchStatusCacheTtlMs / 1000));

export class MatchStatusStorageError extends Error {
  constructor(message = matchStatusStorageUnavailableMessage) {
    super(message);
    this.name = "MatchStatusStorageError";
  }
}

function blobAuthOptions() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return token ? { token } : {};
}

function matchStatusBlobPath() {
  return process.env.MATCH_STATUSES_BLOB_PATH ?? "match-statuses.json";
}

function primaryBlobAccess(): BlobAccessType {
  return process.env.MATCH_STATUSES_BLOB_ACCESS === "public" ? "public" : "private";
}

function alternateBlobAccess(access: BlobAccessType): BlobAccessType {
  return access === "private" ? "public" : "private";
}

async function readWithAccessFallback(pathname: string) {
  const primaryAccess = primaryBlobAccess();
  const alternateAccess = alternateBlobAccess(primaryAccess);

  try {
    const saved = await get(pathname, {
      access: primaryAccess,
      useCache: true,
      ...blobAuthOptions(),
    });
    if (saved) {
      return saved;
    }

    return await get(pathname, {
      access: alternateAccess,
      useCache: true,
      ...blobAuthOptions(),
    });
  } catch (primaryError) {
    try {
      return await get(pathname, {
        access: alternateAccess,
        useCache: true,
        ...blobAuthOptions(),
      });
    } catch {
      throw primaryError;
    }
  }
}

async function withBlobAccessFallback<T>(operation: (access: BlobAccessType) => Promise<T>) {
  const primaryAccess = primaryBlobAccess();

  try {
    return await operation(primaryAccess);
  } catch (primaryError) {
    try {
      return await operation(alternateBlobAccess(primaryAccess));
    } catch {
      throw primaryError;
    }
  }
}

function matchStatusStorageError(error: unknown) {
  if (error instanceof MatchStatusStorageError) {
    return error;
  }

  console.error("Match status storage failed", error);
  const message = error instanceof Error ? error.message : "Check the Vercel Blob store for this deployment.";
  return new MatchStatusStorageError(`Match status storage is unavailable. ${message}`);
}

function validNullableScore(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function validMatchStatus(value: unknown): value is MatchStatus {
  const status = value as MatchStatus | undefined;
  return (
    Boolean(status) &&
    typeof status?.gameId === "string" &&
    (status.state === "pre" || status.state === "in" || status.state === "post") &&
    typeof status.statusName === "string" &&
    typeof status.completed === "boolean" &&
    validNullableScore(status.homeScore) &&
    validNullableScore(status.awayScore) &&
    typeof status.lastUpdatedAt === "string" &&
    (status.providerEventId === undefined || typeof status.providerEventId === "string")
  );
}

function mergeMatchStatuses(statuses: readonly MatchStatus[]) {
  return Array.from(new Map(statuses.map((status) => [status.gameId, status])).values());
}

async function readMatchStatusesUncached(): Promise<readonly MatchStatus[]> {
  try {
    const saved = await readWithAccessFallback(matchStatusBlobPath());
    if (!saved) {
      return [];
    }

    const payload = (await new Response(saved.stream).json()) as unknown;
    if (!Array.isArray(payload) || !payload.every(validMatchStatus)) {
      throw new MatchStatusStorageError("Match status storage is invalid. Expected an array of match statuses.");
    }

    return mergeMatchStatuses(payload);
  } catch (error) {
    if (error instanceof MatchStatusStorageError) {
      throw error;
    }

    throw matchStatusStorageError(error);
  }
}

export async function readMatchStatuses(): Promise<readonly MatchStatus[]> {
  return readThroughCache(
    `match-statuses:${matchStatusBlobPath()}:${primaryBlobAccess()}`,
    matchStatusCacheTtlMs,
    readMatchStatusesUncached,
  );
}

export async function saveMatchStatuses(statuses: readonly MatchStatus[]) {
  try {
    const mergedStatuses = mergeMatchStatuses(statuses);
    await withBlobAccessFallback((access) =>
      put(matchStatusBlobPath(), JSON.stringify(mergedStatuses, null, 2), {
        access,
        allowOverwrite: true,
        contentType: "application/json",
        cacheControlMaxAge: blobCacheMaxAgeSeconds,
        ...blobAuthOptions(),
      }),
    );
    writeThroughCache(
      `match-statuses:${matchStatusBlobPath()}:${primaryBlobAccess()}`,
      mergedStatuses,
      matchStatusCacheTtlMs,
    );
  } catch (error) {
    throw matchStatusStorageError(error);
  }
}

export function matchStatusStorageErrorMessage(error: unknown) {
  return error instanceof MatchStatusStorageError
    ? error.message
    : "Match status storage is unavailable. Check the Vercel Blob store for this deployment.";
}
