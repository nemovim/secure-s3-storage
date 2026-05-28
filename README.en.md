# secure-s3-storage

S3-backed file upload module with content validation, category-based paths, UUID filenames, and date-based (`YYYY-MM-DD`) object keys.

## Install

```bash
npm install secure-s3-storage
```

## Quick Start

```ts
import { initStorage, type Storage, type BrowserFile, type UploadResult } from "secure-s3-storage";
import { readFile } from "node:fs/promises";

const storage: Storage = initStorage({
  bucket: "my-bucket",
  region: "ap-northeast-2",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  categories: {
    images: ["jpg", "jpeg", "png", "webp"],
    documents: ["pdf", "txt", "md"],
  },
});

const source = await readFile("./photo.png");
const file: BrowserFile = {
  name: "photo.png",
  type: "image/png",
  arrayBuffer: async () =>
    source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength),
};

const result: UploadResult = await storage.upload(file);

const body = await readFile("./photo.png");
await storage.put("images", body, "image/png");

await storage.remove(result.key);
```

If you use temporary AWS credentials, pass `sessionToken` as well.

```ts
const storage = initStorage({
  bucket: "my-bucket",
  region: "ap-northeast-2",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  sessionToken: process.env.AWS_SESSION_TOKEN!,
  categories: {
    images: ["jpg", "jpeg", "png", "webp"],
    documents: ["pdf", "txt", "md"],
  },
});
```

## API

### `initStorage(options)`

Creates a storage instance.

- `bucket`: S3 bucket name
- `region`: S3 region
- `accessKeyId` / `secretAccessKey`: AWS keys. Passing only one throws an error.
- `sessionToken`: Only needed for temporary AWS credentials.
- `categories`: Mapping of category names to allowed file extensions

Example `categories`:

```ts
{
  images: ["jpg", "jpeg", "png", "webp"],
  documents: ["pdf", "txt", "md"],
}
```

Behavior:

1. The file extension decides which category to use.
2. The category name becomes the S3 key prefix and must be a valid key path segment.
3. Unlisted extensions are rejected with `StorageValidationError`.
4. If the same extension appears in multiple categories, the first one wins.

### `storage.upload(file)`

Uploads a browser `File`.

- Returns: `UploadResult`
- `file`: `{ arrayBuffer(): Promise<ArrayBuffer>; name: string; type?: string }`

### `storage.put(path, body, contentType?)`

Uploads a server-side `Buffer`.

- Returns: `UploadResult`

### `storage.remove(key)`

Deletes an S3 object by full object key.

### `storage.getUrl(key)`

Builds the public URL for an object key.

## Validation And Errors

- Validates file content against the file extension.
- Blocks dangerous executable and script-like extensions.
- `upload()` validates file content and filename together.
- `remove()` and `getUrl()` validate empty keys, normalize separators and repeated slashes, and reject `.` and `..` path segments.

Validation failures throw `StorageValidationError`.

Common error cases:

- Unknown category
- Disallowed extension
- File content does not match the extension
- Empty key, invalid path segments, or path traversal in a key

## Output Types

### `UploadResult`

Return value from `storage.upload()` and `storage.put()`.

```ts
{
  bucket: string;
  key: string;
  filename: string;
  extension: string;
  contentType: string;
}
```
