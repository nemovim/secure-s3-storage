# secure-s3-storage

[![npm version](https://img.shields.io/npm/v/secure-s3-storage.svg)](https://www.npmjs.com/package/secure-s3-storage)

[English README](https://github.com/nemovim/secure-s3-storage/blob/main/README.en.md)

AWS S3, Cloudflare R2, Supabase Storage 등 S3 호환 스토리지를 위한 서버 전용 파일
업로드 라이브러리입니다.

- provider 설정만 바꿔 같은 API를 사용합니다.
- 파일의 확장자, Content-Type, 크기, 실제 내용을 함께 검증합니다.
- category별 허용 확장자를 강제합니다.
- 파일을 `<category>/YYYY/MM/DD/<uuid>.<ext>` 형태로 정리합니다.
- 서버 업로드와 브라우저 직접 업로드를 모두 지원합니다.

> 파일 형식 위장을 차단하지만 악성코드 검사를 대신하지는 않습니다.

## 설치

```bash
npm install secure-s3-storage
```

Node.js 22 이상이 필요합니다.

## 설정

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

패키지는 환경변수를 직접 읽지 않습니다. `endpoint`에는 bucket을 포함하지 않은 S3 API
주소를, `publicBaseUrl`에는 공개 파일 URL에서 object key 앞까지의 주소를 입력합니다.

| Provider | `endpoint` | `region` | `forcePathStyle` |
|---|---|---|---|
| AWS S3 | `https://s3.<REGION>.amazonaws.com` | 실제 region | `false` |
| Cloudflare R2 | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | `auto` | `false` |
| Supabase Storage | `https://<PROJECT_REF>.storage.supabase.co/storage/v1/s3` | project region | `true` |

Supabase는 Storage 설정에서 S3 protocol을 활성화하고 발급된 S3 access key를 사용합니다.

`signingSecret`은 S3 secret access key와 다른 값이어야 하며 32자 이상이어야 합니다.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 업로드 방식

| 흐름 | API |
|---|---|
| Server → Storage | `put()` |
| Client → Server → Storage | 서버에서 `put()` |
| Client → Storage | `presign()` → 브라우저 PUT → `complete()` |

### Server → Storage

서버가 `File`을 가지고 있다면 그대로 전달합니다.

```ts
const object = await storage.put("images", file);
```

`Buffer`나 `Uint8Array`에는 원본 filename을 함께 전달합니다. `contentType`을 생략하면
확장자에서 결정합니다.

```ts
const object = await storage.put("images", buffer, {
  filename: "photo.png",
});
```

### Client → Server → Storage

클라이언트가 보낸 `multipart/form-data`에서 `File`을 꺼내 `put()`에 전달합니다.

```ts
const formData = await request.formData();
const file = formData.get("file");

if (!(file instanceof File)) throw new Error("File is required");

const object = await storage.put("images", file);
```

두 방식 모두 서버가 파일을 받은 후 검증하여 스토리지에 저장합니다.

### Client → Storage

클라이언트의 최초 업로드 요청이 서버를 거치지 않게 하려면 인증된 서버 API에서 업로드
URL을 발급합니다.

```ts
const upload = await storage.presign("images", {
  filename,
  contentType: contentType || undefined,
  size,
});
```

클라이언트는 반환된 URL에 파일을 직접 업로드합니다.

```ts
const response = await fetch(upload.url, {
  method: upload.method,
  headers: upload.headers,
  body: file,
});

if (!response.ok) throw new Error("Upload failed");
```

업로드 후 인증된 서버 API에서 파일을 검증하고 확정합니다.

```ts
const object = await storage.complete(upload.token);
```

파일은 `_pending/<upload-id>`에 임시 저장됩니다. `complete()`가 실제 내용을 검증한 후에만
최종 경로로 복사하며, 같은 token을 다시 전달하면 같은 결과를 반환합니다.
검증 과정에서는 임시 파일 전체를 서버 메모리로 읽으므로 `maxFileSize`를 서버 환경에
맞게 설정해야 합니다.

## 삭제와 공개 URL

```ts
await storage.remove(object.key);

const url = storage.getUrl(object.key);
```

`getUrl()`은 `publicBaseUrl`과 object key를 결합합니다. Private object용 signed URL은
생성하지 않습니다.

## 오류 처리

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

스토리지 인증·네트워크·provider 오류의 원인은 `error.cause`에 보존됩니다.

## 브라우저 업로드에 필요한 설정

- bucket CORS에서 애플리케이션 origin, `PUT`, `Content-Type`을 허용합니다.
- `_pending/` 객체를 자동 삭제하는 lifecycle rule을 설정합니다.
- 공개 domain에서 `/_pending/*` 접근을 차단합니다.
- `presign()`과 `complete()`을 호출하는 서버 API를 인증합니다.
- `complete()` 성공 후에만 object key를 DB에 저장합니다.
