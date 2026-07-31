# secure-s3-storage

[English README](./README.en.md)

S3 호환 스토리지를 위한 파일 업로드 모듈입니다.

- 애플리케이션 코드는 유지하고 환경변수만 바꿔 AWS S3, Cloudflare R2,
  Supabase Storage 사이를 전환합니다.
- 파일 내용과 확장자를 자동으로 비교해 잘못되거나 위험한 파일을 차단합니다.
- category별 허용 확장자를 지정해 업로드 가능한 파일 형식을 강제합니다.
- 파일명을 UUID로 바꾸고 날짜별 경로에 저장합니다.
- 업로드, 삭제, 공개 URL 생성만으로 간단하게 사용할 수 있습니다.

생성되는 object key:

```text
<category>/YYYY/MM/DD/<uuid>.<ext>
```

## 설치

```bash
npm install secure-s3-storage
```

## 사용법

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

`endpoint`와 `publicBaseUrl`에는 bucket까지 포함된 정확한 base URL을 입력합니다.
API endpoint와 공개 URL은 provider에 따라 다를 수 있습니다.

## Provider 설정

애플리케이션 코드는 바꾸지 않고 다음 환경변수만 교체합니다.

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

Supabase dashboard에서 S3 protocol을 활성화한 뒤 표시되는 region과 access key를
사용합니다. 공개 URL은 public bucket에서만 접근할 수 있습니다.

```dotenv
STORAGE_BUCKET=public-assets
STORAGE_ENDPOINT=https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3/public-assets
STORAGE_PUBLIC_BASE_URL=https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/public-assets
STORAGE_REGION=ap-northeast-1
STORAGE_ACCESS_KEY_ID=replace-with-supabase-s3-access-key-id
STORAGE_SECRET_ACCESS_KEY=replace-with-supabase-s3-secret-access-key
```

## API

### 업로드

```ts
await storage.upload(file);
await storage.put(category, buffer, contentType);
```

- `upload()`은 브라우저 `File`과 호환되는 객체를 업로드합니다.
- `put()`은 서버의 `Buffer`를 지정한 category에 업로드합니다.
- 두 함수 모두 파일을 검증하고 `UploadResult`를 반환합니다.

### 삭제

```ts
await storage.remove(key);
```

### 공개 URL 생성

```ts
const url = storage.getUrl(key);
```

`getUrl()`은 `publicBaseUrl`과 인코딩된 key를 결합합니다. Private bucket을 위한
signed URL은 생성하지 않습니다.

## 검증 규칙

- 실제 파일 내용과 확장자를 함께 확인합니다.
- category에 등록되지 않은 확장자를 차단합니다.
- 실행 파일과 script 계열 확장자를 차단합니다.
- 잘못된 경로 segment와 path traversal을 차단합니다.
- 검증 실패 시 `StorageValidationError`가 발생합니다.

```ts
type UploadResult = {
  bucket: string;
  key: string;
  filename: string;
  extension: string;
  contentType: string;
};
```
