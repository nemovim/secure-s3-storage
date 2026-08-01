import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { lookup as lookupMimeType } from "mime-types";

const PENDING_PREFIX = "_pending";
const DEFAULT_PRESIGNED_URL_EXPIRES_IN = 5 * 60;
const DEFAULT_COMPLETE_TOKEN_EXPIRES_IN = 10 * 60;

const DANGEROUS_EXTENSIONS = new Set([
  "ade",
  "adp",
  "app",
  "asp",
  "aspx",
  "bat",
  "cer",
  "cgi",
  "chm",
  "cmd",
  "com",
  "cpl",
  "crt",
  "cshtml",
  "dll",
  "drv",
  "exe",
  "hta",
  "htaccess",
  "htm",
  "html",
  "inf",
  "iso",
  "jar",
  "js",
  "jsp",
  "jsx",
  "lnk",
  "mht",
  "mhtml",
  "mjs",
  "msi",
  "msix",
  "php",
  "phar",
  "php3",
  "php4",
  "php5",
  "phtml",
  "pl",
  "ps1",
  "py",
  "rb",
  "reg",
  "scr",
  "sh",
  "svg",
  "svgz",
  "swf",
  "ts",
  "tsx",
  "vb",
  "vbe",
  "vbs",
  "war",
  "ws",
  "wsc",
  "wsf",
  "wsh",
  "xhtml",
  "xml",
]);

const TEXT_EXTENSIONS = new Set(["csv", "json", "md", "txt", "yml", "yaml"]);

export type StorageErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_INPUT"
  | "INVALID_TOKEN"
  | "UPLOAD_EXPIRED"
  | "UNSUPPORTED_FILE"
  | "OBJECT_NOT_FOUND"
  | "OBJECT_MISMATCH"
  | "OBJECT_CONFLICT"
  | "STORAGE_ERROR";

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}

export type StorageConfig = {
  bucket: string;
  endpoint: string | URL;
  publicBaseUrl: string | URL;
  region: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  signingSecret: string;
  forcePathStyle?: boolean;
  maxFileSize: number;
  categories: Record<string, string[]>;
  presignedUrlExpiresIn?: number;
  completeTokenExpiresIn?: number;
};

export type FileMetadata = {
  filename: string;
  contentType?: string;
  size: number;
};

export type PutOptions = Omit<FileMetadata, "size">;

export type UploadFile = {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type StoredObject = {
  bucket: string;
  key: string;
  filename: string;
  extension: string;
  contentType: string;
  size: number;
  etag?: string;
};

export type PresignedUpload = {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  token: string;
  expiresAt: string;
};

export type Storage = {
  put(category: string, file: UploadFile): Promise<StoredObject>;
  put(category: string, data: Buffer | Uint8Array, options: PutOptions): Promise<StoredObject>;
  presign(category: string, metadata: FileMetadata): Promise<PresignedUpload>;
  complete(token: string): Promise<StoredObject>;
  remove(key: string): Promise<void>;
  getUrl(key: string): string;
};

type CategoryConfig = {
  prefix: string;
  allowedExtensions: Set<string>;
};

type UploadClaims = {
  version: 1;
  bucket: string;
  finalKey: string;
  contentType: string;
  size: number;
  expiresAt: number;
};

type ValidatedUploadClaims = UploadClaims & {
  temporaryKey: string;
  extension: string;
};

type ValidatedMetadata = {
  extension: string;
  contentType: string;
  size: number;
};

export function createStorage(config: StorageConfig): Storage {
  const bucket = requireString(config.bucket, "bucket");
  const endpoint = normalizeBaseUrl(config.endpoint, "endpoint");
  const publicBaseUrl = normalizeBaseUrl(config.publicBaseUrl, "publicBaseUrl");
  const region = requireString(config.region, "region");
  const accessKeyId = requireString(config.credentials?.accessKeyId, "credentials.accessKeyId");
  const secretAccessKey = requireString(
    config.credentials?.secretAccessKey,
    "credentials.secretAccessKey",
  );
  const sessionToken = optionalString(config.credentials?.sessionToken);
  const signingSecret = requireString(config.signingSecret, "signingSecret");
  const maxFileSize = requirePositiveInteger(config.maxFileSize, "maxFileSize");
  const presignedUrlExpiresIn = requireExpiry(
    config.presignedUrlExpiresIn ?? DEFAULT_PRESIGNED_URL_EXPIRES_IN,
    "presignedUrlExpiresIn",
  );
  const completeTokenExpiresIn = requireExpiry(
    config.completeTokenExpiresIn ?? DEFAULT_COMPLETE_TOKEN_EXPIRES_IN,
    "completeTokenExpiresIn",
  );

  if (signingSecret.length < 32) {
    throw new StorageError("INVALID_CONFIG", "signingSecret must contain at least 32 characters.");
  }
  if (signingSecret === secretAccessKey) {
    throw new StorageError(
      "INVALID_CONFIG",
      "signingSecret must not reuse credentials.secretAccessKey.",
    );
  }
  if (completeTokenExpiresIn < presignedUrlExpiresIn) {
    throw new StorageError(
      "INVALID_CONFIG",
      "completeTokenExpiresIn must be greater than or equal to presignedUrlExpiresIn.",
    );
  }

  const categories = normalizeCategories(config.categories);
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: config.forcePathStyle ?? false,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    },
  });

  function put(category: string, file: UploadFile): Promise<StoredObject>;
  function put(
    category: string,
    data: Buffer | Uint8Array,
    options: PutOptions,
  ): Promise<StoredObject>;
  async function put(
    category: string,
    input: UploadFile | Buffer | Uint8Array,
    options?: PutOptions,
  ): Promise<StoredObject> {
    let body: Buffer;
    let metadata: ValidatedMetadata;

    if (isUploadFile(input)) {
      metadata = prevalidateMetadata(
        categories,
        category,
        { filename: input.name, contentType: input.type, size: input.size },
        maxFileSize,
      );
      try {
        body = Buffer.from(await input.arrayBuffer());
      } catch (cause) {
        throw new StorageError("INVALID_INPUT", "Could not read the file.", { cause });
      }
    } else {
      if (!options) {
        throw new StorageError("INVALID_INPUT", "options are required for byte data.");
      }
      body = Buffer.from(input);
      metadata = prevalidateMetadata(
        categories,
        category,
        { ...options, size: body.byteLength },
        maxFileSize,
      );
    }
    await validateFile(body, metadata);

    const key = buildFinalKey(categories.get(category)!, metadata.extension);
    try {
      const output = await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: body.byteLength,
          ContentType: metadata.contentType,
        }),
      );

      return toStoredObject(bucket, key, metadata, output.ETag);
    } catch (cause) {
      throw storageOperationError("Could not store the object.", cause);
    }
  }

  async function presign(category: string, metadata: FileMetadata): Promise<PresignedUpload> {
    const validated = prevalidateMetadata(categories, category, metadata, maxFileSize);
    const uploadId = randomUUID();
    const temporaryKey = `${PENDING_PREFIX}/${uploadId}`;
    const finalKey = buildFinalKey(categories.get(category)!, validated.extension, uploadId);
    const now = Date.now();
    const claims: UploadClaims = {
      version: 1,
      bucket,
      finalKey,
      contentType: validated.contentType,
      size: validated.size,
      expiresAt: now + completeTokenExpiresIn * 1000,
    };

    try {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: temporaryKey,
          ContentType: validated.contentType,
        }),
        { expiresIn: presignedUrlExpiresIn },
      );

      return {
        url,
        method: "PUT",
        headers: { "Content-Type": validated.contentType },
        token: signClaims(claims, signingSecret),
        expiresAt: new Date(now + presignedUrlExpiresIn * 1000).toISOString(),
      };
    } catch (cause) {
      throw new StorageError("INVALID_CONFIG", "Could not create a presigned upload.", { cause });
    }
  }

  async function complete(token: string): Promise<StoredObject> {
    const claims = validateClaims(
      verifyClaims(token, signingSecret),
      bucket,
      categories,
      maxFileSize,
    );

    const existingFinal = await headObject(claims.finalKey);
    if (existingFinal) {
      return completeExistingObject(claims, existingFinal);
    }

    const pending = await headObject(claims.temporaryKey);
    if (!pending) {
      throw new StorageError("OBJECT_NOT_FOUND", "The pending upload was not found.");
    }

    let etag: string;
    let body: Buffer;
    try {
      assertPendingMetadata(pending, claims);
      etag = requireEtag(pending.ETag);
      body = await getPendingBody(claims.temporaryKey, etag);
      const metadata: ValidatedMetadata = {
        extension: claims.extension,
        contentType: claims.contentType,
        size: claims.size,
      };
      await validateFile(body, metadata);
    } catch (error) {
      if (shouldDeleteRejectedPending(error)) {
        await deleteObjectIgnoringFailure(claims.temporaryKey);
      }
      throw error;
    }

    const racedFinal = await headObject(claims.finalKey);
    if (racedFinal) {
      return completeExistingObject(claims, racedFinal);
    }

    let copiedEtag: string | undefined;
    try {
      const copied = await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: claims.finalKey,
          CopySource: buildCopySource(bucket, claims.temporaryKey),
          CopySourceIfMatch: etag,
        }),
      );
      copiedEtag = copied.CopyObjectResult?.ETag;
    } catch (cause) {
      const concurrentFinal = await headObject(claims.finalKey);
      if (concurrentFinal) {
        return completeExistingObject(claims, concurrentFinal);
      }
      if (isPreconditionFailure(cause)) {
        await deleteObjectIgnoringFailure(claims.temporaryKey);
        throw new StorageError(
          "OBJECT_MISMATCH",
          "The pending object changed while it was being verified.",
          { cause },
        );
      }
      throw storageOperationError("Could not finalize the object.", cause);
    }

    await deleteObject(claims.temporaryKey);
    return toStoredObject(
      bucket,
      claims.finalKey,
      {
        extension: claims.extension,
        contentType: claims.contentType,
        size: claims.size,
      },
      copiedEtag,
    );
  }

  async function remove(key: string): Promise<void> {
    const normalizedKey = normalizeFinalObjectKey(key, categories);
    await deleteObject(normalizedKey);
  }

  function getUrl(key: string): string {
    const normalizedKey = normalizeFinalObjectKey(key, categories);
    return `${publicBaseUrl}/${encodeObjectKey(normalizedKey)}`;
  }

  async function headObject(key: string): Promise<HeadObjectCommandOutput | undefined> {
    try {
      return await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw storageOperationError("Could not inspect the object.", cause);
    }
  }

  async function getPendingBody(key: string, etag: string): Promise<Buffer> {
    try {
      const output = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: etag }),
      );
      if (!output.Body) {
        throw new StorageError("OBJECT_MISMATCH", "The pending object has no body.");
      }
      return Buffer.from(await output.Body.transformToByteArray());
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      if (isPreconditionFailure(cause)) {
        throw new StorageError(
          "OBJECT_MISMATCH",
          "The pending object changed while it was being read.",
          { cause },
        );
      }
      throw storageOperationError("Could not read the pending object.", cause);
    }
  }

  async function deleteObject(key: string): Promise<void> {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (cause) {
      throw storageOperationError("Could not delete the object.", cause);
    }
  }

  async function deleteObjectIgnoringFailure(key: string): Promise<void> {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
      // Lifecycle rules are the final cleanup mechanism for abandoned pending objects.
    }
  }

  async function completeExistingObject(
    claims: ValidatedUploadClaims,
    object: HeadObjectCommandOutput,
  ): Promise<StoredObject> {
    if (
      object.ContentLength !== claims.size ||
      normalizeMime(object.ContentType) !== claims.contentType
    ) {
      throw new StorageError("OBJECT_CONFLICT", "The finalized object metadata does not match.");
    }

    await deleteObjectIgnoringFailure(claims.temporaryKey);
    return toStoredObject(
      bucket,
      claims.finalKey,
      {
        extension: claims.extension,
        contentType: claims.contentType,
        size: claims.size,
      },
      object.ETag,
    );
  }

  return { put, presign, complete, remove, getUrl };
}

function normalizeCategories(input: Record<string, string[]>): Map<string, CategoryConfig> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StorageError("INVALID_CONFIG", "categories must be an object.");
  }

  const result = new Map<string, CategoryConfig>();
  for (const [name, values] of Object.entries(input)) {
    const category = requireString(name, "category");
    const prefix = normalizeObjectKey(category, "INVALID_CONFIG");
    if (prefix === PENDING_PREFIX || prefix.startsWith(`${PENDING_PREFIX}/`)) {
      throw new StorageError("INVALID_CONFIG", `Category ${category} uses a reserved prefix.`);
    }
    if (!Array.isArray(values) || values.length === 0) {
      throw new StorageError("INVALID_CONFIG", `Category ${category} must allow an extension.`);
    }

    const allowedExtensions = new Set(values.map(normalizeExtension));
    for (const extension of allowedExtensions) {
      if (
        !/^[a-z0-9]+$/.test(extension) ||
        DANGEROUS_EXTENSIONS.has(extension) ||
        !expectedMimeForExtension(extension)
      ) {
        throw new StorageError(
          "INVALID_CONFIG",
          `Category ${category} contains an unsupported extension: ${extension || "<empty>"}.`,
        );
      }
    }
    if (result.has(category)) {
      throw new StorageError("INVALID_CONFIG", `Category ${category} is duplicated.`);
    }
    result.set(category, { prefix, allowedExtensions });
  }

  if (result.size === 0) {
    throw new StorageError("INVALID_CONFIG", "At least one category is required.");
  }
  const prefixes = [...result.values()].map((category) => category.prefix);
  for (const prefix of prefixes) {
    if (prefixes.some((other) => other !== prefix && prefix.startsWith(`${other}/`))) {
      throw new StorageError(
        "INVALID_CONFIG",
        `Category prefix ${prefix} overlaps another category.`,
      );
    }
  }
  return result;
}

function prevalidateMetadata(
  categories: Map<string, CategoryConfig>,
  category: string,
  metadata: FileMetadata,
  maxFileSize: number,
): ValidatedMetadata {
  const categoryConfig = categories.get(category);
  if (!categoryConfig) {
    throw new StorageError("INVALID_INPUT", `Unknown category: ${category}`);
  }

  const filename = requireInputString(metadata?.filename, "filename");
  if (/[\\/\u0000-\u001f]/.test(filename)) {
    throw new StorageError("INVALID_INPUT", "filename contains invalid characters.");
  }
  const extension = getExtension(filename);
  if (!extension) {
    throw new StorageError("UNSUPPORTED_FILE", "filename must contain an extension.");
  }
  if (DANGEROUS_EXTENSIONS.has(extension)) {
    throw new StorageError("UNSUPPORTED_FILE", `Files with .${extension} are blocked.`);
  }
  if (!categoryConfig.allowedExtensions.has(extension)) {
    throw new StorageError(
      "UNSUPPORTED_FILE",
      `.${extension} is not allowed in category ${category}.`,
    );
  }

  const size = metadata?.size;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new StorageError("INVALID_INPUT", "size must be a non-negative integer.");
  }
  if (size > maxFileSize) {
    throw new StorageError("UNSUPPORTED_FILE", `File size exceeds ${maxFileSize} bytes.`);
  }

  const expectedMime = expectedMimeForExtension(extension);
  if (!expectedMime) {
    throw new StorageError("UNSUPPORTED_FILE", `No Content-Type is known for .${extension}.`);
  }
  const providedContentType = metadata?.contentType;
  const contentType =
    providedContentType === undefined ||
    (typeof providedContentType === "string" && !providedContentType.trim())
      ? expectedMime
      : normalizeMime(requireInputString(providedContentType, "contentType"));
  if (!mimeMatches(contentType, expectedMime)) {
    throw new StorageError(
      "UNSUPPORTED_FILE",
      `Content-Type ${contentType} does not match .${extension}.`,
    );
  }

  return { extension, contentType, size };
}

async function validateFile(body: Buffer, metadata: ValidatedMetadata): Promise<void> {
  if (body.byteLength !== metadata.size) {
    throw new StorageError("OBJECT_MISMATCH", "The actual file size does not match.");
  }

  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
  try {
    detected = await fileTypeFromBuffer(body);
  } catch (cause) {
    throw new StorageError("UNSUPPORTED_FILE", "The file type could not be identified.", {
      cause,
    });
  }
  if (TEXT_EXTENSIONS.has(metadata.extension)) {
    if (detected || !isValidUtf8Text(body)) {
      throw new StorageError("UNSUPPORTED_FILE", "The file is not valid UTF-8 text.");
    }
    return;
  }

  if (!detected) {
    throw new StorageError("UNSUPPORTED_FILE", "The file type could not be identified.");
  }
  if (!extensionsMatch(metadata.extension, detected.ext, body)) {
    throw new StorageError(
      "UNSUPPORTED_FILE",
      `The file signature is ${detected.ext}, not ${metadata.extension}.`,
    );
  }
  if (!detectedMimeMatches(metadata.extension, metadata.contentType, detected.mime)) {
    throw new StorageError(
      "UNSUPPORTED_FILE",
      `The detected Content-Type ${detected.mime} does not match ${metadata.contentType}.`,
    );
  }
}

function signClaims(claims: UploadClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyClaims(token: string, secret: string): UploadClaims {
  if (typeof token !== "string" || token.length === 0 || token.length > 8192) {
    throw new StorageError("INVALID_TOKEN", "The upload token is invalid.");
  }
  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
  ) {
    throw new StorageError("INVALID_TOKEN", "The upload token is invalid.");
  }

  const expected = createHmac("sha256", secret).update(parts[0]).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(parts[1], "base64url");
  } catch {
    throw new StorageError("INVALID_TOKEN", "The upload token signature is invalid.");
  }
  if (
    provided.toString("base64url") !== parts[1] ||
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new StorageError("INVALID_TOKEN", "The upload token signature is invalid.");
  }

  try {
    return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as UploadClaims;
  } catch {
    throw new StorageError("INVALID_TOKEN", "The upload token payload is invalid.");
  }
}

function validateClaims(
  claims: UploadClaims,
  bucket: string,
  categories: Map<string, CategoryConfig>,
  maxFileSize: number,
): ValidatedUploadClaims {
  if (!claims || claims.version !== 1 || claims.bucket !== bucket) {
    throw new StorageError("INVALID_TOKEN", "The upload token belongs to another storage.");
  }
  if (!Number.isSafeInteger(claims.expiresAt)) {
    throw new StorageError("INVALID_TOKEN", "The upload token contains an invalid expiry.");
  }
  if (claims.expiresAt <= Date.now()) {
    throw new StorageError("UPLOAD_EXPIRED", "The upload token has expired.");
  }
  if (
    !Number.isSafeInteger(claims.size) ||
    claims.size < 0 ||
    claims.size > maxFileSize ||
    normalizeMime(claims.contentType) !== claims.contentType
  ) {
    throw new StorageError("INVALID_TOKEN", "The upload token contains invalid metadata.");
  }

  let finalObject: FinalObjectKey;
  try {
    finalObject = parseFinalObjectKey(claims.finalKey, categories);
  } catch (cause) {
    throw new StorageError("INVALID_TOKEN", "The upload token contains an invalid final key.", {
      cause,
    });
  }
  const expectedMime = expectedMimeForExtension(finalObject.extension);
  if (
    finalObject.key !== claims.finalKey ||
    !expectedMime ||
    !mimeMatches(claims.contentType, expectedMime)
  ) {
    throw new StorageError("INVALID_TOKEN", "The upload token contains an invalid final key.");
  }

  return {
    ...claims,
    temporaryKey: `${PENDING_PREFIX}/${finalObject.objectId}`,
    extension: finalObject.extension,
  };
}

function assertPendingMetadata(pending: HeadObjectCommandOutput, claims: UploadClaims): void {
  if (
    pending.ContentLength !== claims.size ||
    normalizeMime(pending.ContentType) !== claims.contentType
  ) {
    throw new StorageError("OBJECT_MISMATCH", "The pending object metadata does not match.");
  }
}

function normalizeFinalObjectKey(
  key: string,
  categories: Map<string, CategoryConfig>,
): string {
  return parseFinalObjectKey(key, categories).key;
}

type FinalObjectKey = {
  key: string;
  extension: string;
  objectId: string;
};

function parseFinalObjectKey(
  key: string,
  categories: Map<string, CategoryConfig>,
): FinalObjectKey {
  const normalized = normalizeObjectKey(key, "INVALID_INPUT");
  if (normalized === PENDING_PREFIX || normalized.startsWith(`${PENDING_PREFIX}/`)) {
    throw new StorageError("INVALID_INPUT", "Pending object keys are not public API keys.");
  }

  const category = [...categories.values()].find((entry) =>
    normalized.startsWith(`${entry.prefix}/`),
  );
  if (!category) {
    throw new StorageError("INVALID_INPUT", "The object key uses an unknown category.");
  }

  const remainder = normalized.slice(category.prefix.length + 1).split("/");
  if (remainder.length !== 4 || !isDatePath(remainder[0], remainder[1], remainder[2])) {
    throw new StorageError(
      "INVALID_INPUT",
      "Object key must match <category>/YYYY/MM/DD/<filename>.",
    );
  }
  const filename = remainder[3];
  const extension = getExtension(filename);
  const objectId = filename.slice(0, -(extension.length + 1));
  if (
    !extension ||
    !isUuid(objectId) ||
    DANGEROUS_EXTENSIONS.has(extension) ||
    !category.allowedExtensions.has(extension)
  ) {
    throw new StorageError("INVALID_INPUT", "Object key filename is not a generated filename.");
  }
  return { key: normalized, extension, objectId };
}

function normalizeObjectKey(key: string, code: "INVALID_CONFIG" | "INVALID_INPUT"): string {
  if (typeof key !== "string") throw new StorageError(code, "Object key must be a string.");
  const normalized = key.trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /\/{2,}/.test(normalized)) {
    throw new StorageError(code, "Object key is invalid.");
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[\u0000-\u001f\u007f]/.test(segment),
    )
  ) {
    throw new StorageError(code, "Object key contains invalid path segments.");
  }
  return segments.join("/");
}

function buildFinalKey(
  category: CategoryConfig,
  extension: string,
  objectId = randomUUID(),
): string {
  return `${category.prefix}/${getDatePath()}/${objectId}.${extension}`;
}

function buildCopySource(bucket: string, key: string): string {
  return `${encodeURIComponent(bucket)}/${encodeObjectKey(key)}`;
}

function toStoredObject(
  bucket: string,
  key: string,
  metadata: ValidatedMetadata,
  etag?: string,
): StoredObject {
  return {
    bucket,
    key,
    filename: key.split("/").at(-1)!,
    extension: metadata.extension,
    contentType: metadata.contentType,
    size: metadata.size,
    ...(etag ? { etag } : {}),
  };
}

function normalizeBaseUrl(value: string | URL, name: string): string {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new StorageError("INVALID_CONFIG", `${name} must be a valid absolute URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new StorageError("INVALID_CONFIG", `${name} must use http or https.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new StorageError(
      "INVALID_CONFIG",
      `${name} must not contain credentials, a query string, or a fragment.`,
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href.replace(/\/$/, "");
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new StorageError("INVALID_CONFIG", `${name} is required.`);
  }
  return value.trim();
}

function requireInputString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new StorageError("INVALID_INPUT", `${name} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new StorageError("INVALID_CONFIG", `${name} must be a positive integer.`);
  }
  return value as number;
}

function requireExpiry(value: unknown, name: string): number {
  const seconds = requirePositiveInteger(value, name);
  if (seconds > 7 * 24 * 60 * 60) {
    throw new StorageError("INVALID_CONFIG", `${name} must not exceed 7 days.`);
  }
  return seconds;
}

function normalizeExtension(value: string): string {
  return typeof value === "string" ? value.replace(/^\./, "").trim().toLowerCase() : "";
}

function isUploadFile(value: unknown): value is UploadFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function"
  );
}

function getExtension(filename: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return match ? normalizeExtension(match[1]) : "";
}

function expectedMimeForExtension(extension: string): string | undefined {
  const mime = lookupMimeType(`file.${extension}`);
  return typeof mime === "string" ? normalizeMime(mime) : undefined;
}

function normalizeMime(value: unknown): string {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
}

function mimeMatches(left: string, right: string): boolean {
  return normalizeMime(left) === normalizeMime(right);
}

function extensionsMatch(declared: string, detected: string, body: Buffer): boolean {
  if (declared === detected) return true;
  if ((declared === "jpg" || declared === "jpeg") && detected === "jpg") return true;
  if (declared === "apng" && detected === "png") return body.includes(Buffer.from("acTL"));
  return false;
}

function detectedMimeMatches(extension: string, declaredMime: string, detectedMime: string): boolean {
  if (extension === "apng" && normalizeMime(detectedMime) === "image/png") {
    return normalizeMime(declaredMime) === "image/apng";
  }
  return mimeMatches(declaredMime, detectedMime);
}

function isValidUtf8Text(body: Buffer): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    for (const character of text) {
      const code = character.codePointAt(0)!;
      if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function encodeObjectKey(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isDatePath(year: string, month: string, day: string): boolean {
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) return false;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

function getDatePath(): string {
  const now = new Date();
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("/");
}

function requireEtag(value: string | undefined): string {
  if (!value) throw new StorageError("OBJECT_MISMATCH", "The pending object has no ETag.");
  return value;
}

function isNotFound(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    value?.$metadata?.httpStatusCode === 404 ||
    value?.name === "NotFound" ||
    value?.name === "NoSuchKey"
  );
}

function isPreconditionFailure(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value?.$metadata?.httpStatusCode === 412 || value?.name === "PreconditionFailed";
}

function storageOperationError(message: string, cause: unknown): StorageError {
  if (cause instanceof StorageError) return cause;
  return new StorageError("STORAGE_ERROR", message, { cause });
}

function shouldDeleteRejectedPending(error: unknown): boolean {
  return (
    error instanceof StorageError &&
    (error.code === "UNSUPPORTED_FILE" ||
      (error.code === "OBJECT_MISMATCH" &&
        (error.cause === undefined || isPreconditionFailure(error.cause))))
  );
}
