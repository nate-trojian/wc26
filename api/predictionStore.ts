import { list, put } from "@vercel/blob";
import { normalizeEmail } from "../src/config/allowedEmails";
import type { PredictionsByGame } from "../src/types";

const storageUnavailableMessage =
  "Prediction storage is not configured. Connect a Vercel Blob store or set BLOB_READ_WRITE_TOKEN for this deployment.";

export class PredictionStorageError extends Error {
  constructor(message = storageUnavailableMessage) {
    super(message);
    this.name = "PredictionStorageError";
  }
}

function predictionPath(email: string) {
  const safeEmail = encodeURIComponent(normalizeEmail(email));
  return `predictions/${safeEmail}.json`;
}

function blobToken() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new PredictionStorageError();
  }

  return token;
}

function storageError(error: unknown) {
  if (error instanceof PredictionStorageError) {
    return error;
  }

  console.error("Prediction storage failed", error);
  return new PredictionStorageError(
    "Prediction storage is unavailable. Check the Vercel Blob store for this deployment.",
  );
}

export async function readPredictions(email: string): Promise<PredictionsByGame> {
  try {
    const token = blobToken();
    const pathname = predictionPath(email);
    const existing = await list({ prefix: pathname, limit: 1, token });
    const match = existing.blobs.find((blob) => blob.pathname === pathname);

    if (!match) {
      return {};
    }

    const result = await fetch(match.url);
    if (!result.ok) {
      throw new PredictionStorageError(`Could not load saved predictions for ${normalizeEmail(email)}.`);
    }

    return (await result.json()) as PredictionsByGame;
  } catch (error) {
    throw storageError(error);
  }
}

export async function savePredictions(email: string, predictions: PredictionsByGame) {
  try {
    await put(predictionPath(email), JSON.stringify(predictions, null, 2), {
      access: "public",
      allowOverwrite: true,
      contentType: "application/json",
      token: blobToken(),
    });
  } catch (error) {
    throw storageError(error);
  }
}

export function predictionStorageErrorMessage(error: unknown) {
  return error instanceof PredictionStorageError
    ? error.message
    : "Prediction storage is unavailable. Check the Vercel Blob store for this deployment.";
}
