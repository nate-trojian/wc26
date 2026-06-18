import { createHash } from "node:crypto";
import { get, put, type BlobAccessType } from "@vercel/blob";
import { normalizeEmail } from "../src/config/allowedEmails.js";
import type { PredictionsByGame } from "../src/types.js";
import { cacheTtlMs, readThroughCache, writeThroughCache } from "./serverCache.js";

const storageUnavailableMessage =
  "Prediction storage is not configured. Connect a Vercel Blob store for this deployment.";
const predictionCacheTtlMs = cacheTtlMs("PREDICTIONS_CACHE_TTL_MS", 60 * 1000);

export class PredictionStorageError extends Error {
  constructor(message = storageUnavailableMessage) {
    super(message);
    this.name = "PredictionStorageError";
  }
}

function hashedEmail(email: string) {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

function predictionPath(email: string) {
  return `predictions/${hashedEmail(email)}.json`;
}

function blobAuthOptions() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return token ? { token } : {};
}

function primaryBlobAccess(): BlobAccessType {
  return process.env.PREDICTIONS_BLOB_ACCESS === "public" ? "public" : "private";
}

function alternateBlobAccess(access: BlobAccessType): BlobAccessType {
  return access === "private" ? "public" : "private";
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

function storageError(error: unknown) {
  if (error instanceof PredictionStorageError) {
    return error;
  }

  console.error("Prediction storage failed", error);
  const message = error instanceof Error ? error.message : "Check the Vercel Blob store for this deployment.";
  return new PredictionStorageError(`Prediction storage is unavailable. ${message}`);
}

export async function readPredictions(email: string): Promise<PredictionsByGame> {
  try {
    const saved = await readWithAccessFallback(predictionPath(email));
    if (!saved) {
      return {};
    }

    return (await new Response(saved.stream).json()) as PredictionsByGame;
  } catch (error) {
    throw storageError(error);
  }
}

export async function readPredictionsCached(email: string): Promise<PredictionsByGame> {
  const normalized = normalizeEmail(email);
  return readThroughCache(`predictions:${predictionPath(normalized)}:${primaryBlobAccess()}`, predictionCacheTtlMs, () =>
    readPredictions(normalized),
  );
}

export async function savePredictions(email: string, predictions: PredictionsByGame) {
  try {
    await withBlobAccessFallback((access) =>
      put(predictionPath(email), JSON.stringify(predictions, null, 2), {
        access,
        allowOverwrite: true,
        contentType: "application/json",
        ...blobAuthOptions(),
      }),
    );
    writeThroughCache(`predictions:${predictionPath(email)}:${primaryBlobAccess()}`, predictions, predictionCacheTtlMs);
  } catch (error) {
    throw storageError(error);
  }
}

export function predictionStorageErrorMessage(error: unknown) {
  return error instanceof PredictionStorageError
    ? error.message
    : "Prediction storage is unavailable. Check the Vercel Blob store for this deployment.";
}
