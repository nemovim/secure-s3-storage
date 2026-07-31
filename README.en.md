# secure-s3-storage

File uploads for S3-compatible storage.

- Switch between AWS S3, Cloudflare R2, and Supabase Storage by changing
  environment variables instead of application code.
- Validate file contents and extensions automatically.
- Enforce allowed extensions for each category.
- Store files under organized date-based paths with UUID filenames.
- Keep the public API focused on upload, removal, and public URL generation.

Generated object keys:

```text
<category>/YYYY/MM/DD/<uuid>.<ext>
```

## Install

```bash
npm install secure-s3-storage
```

## Usage

```ts
import { readFile } from "node:fs/promises";
import { initStorage } from "secure-s3-storage";

const storage = initStorage({
  bucket: process.env.STORAGE_BUCKET!,
  endpoint: process.env.STORAGE_ENDPOINT!,
  publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL!,
  region: process.env.STORAGE_REGION!,
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
  sessionToken: process.env.STORAGE_SESSION_TOKEN || undefined,
  categories: {
    images: ["jpg", "jpeg", "png", "webp"],
    documents: ["pdf", "txt", "md"],
  },
});

const uploaded = await storage.put(
  "images",
  await readFile("./avatar.png"),
  "image/png",
);

console.log(uploaded.key);
console.log(storage.getUrl(uploaded.key));

await storage.remove(uploaded.key);
```

`endpoint` and `publicBaseUrl` are exact bucket base URLs. They may be different
because an API endpoint is not always a publicly accessible object URL.

## Provider configuration

Keep the application code unchanged and replace only these environment values.

### AWS S3

```dotenv
STORAGE_BUCKET=example-assets
STORAGE_ENDPOINT=https://example-assets.s3.ap-northeast-2.amazonaws.com
STORAGE_PUBLIC_BASE_URL=https://example-assets.s3.ap-northeast-2.amazonaws.com
STORAGE_REGION=ap-northeast-2
STORAGE_ACCESS_KEY_ID=replace-with-aws-access-key-id
STORAGE_SECRET_ACCESS_KEY=replace-with-aws-secret-access-key
```

### Cloudflare R2

```dotenv
STORAGE_BUCKET=example-assets
STORAGE_ENDPOINT=https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/example-assets
STORAGE_PUBLIC_BASE_URL=https://files.example.com
STORAGE_REGION=auto
STORAGE_ACCESS_KEY_ID=replace-with-r2-access-key-id
STORAGE_SECRET_ACCESS_KEY=replace-with-r2-secret-access-key
```

### Supabase Storage

Enable the S3 protocol and copy the region and access keys shown in the Supabase
dashboard. The public URL is accessible only for a public bucket.

```dotenv
STORAGE_BUCKET=public-assets
STORAGE_ENDPOINT=https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3/public-assets
STORAGE_PUBLIC_BASE_URL=https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/public-assets
STORAGE_REGION=ap-northeast-1
STORAGE_ACCESS_KEY_ID=replace-with-supabase-s3-access-key-id
STORAGE_SECRET_ACCESS_KEY=replace-with-supabase-s3-secret-access-key
```

## API

### Upload

```ts
await storage.upload(file);
await storage.put(category, buffer, contentType);
```

- `upload()` accepts a browser `File`-compatible object.
- `put()` uploads a server-side `Buffer` to a selected category.
- Both validate the file and return an `UploadResult`.

### Remove

```ts
await storage.remove(key);
```

### Build a public URL

```ts
const url = storage.getUrl(key);
```

`getUrl()` joins `publicBaseUrl` with the encoded key. It does not create signed
URLs for private buckets.

## Validation

- Checks file contents and extensions together.
- Rejects extensions not configured for the selected category.
- Blocks executable and script-like extensions.
- Rejects invalid path segments and path traversal.
- Throws `StorageValidationError` when validation fails.

```ts
type UploadResult = {
  bucket: string;
  key: string;
  filename: string;
  extension: string;
  contentType: string;
};
```
