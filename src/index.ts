import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { lookup as lookupMimeType, extension as mimeExtension } from "mime-types";

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

export type StorageInitOptions = {
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
} & Omit<S3ClientConfig, "credentials"> & {
  categories: Record<string, string[]>;
};

export type BrowserFile = { arrayBuffer(): Promise<ArrayBuffer>; name: string; type?: string };

export type UploadResult = {
  bucket: string;
  key: string;
  filename: string;
  extension: string;
  contentType: string;
};

export type Storage = {
  put(path: string, file: Buffer, contentType?: string): Promise<UploadResult>;
  upload(file: BrowserFile): Promise<UploadResult>;
  remove(key: string): Promise<void>;
  getUrl(key: string): string;
};
type PathConfig = { prefix: string; allowedExtensions: Set<string> };

export class StorageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageValidationError";
  }
}

export function initStorage(options: StorageInitOptions): Storage {
  const {
    bucket,
    categories,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    ...s3Config
  } = options;

  const normalizedAccessKeyId = typeof accessKeyId === "string" ? accessKeyId.trim() : undefined;
  const normalizedSecretAccessKey =
    typeof secretAccessKey === "string" ? secretAccessKey.trim() : undefined;
  const normalizedSessionToken = typeof sessionToken === "string" ? sessionToken.trim() : undefined;

  const hasAccessKeyId = typeof normalizedAccessKeyId === "string" && normalizedAccessKeyId.length > 0;
  const hasSecretAccessKey =
    typeof normalizedSecretAccessKey === "string" && normalizedSecretAccessKey.length > 0;

  if (hasAccessKeyId !== hasSecretAccessKey) {
    throw new StorageValidationError(
      "accessKeyId and secretAccessKey must be provided together.",
    );
  }

  const client = new S3Client({
    ...s3Config,
    ...(hasAccessKeyId && hasSecretAccessKey
      ? {
          credentials: {
            accessKeyId: normalizedAccessKeyId,
            secretAccessKey: normalizedSecretAccessKey,
            ...(normalizedSessionToken ? { sessionToken: normalizedSessionToken } : {}),
          },
        }
      : {}),
  });
  const normalizedPaths = normalizePathConfigs(categories);
  const region = s3Config.region || 'us-east-1';
  const extensionToPath = new Map<string, string>();
  for (const [name, cfg] of Object.entries(normalizedPaths)) {
    for (const ext of cfg.allowedExtensions) {
      if (!extensionToPath.has(ext)) extensionToPath.set(ext, name);
    }
  }

  async function put(path: string, file: Buffer, contentType?: string): Promise<UploadResult> {
    const config = getPathConfig(normalizedPaths, path);

    const detected = await fileTypeFromBuffer(file);
    let extension = detected?.ext || "";
    if (!extension && contentType) {
      const fromMime = mimeExtension(contentType);
      if (typeof fromMime === "string") {
        extension = fromMime;
      }
    }

    if (!extension) {
      throw new StorageValidationError("Could not determine file extension for put().");
    }

    if (DANGEROUS_EXTENSIONS.has(extension)) {
      throw new StorageValidationError(`Files with .${extension} extension are blocked.`);
    }

    if (!config.allowedExtensions.has(extension)) {
      throw new StorageValidationError(`.${extension} is not allowed for this storage path.`);
    }

    const filename = buildGeneratedFilename(extension);
    const datedPrefix = buildDatedPrefix(config.prefix);
    const key = buildObjectKey(datedPrefix, filename);
    const finalContentType =
      contentType ?? detected?.mime ?? getContentTypeFromFilename(filename) ?? "application/octet-stream";

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file,
        ContentType: finalContentType,
      }),
    );

    return {
      bucket,
      key,
      filename,
      extension,
      contentType: finalContentType,
    };
  }

  async function upload(file: BrowserFile): Promise<UploadResult> {
    const normalized = await normalizeUploadFile(file);
    const extension = normalized.filename ? getExtension(normalized.filename) : "";

    if (!extension) {
      throw new StorageValidationError(
        "Could not determine file extension for upload(). Provide a File with a filename or detectable content.",
      );
    }

    const pathName = extensionToPath.get(extension);
    if (!pathName) {
      throw new StorageValidationError(`No storage path configured for .${extension} files.`);
    }

    const config = getPathConfig(normalizedPaths, pathName);
    const resolved = await resolveUploadTarget({
      allowedExtensions: config.allowedExtensions,
      body: normalized.body,
      requestedFilename: normalized.filename,
      sourceFilename: normalized.filename,
      sourceContentType: normalized.contentType,
    });

    const datedPrefix = buildDatedPrefix(config.prefix);
    const key = buildObjectKey(datedPrefix, resolved.filename);

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: normalized.body,
        ContentType: resolved.contentType,
      }),
    );

    return {
      bucket,
      key,
      filename: resolved.filename,
      extension: resolved.extension,
      contentType: resolved.contentType,
    };
  }

  async function remove(key: string): Promise<void> {
    const normalizedKey = normalizeStoredObjectKeyInput(key);

    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: normalizedKey,
      }),
    );
  }

  function getUrl(key: string) {
    const normalizedKey = normalizeStoredObjectKeyInput(key);
    const endpoint = region === 'us-east-1'
      ? `https://${bucket}.s3.amazonaws.com`
      : `https://${bucket}.s3.${region}.amazonaws.com`;
    return `${endpoint}/${encodeObjectKey(normalizedKey)}`;
  }

  return {
    put,
    upload,
    remove,
    getUrl,
  };
}

function normalizePathConfigs(
  categories: Record<string, string[]>,
): Record<string, PathConfig> {
  return Object.fromEntries(
    Object.entries(categories).map(([name, extensions]) => [
      name,
      {
        prefix: normalizeCategoryPrefix(name),
        allowedExtensions: new Set(extensions.map(normalizeExtension)),
      },
    ]),
  );
}

function getPathConfig(
  paths: Record<string, PathConfig>,
  path: string,
) {
  const config = paths[path];
  if (!config) {
    throw new StorageValidationError(`Unknown storage path: ${path}`);
  }
  return config;
}

async function resolveUploadTarget(input: {
  allowedExtensions: Set<string>;
  body: Buffer;
  requestedFilename?: string;
  sourceFilename?: string;
  sourceContentType?: string;
}) {
  const requestedExtension = input.requestedFilename
    ? getExtension(input.requestedFilename)
    : "";
  const sourceExtension = input.sourceFilename ? getExtension(input.sourceFilename) : "";
  const detected = await fileTypeFromBuffer(input.body);
  const extension = detected?.ext || requestedExtension || sourceExtension;

  if (!extension) {
    throw new StorageValidationError(
      "Could not determine file extension. Pass a File object or provide filename explicitly.",
    );
  }

  if (DANGEROUS_EXTENSIONS.has(extension)) {
    throw new StorageValidationError(`Files with .${extension} extension are blocked.`);
  }

  if (!input.allowedExtensions.has(extension)) {
    throw new StorageValidationError(`.${extension} is not allowed for this storage path.`);
  }

  if (detected) {
    if (requestedExtension && requestedExtension !== detected.ext) {
      throw new StorageValidationError(
        `File content does not match the requested extension .${requestedExtension}.`,
      );
    }

    if (sourceExtension && sourceExtension !== detected.ext) {
      throw new StorageValidationError(
        `File content does not match the source extension .${sourceExtension}.`,
      );
    }

    const expectedMime = getContentTypeFromFilename(`file.${extension}`);
    if (expectedMime && detected.mime !== expectedMime) {
      throw new StorageValidationError(
        `File content does not match the expected MIME type for .${extension}.`,
      );
    }

    return {
      extension,
      filename: buildGeneratedFilename(extension),
      contentType: detected.mime,
    };
  }

  if (TEXT_EXTENSIONS.has(extension) && isLikelyUtf8Text(input.body)) {
    return {
      extension,
      filename: buildGeneratedFilename(extension),
      contentType:
        input.sourceContentType ??
        getContentTypeFromFilename(`file.${extension}`) ??
        "application/octet-stream",
    };
  }

  throw new StorageValidationError(`Unable to validate file contents for .${extension}.`);
}

function buildObjectKey(prefix: string, filename: string, customKey?: string) {
  const target = customKey ? customKey.trim() : sanitizeFilename(filename);
  if (!target) {
    throw new StorageValidationError("A valid filename or key is required.");
  }

  const normalizedTarget = normalizeObjectKeyInput(target);
  return ensureKeyInsidePrefix(prefix, normalizedTarget);
}

function ensureKeyInsidePrefix(prefix: string, key: string) {
  const normalizedKey = normalizeObjectKeyInput(key);

  if (!prefix) {
    return normalizedKey;
  }

  if (normalizedKey === prefix || normalizedKey.startsWith(`${prefix}/`)) {
    return normalizedKey;
  }

  return `${prefix}/${normalizedKey}`;
}

function normalizeCategoryPrefix(prefix: string) {
  const normalizedPrefix = normalizeObjectKeyInput(prefix);
  if (normalizedPrefix === ".") {
    throw new StorageValidationError("Category prefix must not be a current-directory segment.");
  }
  return normalizedPrefix;
}

function normalizeObjectKeyInput(key: string) {
  const collapsedKey = stripLeadingSlash(key.trim().replace(/\\/g, "/")).replace(/\/+/g, "/");
  if (!collapsedKey) {
    throw new StorageValidationError("Object key is required.");
  }

  const segments = collapsedKey.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new StorageValidationError("Object key contains invalid path segments.");
  }

  return segments.join("/");
}

function normalizeStoredObjectKeyInput(key: string) {
  const normalizedKey = normalizeObjectKeyInput(key);
  const segments = normalizedKey.split("/");

  if (segments.length < 5) {
    throw new StorageValidationError(
      "Object key must match <category-prefix>/YYYY/MM/DD/<filename>.",
    );
  }

  const year = segments[segments.length - 4];
  const month = segments[segments.length - 3];
  const day = segments[segments.length - 2];

  if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month) || !/^(0[1-9]|[12]\d|3[01])$/.test(day)) {
    throw new StorageValidationError(
      "Object key must match <category-prefix>/YYYY/MM/DD/<filename>.",
    );
  }

  return normalizedKey;
}

function stripLeadingSlash(value: string) {
  return value.replace(/^\/+/, "");
}

function getExtension(filename: string) {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return match ? normalizeExtension(match[1]) : "";
}

function normalizeExtension(extension: string) {
  return extension.replace(/^\./, "").trim().toLowerCase();
}

function sanitizeFilename(filename: string) {
  return filename
    .trim()
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/\/+/g, "-");
}

function encodeObjectKey(key: string) {
  return stripLeadingSlash(key)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function getContentTypeFromFilename(filename: string) {
  const mime = lookupMimeType(filename);
  return typeof mime === "string" ? mime : undefined;
}

async function normalizeUploadFile(file: BrowserFile) {
  const body = Buffer.from(await file.arrayBuffer());
  const contentType = file.type || undefined;
  const filename = typeof file.name === "string" ? file.name : undefined;

  return { body, filename, contentType };
}

function isLikelyUtf8Text(buffer: Buffer) {
  if (buffer.length === 0) {
    return true;
  }

  let suspicious = 0;

  for (const byte of buffer) {
    const isControl = byte < 0x09 || (byte > 0x0d && byte < 0x20);
    if (isControl) {
      suspicious += 1;
    }
  }

  return suspicious / buffer.length < 0.02;
}

function buildGeneratedFilename(extension: string) {
  return `${randomUUID()}.${extension}`;
}

function buildDatedPrefix(prefix: string) {
  return `${prefix}/${getDatePath()}`;
}

function getDatePath() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  return `${year}/${month}/${date}`;
}
