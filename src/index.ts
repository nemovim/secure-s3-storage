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
  s3: S3ClientConfig & {
    bucket: string;
  };
  categories: Record<string, string[]>;
};

export type BrowserFile = { arrayBuffer(): Promise<ArrayBuffer>; name: string; type?: string };

export type UploadArgs = {
  file: BrowserFile;
};

export type RemoveInput = {
  path: string;
  key: string;
};

export type UploadResult = {
  bucket: string;
  key: string;
  filename: string;
  extension: string;
  contentType?: string;
};

export type Storage = ReturnType<typeof init>;

export class StorageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageValidationError";
  }
}

export function init(options: StorageInitOptions) {
  const { bucket, ...s3Config } = options.s3;
  const client = new S3Client(s3Config);
  const normalizedPaths = normalizePathConfigs(options.categories);
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

    if (!config.allowedExtensions.includes(extension)) {
      throw new StorageValidationError(`.${extension} is not allowed for this storage path.`);
    }

    const filename = buildGeneratedFilename(extension);
    const datePrefix = getDatePrefix();
    const prefixWithDate = `${datePrefix}/${config.prefix}`;
    const key = buildObjectKey(prefixWithDate, filename);
    const finalContentType = contentType ?? detected?.mime ?? getContentTypeFromFilename(filename);

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

  async function upload(args: UploadArgs): Promise<UploadResult> {
    const { file } = args;
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

    const datePrefix = getDatePrefix();
    const prefixWithDate = `${datePrefix}/${config.prefix}`;
    const key = buildObjectKey(prefixWithDate, resolved.filename);

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

  async function remove(input: RemoveInput): Promise<void> {
    const config = getPathConfig(normalizedPaths, input.path);
    const key = ensureKeyInsideDatedPrefix(config.prefix, input.key);

    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
  }

  function getUrl(key: string) {
    const endpoint = region === 'us-east-1'
      ? `https://${bucket}.s3.amazonaws.com`
      : `https://${bucket}.s3.${region}.amazonaws.com`;
    return `${endpoint}/${encodeObjectKey(key)}`;
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
): Record<string, { prefix: string; allowedExtensions: string[] }> {
  return Object.fromEntries(
    Object.entries(categories).map(([name, extensions]) => [
      name,
      {
        prefix: name,
        allowedExtensions: extensions.map(normalizeExtension),
      },
    ]),
  );
}

function getPathConfig(
  paths: Record<string, { prefix: string; allowedExtensions: string[] }>,
  path: string,
) {
  const config = paths[path];
  if (!config) {
    throw new StorageValidationError(`Unknown storage path: ${path}`);
  }
  return config;
}

async function resolveUploadTarget(input: {
  allowedExtensions: string[];
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

  if (!input.allowedExtensions.includes(extension)) {
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
      contentType: input.sourceContentType ?? getContentTypeFromFilename(`file.${extension}`),
    };
  }

  throw new StorageValidationError(`Unable to validate file contents for .${extension}.`);
}

function buildObjectKey(prefix: string, filename: string, customKey?: string) {
  const target = customKey ? customKey.trim() : sanitizeFilename(filename);
  if (!target) {
    throw new StorageValidationError("A valid filename or key is required.");
  }

  const normalizedTarget = stripLeadingSlash(target);
  if (normalizedTarget.includes("..")) {
    throw new StorageValidationError("Object key must not contain path traversal segments.");
  }

  return ensureKeyInsidePrefix(prefix, normalizedTarget);
}

function ensureKeyInsidePrefix(prefix: string, key: string) {
  const normalizedKey = stripLeadingSlash(key.trim());
  if (!normalizedKey) {
    throw new StorageValidationError("Object key is required.");
  }

  if (normalizedKey.includes("..")) {
    throw new StorageValidationError("Object key must not contain path traversal segments.");
  }

  if (!prefix) {
    return normalizedKey;
  }

  if (normalizedKey === prefix || normalizedKey.startsWith(`${prefix}/`)) {
    return normalizedKey;
  }

  return `${prefix}/${normalizedKey}`;
}

function ensureKeyInsideDatedPrefix(prefix: string, key: string) {
  const normalizedKey = stripLeadingSlash(key.trim());
  if (!normalizedKey) {
    throw new StorageValidationError("Object key is required.");
  }

  if (normalizedKey.includes("..")) {
    throw new StorageValidationError("Object key must not contain path traversal segments.");
  }

  if (isKeyInsideDatedPrefix(prefix, normalizedKey)) {
    return normalizedKey;
  }

  if (normalizedKey === prefix || normalizedKey.startsWith(`${prefix}/`)) {
    return `${getDatePrefix()}/${normalizedKey}`;
  }

  return `${getDatePrefix()}/${prefix}/${normalizedKey}`;
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

function isKeyInsideDatedPrefix(prefix: string, key: string) {
  const firstSlashIndex = key.indexOf("/");
  if (firstSlashIndex === -1) {
    return false;
  }

  const datePart = key.slice(0, firstSlashIndex);
  const rest = key.slice(firstSlashIndex + 1);

  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) && rest.startsWith(`${prefix}/`);
}

function getDatePrefix() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${date}`;
}
