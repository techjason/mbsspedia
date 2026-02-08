import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_VERSION = "v1";

export function resolveCachePaths(cacheDir) {
  const baseDir = path.resolve(process.cwd(), cacheDir);
  return {
    baseDir,
    manifestPath: path.join(baseDir, "manifest.json"),
  };
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function readJsonIfExists(filePath, fallback = null) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EISDIR")
    ) {
      return fallback;
    }
    throw error;
  }
}

export async function writeJsonAtomic(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function deleteFileIfExists(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function hashFileSha256(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);

    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function fingerprintFile(filePath) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error(`Expected file: ${absolutePath}`);
  }

  const sha256 = await hashFileSha256(absolutePath);
  return {
    absolutePath,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    sha256,
  };
}

export async function readManifest(manifestPath) {
  const manifest = await readJsonIfExists(manifestPath, null);
  if (!manifest) {
    return {
      manifestVersion: MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chunkingVersion: "unknown",
      embeddingModel: "",
      sources: {},
    };
  }

  return {
    manifestVersion: manifest.manifestVersion ?? MANIFEST_VERSION,
    createdAt: manifest.createdAt ?? new Date().toISOString(),
    updatedAt: manifest.updatedAt ?? new Date().toISOString(),
    chunkingVersion: manifest.chunkingVersion ?? "unknown",
    embeddingModel: manifest.embeddingModel ?? "",
    sources: manifest.sources ?? {},
  };
}

export async function writeManifest(manifestPath, manifest) {
  const payload = {
    ...manifest,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(manifestPath, payload);
}

export function isFingerprintMatch(entry, fingerprint) {
  if (!entry || !fingerprint) {
    return false;
  }

  return (
    entry.sha256 === fingerprint.sha256 &&
    entry.size === fingerprint.size &&
    Number(entry.mtimeMs) === Number(fingerprint.mtimeMs)
  );
}

export function relFromCache(cacheBaseDir, absolutePath) {
  return path.relative(cacheBaseDir, absolutePath);
}

export function absFromCache(cacheBaseDir, relativePath) {
  return path.resolve(cacheBaseDir, relativePath);
}
