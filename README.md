# secure-s3-storage

S3 기반의 안전한 파일 업로드 모듈입니다. 파일 내용을 검증하고, 자동으로 카테고리별로 라우팅하며, 고유한 UUID 파일명과 날짜 기반(YYYY-MM-DD) S3 key를 생성합니다.

## Install

```bash
npm install secure-s3-storage
```

## Quick Start

```ts
import { init } from "secure-s3-storage";
import { readFile } from "node:fs/promises";

const storage = init({
  s3: {
    bucket: "my-bucket",
    region: "ap-northeast-2",
  },
  categories: {
    images: ["jpg", "jpeg", "png", "webp"],
    documents: ["pdf", "txt", "md"],
  },
});

// 1. 브라우저 File 업로드 (사용자 업로드용)
// 성공 시 UploadResult를 반환합니다.
const result = await storage.upload(file);

// 2. 서버 Buffer 업로드
const body = await readFile("./photo.png");
await storage.put("images", body, "image/png");

// 3. 삭제
await storage.remove(result.key);
```

## API

### `init(options)`
스토리지 인스턴스를 생성합니다.
- `options.s3`: `S3ClientConfig` (AWS SDK v3) + `bucket`
- `options.categories`: `{ [categoryName]: [allowedExtensions] }`

### `storage.upload(file)`
브라우저 `File` 객체를 업로드합니다 (엄격한 검증).
- **반환값**: `UploadResult`
- `file`: `{ arrayBuffer(): Promise<ArrayBuffer>; name: string; type?: string }`

### `storage.put(path, body, contentType?)`
서버용. `Buffer`를 직접 업로드합니다.
- **반환값**: `UploadResult`

### `storage.remove(key)`
S3 객체를 삭제합니다. 전체 `key`를 전달하세요.

### `storage.getUrl(key)`
객체의 공개 URL을 생성합니다.

## Validation & Errors

- **검증 방식**: 바이너리 시그니처 판별 및 확장자 일치 확인.
- **차단**: 실행 파일, 스크립트 등 위험 확장자 업로드 차단.
- **`upload` vs `put`**: `upload`는 실제 파일 내용과 파일명 확장자를 대조하여 더 엄격하게 검증합니다.

### Error Handling
모든 검증 실패 시 **`StorageValidationError`**가 발생합니다.
주요 발생 상황:
- 알 수 없는 카테고리 설정
- 허용되지 않은 확장자
- 파일 실제 내용과 이름의 확장자 불일치
- 파일 내용을 판별할 수 없는 경우

## Output Types

### `UploadResult`
`storage.upload()` 또는 `storage.put()` 실행 시 반환되는 결과값입니다.

```ts
{
  bucket: string;
  key: string;       // S3에 저장된 고유 경로 (예: 2026-05-27/images/uuid.ext)
  filename: string;  // 생성된 파일명 (uuid.ext)
  extension: string;
  contentType?: string;
}
```