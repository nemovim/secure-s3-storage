# secure-s3-storage

[![npm version](https://img.shields.io/npm/v/secure-s3-storage.svg)](https://www.npmjs.com/package/secure-s3-storage)

[한국어 README](https://github.com/nemovim/secure-s3-storage/blob/main/README.md)

A server-only file upload library for S3-compatible storage such as AWS S3,
Cloudflare R2, and Supabase Storage.

- Keep the same API when switching providers.
- Validate the extension, Content-Type, size, and actual file contents.
- Enforce allowed extensions for each category.
- Store files as `<category>/YYYY/MM/DD/<uuid>.<ext>`.
- Support both server uploads and direct browser uploads.

> This package blocks file-type spoofing. It does not replace malware scanning.

## Install

```bash
npm install secure-s3-storage
```

Node.js 22 or newer is required.

## Configure

```dotenv
STORAGE_BUCKET=example-assets
STORAGE_ENDPOINT=https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com
STORAGE_PUBLIC_BASE_URL=https://files.example.com
STORAGE_REGION=auto
STORAGE_ACCESS_KEY_ID=
STORAGE_SECRET_ACCESS_KEY=
STORAGE_SESSION_TOKEN=
STORAGE_SIGNING_SECRET=
STORAGE_FORCE_PATH_STYLE=false
```

```ts
import { createStorage } from "secure-s3-storage";

export const storage = createStorage({
  bucket: process.env.STORAGE_BUCKET!,
  endpoint: process.env.STORAGE_ENDPOINT!,
  publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL!,
  region: process.env.STORAGE_REGION!,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
    sessionToken: process.env.STORAGE_SESSION_TOKEN || undefined,
  },
  signingSecret: process.env.STORAGE_SIGNING_SECRET!,
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",
  maxFileSize: 20 * 1024 * 1024,
  categories: {
    images: ["jpg", "jpeg", "png", "apng", "webp"],
    documents: ["pdf", "txt", "md", "json", "csv", "docx", "xlsx", "pptx"],
  },
});
```

The package does not read environment variables. Set `endpoint` to the S3 API
endpoint without the bucket. Set `publicBaseUrl` to the public file URL before
the object key.

| Provider | `endpoint` | `region` | `forcePathStyle` |
|---|---|---|---|
| AWS S3 | `https://s3.<REGION>.amazonaws.com` | actual region | `false` |
| Cloudflare R2 | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | `auto` | `false` |
| Supabase Storage | `https://<PROJECT_REF>.storage.supabase.co/storage/v1/s3` | project region | `true` |

For Supabase, enable the S3 protocol in Storage settings and use its generated
S3 access keys.

`signingSecret` must differ from the S3 secret access key and contain at least
32 characters.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## Upload flows

| Flow | API |
|---|---|
| Server → Storage | `put()` |
| Client → Server → Storage | `put()` on the server |
| Client → Storage | `presign()` → browser PUT → `complete()` |

### Server → Storage

Pass a `File` directly when the server already has one.

```ts
const object = await storage.put("images", file);
```

Provide the original filename with a `Buffer` or `Uint8Array`. When `contentType`
is omitted, it is derived from the extension.

```ts
const object = await storage.put("images", buffer, {
  filename: "photo.png",
});
```

### Client → Server → Storage

Read the `File` from `multipart/form-data` and pass it to `put()`.

```ts
const formData = await request.formData();
const file = formData.get("file");

if (!(file instanceof File)) throw new Error("File is required");

const object = await storage.put("images", file);
```

In both flows, the server receives and validates the file before storing it.

### Client → Storage

To keep the initial client upload from passing through the server, create an
upload URL in an authenticated server endpoint.

```ts
const upload = await storage.presign("images", {
  filename,
  contentType: contentType || undefined,
  size,
});
```

Upload the file directly from the client.

```ts
const response = await fetch(upload.url, {
  method: upload.method,
  headers: upload.headers,
  body: file,
});

if (!response.ok) throw new Error("Upload failed");
```

Finalize the upload in an authenticated server endpoint.

```ts
const object = await storage.complete(upload.token);
```

The file is temporarily stored at `_pending/<upload-id>`. `complete()` copies it
to the final key only after validating its actual contents. Retrying the same
token returns the same result.
Validation reads the entire pending file into server memory, so set `maxFileSize`
to an appropriate limit for the server environment.

## Remove files and build public URLs

```ts
await storage.remove(object.key);

const url = storage.getUrl(object.key);
```

`getUrl()` combines `publicBaseUrl` with the object key. It does not create signed
URLs for private objects.

## Handle errors

```ts
import { StorageError } from "secure-s3-storage";

try {
  await storage.complete(token);
} catch (error) {
  if (error instanceof StorageError) {
    console.error(error.code, error.message);
  }
}
```

```text
INVALID_CONFIG      INVALID_INPUT       INVALID_TOKEN
UPLOAD_EXPIRED      UNSUPPORTED_FILE    OBJECT_NOT_FOUND
OBJECT_MISMATCH     OBJECT_CONFLICT     STORAGE_ERROR
```

The underlying cause of storage authentication, network, and provider failures
is preserved in `error.cause`.

## Required setup for browser uploads

- Allow the application origin, `PUT`, and `Content-Type` in bucket CORS.
- Add a lifecycle rule that deletes abandoned `_pending/` objects.
- Block public access to `/_pending/*`.
- Authenticate the server endpoints that call `presign()` and `complete()`.
- Persist the object key only after `complete()` succeeds.
