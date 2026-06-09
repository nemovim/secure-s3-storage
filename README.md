# secure-s3-storage

[English README](./README.en.md)

S3 기반 파일 업로드 모듈입니다. 파일 내용을 검증하고, 카테고리별 경로로 업로드하며, `<category-prefix>/YYYY/MM/DD/<uuid>.<ext>` 형태의 object key를 생성합니다.

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

임시 AWS credential을 쓰는 경우에는 `sessionToken`도 함께 넣으면 됩니다.

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

스토리지 인스턴스를 생성합니다.

- `bucket`: S3 버킷 이름
- `region`: S3 리전
- `accessKeyId` / `secretAccessKey`: AWS key입니다. 둘 중 하나만 넣으면 에러가 발생합니다.
- `sessionToken`: 임시 AWS credential을 사용할 때만 필요합니다.
- `categories`: 카테고리 이름과 허용할 확장자 목록입니다.

`categories` 예시:

```ts
{
  images: ["jpg", "jpeg", "png", "webp"],
  documents: ["pdf", "txt", "md"],
}
```

동작 방식:

1. 파일 확장자를 기준으로 업로드할 카테고리를 결정합니다.
2. 카테고리 이름이 S3 key prefix로 사용되며, 유효한 key path segment 형태여야 합니다.
3. 허용되지 않은 확장자는 `StorageValidationError`와 함께 차단됩니다.
4. 같은 확장자가 여러 카테고리에 있으면 먼저 정의한 카테고리를 사용합니다.

생성되는 key 예시는 `images/2026/06/09/550e8400-e29b-41d4-a716-446655440000.png` 입니다.

### `storage.upload(file)`

브라우저 `File` 객체를 업로드합니다.

- 반환값: `UploadResult`
- `file`: `{ arrayBuffer(): Promise<ArrayBuffer>; name: string; type?: string }`

### `storage.put(path, body, contentType?)`

서버에서 `Buffer`를 직접 업로드합니다.

- 반환값: `UploadResult`

### `storage.remove(key)`

`upload()` 또는 `put()`이 반환한 생성된 object key를 받아 S3 객체를 삭제합니다.

### `storage.getUrl(key)`

`upload()` 또는 `put()`이 반환한 생성된 object key 기준으로 공개 URL을 생성합니다.

## Validation And Errors

- 파일 내용과 확장자를 비교해 검증합니다.
- 실행 파일, 스크립트 같은 위험한 확장자는 차단합니다.
- `upload()`는 파일 내용과 파일명까지 함께 보고 더 엄격하게 검증합니다.
- `remove()`와 `getUrl()`은 빈 key를 막고, 경로 구분자와 중복 슬래시를 정규화하며, `.` 및 `..` 경로 세그먼트를 검증합니다.

검증에 실패하면 `StorageValidationError`가 발생합니다.

주요 에러 상황:

- 알 수 없는 카테고리
- 허용되지 않은 확장자
- 파일 내용과 확장자가 맞지 않는 경우
- key가 비어 있거나 잘못된 path segment 또는 path traversal이 포함된 경우

## Output Types

### `UploadResult`

`storage.upload()`와 `storage.put()`의 반환값입니다.

```ts
{
  bucket: string;
  key: string;
  filename: string;
  extension: string;
  contentType: string;
}
```
