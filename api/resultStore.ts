import { get, put, type BlobAccessType } from "@vercel/blob";
import { matchResults } from "../src/data/results.js";
import type { GameResult } from "../src/types.js";

const resultStorageUnavailableMessage =
  "Result storage is not configured. Connect a Vercel Blob store for this deployment.";

export class ResultStorageError extends Error {
  constructor(message = resultStorageUnavailableMessage) {
    super(message);
    this.name = "ResultStorageError";
  }
}

function blobAuthOptions() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return token ? { token } : {};
}

function resultBlobPath() {
  return process.env.RESULTS_BLOB_PATH ?? "results.json";
}

function primaryBlobAccess(): BlobAccessType {
  return process.env.RESULTS_BLOB_ACCESS === "public" ? "public" : "private";
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
      useCache: false,
      ...blobAuthOptions(),
    });
    if (saved) {
      return saved;
    }

    return await get(pathname, {
      access: alternateAccess,
      useCache: false,
      ...blobAuthOptions(),
    });
  } catch (primaryError) {
    try {
      return await get(pathname, {
        access: alternateAccess,
        useCache: false,
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

function resultStorageError(error: unknown) {
  if (error instanceof ResultStorageError) {
    return error;
  }

  console.error("Result storage failed", error);
  const message = error instanceof Error ? error.message : "Check the Vercel Blob store for this deployment.";
  return new ResultStorageError(`Result storage is unavailable. ${message}`);
}

function validResult(value: unknown): value is GameResult {
  const result = value as GameResult | undefined;
  return (
    Boolean(result) &&
    typeof result?.gameId === "string" &&
    typeof result.homeScore === "number" &&
    Number.isInteger(result.homeScore) &&
    result.homeScore >= 0 &&
    typeof result.awayScore === "number" &&
    Number.isInteger(result.awayScore) &&
    result.awayScore >= 0
  );
}

function mergeResults(results: readonly GameResult[]) {
  return Array.from(new Map(results.map((result) => [result.gameId, result])).values());
}

export async function readResults(): Promise<readonly GameResult[]> {
  try {
    const saved = await readWithAccessFallback(resultBlobPath());
    if (!saved) {
      return matchResults;
    }

    const payload = (await new Response(saved.stream).json()) as unknown;
    if (!Array.isArray(payload) || !payload.every(validResult)) {
      throw new ResultStorageError("Result storage is invalid. Expected an array of final scores.");
    }

    return mergeResults([...matchResults, ...payload]);
  } catch (error) {
    if (error instanceof ResultStorageError) {
      throw error;
    }

    throw resultStorageError(error);
  }
}

export async function saveResults(results: readonly GameResult[]) {
  try {
    const mergedResults = mergeResults([...matchResults, ...results]);
    await withBlobAccessFallback((access) =>
      put(resultBlobPath(), JSON.stringify(mergedResults, null, 2), {
        access,
        allowOverwrite: true,
        contentType: "application/json",
        ...blobAuthOptions(),
      }),
    );
  } catch (error) {
    throw resultStorageError(error);
  }
}

export function resultStorageErrorMessage(error: unknown) {
  return error instanceof ResultStorageError
    ? error.message
    : "Result storage is unavailable. Check the Vercel Blob store for this deployment.";
}
