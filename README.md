# secure-s3-storage

S3 기반 업로드 모듈입니다. 파일 내용을 검사해 확장자를 판별하고, 허용된 카테고리로만 업로드합니다. 업로드 파일명은 자동으로 생성되며, S3 key 앞에는 업로드 날짜(`YYYY-MM-DD`)가 붙습니다.

## Install

```bash
npm install secure-s3-storage
```

## Quick Start

브라우저 `File` 업로드:

```ts
import { init } from "secure-s3-storage";

const storage = init({
  s3: {
    bucket: "my-bucket",
    region: "ap-northeast-2",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  },
  categories: {
    images: ["jpg", "jpeg", "png", "webp"],
    documents: ["pdf", "txt", "md"],
  },
});

const result = await storage.upload({ file });
console.log(storage.getUrl(result.key));
// → https://my-bucket.s3.ap-northeast-2.amazonaws.com/2026-05-27/images/550e8400-....png
```

서버 `Buffer` 업로드:

```ts
import { init } from "secure-s3-storage";
import { readFile } from "node:fs/promises";

const storage = init({
  s3: { bucket: "my-bucket", region: "ap-northeast-2" },
  categories: { images: ["jpg", "jpeg", "png", "webp"] },
});

const body = await readFile("./photo.png");
await storage.put("images", body, "image/png");
```

## API

### `init(options)`

| 옵션 | 설명 |
|------|------|
| `s3` | `S3ClientConfig` + `bucket`. AWS SDK v3 설정을 그대로 전달합니다. |
| `categories` | 카테고리 이름 → 허용 확장자 목록. S3 key prefix로도 사용됩니다. |

카테고리 예시:

```ts
{
  images: ["jpg", "jpeg", "png", "webp"],
  docs: ["pdf", "txt", "md"]
}
```

> 같은 확장자가 여러 카테고리에 중복 설정되면 먼저 정의된 카테고리가 사용됩니다.

### `storage.upload({ file })`

**사용자 업로드에 권장합니다.** 브라우저 `File`을 받아 업로드합니다.

- 파일 내용으로 실제 확장자를 판별하고, 파일명에 적힌 확장자와 다르면 거부합니다.
- 확장자에 맞는 카테고리를 자동 선택합니다.
- 저장 파일명은 항상 `uuid.ext` 형식으로 새로 생성됩니다.

`file` 타입:

```ts
{ arrayBuffer(): Promise<ArrayBuffer>; name: string; type?: string }
```

### `storage.put(path, body, contentType?)`

서버 측에서 `Buffer`를 직접 업로드할 때 사용합니다. 카테고리를 직접 지정합니다.

- 바이너리 시그니처로 확장자를 판별하며, 판별이 어려우면 `contentType`을 보조로 사용합니다.
- ⚠️ `upload()`보다 검증이 느슨하므로 신뢰할 수 있는 서버 코드에서만 사용하세요.

### `storage.remove({ path, key })`

S3 객체를 삭제합니다.

```ts
await storage.remove({ path: "images", key: "2026-05-27/images/550e8400-....png" });
```

- `key`에 카테고리 prefix가 빠져 있으면 자동으로 붙입니다.
- `..` 같은 경로 이동 문자열은 허용하지 않습니다.

### `storage.getUrl(key)`

S3 객체의 공개 URL을 반환합니다.

- `region === "us-east-1"` → `https://{bucket}.s3.amazonaws.com/{key}`
- 그 외 리전 → `https://{bucket}.s3.{region}.amazonaws.com/{key}`

## Validation

### 업로드 허용 방식

1. **확장자 판별** – 바이너리 파일은 `file-type`으로 실제 포맷을 검사합니다.
2. **텍스트 파일 처리** – `csv`, `json`, `md`, `txt`, `yml`, `yaml`은 UTF-8 텍스트로 보이면 허용합니다.
3. **위험 확장자 차단** – 실행 파일, 스크립트, 웹 문서 등은 업로드할 수 없습니다. (전체 목록: `src/index.ts` 하단)
4. **카테고리 검사** – 허용된 확장자 목록에 없는 파일은 업로드할 수 없습니다.

### `upload()` vs `put()` 검증 차이

| | `upload()` | `put()` |
|---|---|---|
| 입력 | 브라우저 `File` | 서버 `Buffer` |
| 카테고리 선택 | 자동 | 수동 지정 |
| 내용-확장자 불일치 검사 | ✅ 엄격하게 검사 | ⚠️ 느슨함 |
| 텍스트 파일 검증 | ✅ 수행 | ❌ 미수행 |
| 권장 용도 | 사용자 업로드 | 서버 내부 처리 |

## Return Value

`upload()`와 `put()`은 동일한 형태를 반환합니다.

```ts
type UploadResult = {
  bucket: string;
  key: string;       // "2026-05-27/images/550e8400-....png"
  filename: string;  // "550e8400-....png"
  extension: string;
  contentType?: string;
};
```

## Error Handling

검증 실패 시 `StorageValidationError`가 발생합니다.

예시:
- 알 수 없는 카테고리
- 허용되지 않은 확장자
- 파일 내용과 확장자가 불일치
- 확장자를 판별할 수 없음
- key에 경로 이동 문자열 포함