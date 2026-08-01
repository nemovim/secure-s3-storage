import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { createStorage, StorageError } from "../dist/index.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const SIGNING_SECRET = "test-signing-secret-that-is-longer-than-32-characters";

function makeConfig(endpoint, overrides = {}) {
  return {
    bucket: "test-bucket",
    endpoint,
    publicBaseUrl: "https://files.example.com",
    region: "auto",
    credentials: {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    },
    signingSecret: SIGNING_SECRET,
    forcePathStyle: true,
    maxFileSize: 1024 * 1024,
    categories: {
      images: ["jpg", "jpeg", "png", "apng", "webp"],
      documents: ["pdf", "txt", "md", "json", "csv", "yml", "yaml", "docx", "xlsx", "pptx"],
    },
    ...overrides,
  };
}

async function createMockS3(t) {
  const objects = new Map();
  const requests = [];
  let afterGet;
  let nextError;
  let copyRequestCount = 0;
  let pendingDeleted;
  let releasePendingDelete;
  let synchronizeFinalHeads = false;
  let finalHeadCount = 0;
  let finalHeadPair;
  let releaseFinalHeadPair;

  const server = createServer(async (request, response) => {
    response.setHeader("connection", "close");
    const url = new URL(request.url, "http://localhost");
    const [, bucket, ...keySegments] = url.pathname.split("/");
    const key = keySegments.map(decodeURIComponent).join("/");
    requests.push({
      method: request.method,
      bucket,
      key,
      headers: { ...request.headers },
      pathname: url.pathname,
    });

    if (nextError) {
      const { status, code } = nextError;
      nextError = undefined;
      return writeS3Error(response, status, code);
    }

    if (request.method === "PUT" && request.headers["x-amz-copy-source"]) {
      copyRequestCount += 1;
      if (copyRequestCount === 2 && pendingDeleted) await pendingDeleted;

      const sourcePath = decodeURIComponent(request.headers["x-amz-copy-source"]).replace(/^\//, "");
      const sourceKey = sourcePath.slice(sourcePath.indexOf("/") + 1);
      const source = objects.get(sourceKey);
      if (!source) return writeS3Error(response, 404, "NoSuchKey");
      if (
        request.headers["x-amz-copy-source-if-match"] &&
        request.headers["x-amz-copy-source-if-match"] !== source.etag
      ) {
        return writeS3Error(response, 412, "PreconditionFailed");
      }

      const copied = {
        body: Buffer.from(source.body),
        contentType: source.contentType,
        etag: source.etag,
        metadata: { ...source.metadata },
      };
      objects.set(key, copied);
      response.writeHead(200, { "content-type": "application/xml" });
      return response.end(
        `<CopyObjectResult><ETag>${copied.etag}</ETag><LastModified>2026-08-01T00:00:00.000Z</LastModified></CopyObjectResult>`,
      );
    }

    if (request.method === "PUT") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const object = {
        body,
        contentType: request.headers["content-type"] || "application/octet-stream",
        etag: etagFor(body),
        metadata: {},
      };
      objects.set(key, object);
      response.writeHead(200, { etag: object.etag });
      return response.end();
    }

    if (request.method === "HEAD") {
      if (synchronizeFinalHeads && !key.startsWith("_pending/")) {
        finalHeadCount += 1;
        if (finalHeadCount % 2 === 1) {
          finalHeadPair = new Promise((resolve) => {
            releaseFinalHeadPair = resolve;
          });
          await finalHeadPair;
        } else {
          if (finalHeadCount === 4) synchronizeFinalHeads = false;
          releaseFinalHeadPair();
        }
      }
      const object = objects.get(key);
      if (!object) return writeS3Error(response, 404, "NoSuchKey");
      const headers = {
        "content-length": String(object.body.length),
        "content-type": object.contentType,
        etag: object.etag,
      };
      for (const [name, value] of Object.entries(object.metadata)) {
        if (value) headers[`x-amz-meta-${name}`] = value;
      }
      response.writeHead(200, headers);
      return response.end();
    }

    if (request.method === "GET") {
      const object = objects.get(key);
      if (!object) return writeS3Error(response, 404, "NoSuchKey");
      if (request.headers["if-match"] && request.headers["if-match"] !== object.etag) {
        return writeS3Error(response, 412, "PreconditionFailed");
      }
      response.writeHead(200, {
        "content-length": String(object.body.length),
        "content-type": object.contentType,
        etag: object.etag,
      });
      response.end(object.body);
      if (afterGet) await afterGet({ key, object, objects });
      return;
    }

    if (request.method === "DELETE") {
      objects.delete(key);
      if (key.startsWith("_pending/")) releasePendingDelete?.();
      response.writeHead(204);
      return response.end();
    }

    return writeS3Error(response, 405, "MethodNotAllowed");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const address = server.address();
  assert(address && typeof address === "object");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    requests,
    setAfterGet(callback) {
      afterGet = callback;
    },
    failNextRequest(status = 500, code = "InternalError") {
      nextError = { status, code };
    },
    forceConcurrentCopyRace() {
      synchronizeFinalHeads = true;
      pendingDeleted = new Promise((resolve) => {
        releasePendingDelete = resolve;
      });
    },
    getCopyRequestCount() {
      return copyRequestCount;
    },
  };
}

function writeS3Error(response, status, code) {
  response.writeHead(status, { "content-type": "application/xml" });
  response.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
}

function etagFor(body) {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}

function assertStorageError(code) {
  return (error) => error instanceof StorageError && error.code === code;
}

test("put validates a file and keeps endpoint and bucket separate", async (t) => {
  const s3 = await createMockS3(t);
  const storage = createStorage(makeConfig(s3.endpoint));

  const object = await storage.put("images", PNG, {
    filename: "avatar.png",
    contentType: "image/png",
  });

  assert.match(object.key, /^images\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]+\.png$/);
  assert.equal(object.size, PNG.length);
  assert.equal(s3.requests.at(-1).bucket, "test-bucket");
  assert.equal(s3.requests.at(-1).key, object.key);
  assert.equal(storage.getUrl(object.key), `https://files.example.com/${object.key}`);
});

test("put accepts a File and derives a missing Content-Type", async (t) => {
  const s3 = await createMockS3(t);
  const storage = createStorage(makeConfig(s3.endpoint));
  const file = {
    name: "avatar.png",
    type: "",
    size: PNG.length,
    async arrayBuffer() {
      return PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength);
    },
  };

  const object = await storage.put("images", file);
  assert.match(object.key, /^images\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]+\.png$/);
  assert.equal(object.contentType, "image/png");
  assert.equal(s3.objects.get(object.key).body.equals(PNG), true);
});

test("presign uploads to pending and complete conditionally copies it", async (t) => {
  const s3 = await createMockS3(t);
  const storage = createStorage(makeConfig(s3.endpoint));
  const upload = await storage.presign("images", {
    filename: "avatar.png",
    size: PNG.length,
  });

  const uploadUrl = new URL(upload.url);
  assert.match(uploadUrl.pathname, /^\/test-bucket\/_pending\/[0-9a-f-]+$/);
  assert.equal(uploadUrl.searchParams.has("x-amz-checksum-crc32"), false);
  assert.equal(upload.method, "PUT");
  assert.deepEqual(upload.headers, { "Content-Type": "image/png" });

  const response = await fetch(upload.url, {
    method: upload.method,
    headers: upload.headers,
    body: PNG,
  });
  assert.equal(response.status, 200);

  const object = await storage.complete(upload.token);
  assert.match(object.key, /^images\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]+\.png$/);
  assert.equal([...s3.objects.keys()].some((key) => key.startsWith("_pending/")), false);
  const claims = JSON.parse(Buffer.from(upload.token.split(".")[0], "base64url").toString("utf8"));
  const objectId = object.key.split("/").at(-1).replace(/\.png$/, "");
  assert.equal(claims.finalKey, object.key);
  assert.equal(uploadUrl.pathname.endsWith(`/_pending/${objectId}`), true);
  assert.deepEqual(Object.keys(claims).sort(), [
    "bucket",
    "contentType",
    "expiresAt",
    "finalKey",
    "size",
    "version",
  ]);

  const getRequest = s3.requests.find((request) => request.method === "GET");
  const copyRequest = s3.requests.find(
    (request) => request.method === "PUT" && request.headers["x-amz-copy-source"],
  );
  assert.equal(getRequest.headers["if-match"], etagFor(PNG));
  assert.equal(copyRequest.headers["x-amz-copy-source-if-match"], etagFor(PNG));
  assert.equal(copyRequest.headers["x-amz-metadata-directive"], undefined);
  assert.equal(copyRequest.headers["x-amz-meta-upload-id"], undefined);

  assert.deepEqual(await storage.complete(upload.token), object);
});

test("concurrent complete calls return the same finalized object", async (t) => {
  const s3 = await createMockS3(t);
  const storage = createStorage(makeConfig(s3.endpoint));
  const upload = await storage.presign("images", {
    filename: "avatar.png",
    size: PNG.length,
  });
  await fetch(upload.url, { method: upload.method, headers: upload.headers, body: PNG });
  s3.forceConcurrentCopyRace();

  const [first, second] = await Promise.all([
    storage.complete(upload.token),
    storage.complete(upload.token),
  ]);

  assert.deepEqual(second, first);
  assert.equal(s3.getCopyRequestCount(), 2);
  assert.equal([...s3.objects.keys()].some((key) => key.startsWith("_pending/")), false);
  assert.equal([...s3.objects.keys()].filter((key) => key.startsWith("images/")).length, 1);
});

test("tokens reject tampering, expiry, and another bucket", async (t) => {
  const s3 = await createMockS3(t);
  const storage = createStorage(
    makeConfig(s3.endpoint, { presignedUrlExpiresIn: 1, completeTokenExpiresIn: 1 }),
  );
  const upload = await storage.presign("images", {
    filename: "avatar.png",
    contentType: "image/png",
    size: PNG.length,
  });

  const tampered = `${upload.token.slice(0, -1)}${upload.token.endsWith("a") ? "b" : "a"}`;
  await assert.rejects(storage.complete(tampered), assertStorageError("INVALID_TOKEN"));

  const otherStorage = createStorage(
    makeConfig(s3.endpoint, { bucket: "another-bucket" }),
  );
  await assert.rejects(otherStorage.complete(upload.token), assertStorageError("INVALID_TOKEN"));

  await new Promise((resolve) => setTimeout(resolve, 1100));
  await assert.rejects(storage.complete(upload.token), assertStorageError("UPLOAD_EXPIRED"));
});

test("metadata prevalidation rejects category, size, MIME, and dangerous extensions", async (t) => {
  const s3 = await createMockS3(t);
  const storage = createStorage(makeConfig(s3.endpoint, { maxFileSize: 10 }));

  await assert.rejects(
    storage.presign("unknown", { filename: "a.png", contentType: "image/png", size: 1 }),
    assertStorageError("INVALID_INPUT"),
  );
  await assert.rejects(
    storage.presign("images", { filename: "a.png", contentType: "image/png", size: 11 }),
    assertStorageError("UNSUPPORTED_FILE"),
  );
  await assert.rejects(
    storage.presign("images", { filename: "a.png", contentType: "text/plain", size: 1 }),
    assertStorageError("UNSUPPORTED_FILE"),
  );
  await assert.rejects(
    storage.presign("images", { filename: "a.exe", contentType: "application/octet-stream", size: 1 }),
    assertStorageError("UNSUPPORTED_FILE"),
  );
});

test("put rejects disguised binary files and ZIP files renamed as Office documents", async (t) => {
  const s3 = await createMockS3(t);
  const storage = createStorage(makeConfig(s3.endpoint));

  await assert.rejects(
    storage.put("images", Buffer.from("not a png"), {
      filename: "avatar.png",
      contentType: "image/png",
    }),
    assertStorageError("UNSUPPORTED_FILE"),
  );

  const genericZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  await assert.rejects(
    storage.put("documents", genericZip, {
      filename: "report.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    assertStorageError("UNSUPPORTED_FILE"),
  );
  assert.equal(s3.requests.some((request) => request.method === "PUT"), false);
});

test("complete deletes a pending object when content validation fails", async (t) => {
  const s3 = await createMockS3(t);
  const storage = createStorage(makeConfig(s3.endpoint));
  const invalid = Buffer.from("plain text");
  const upload = await storage.presign("images", {
    filename: "avatar.png",
    contentType: "image/png",
    size: invalid.length,
  });
  await fetch(upload.url, { method: "PUT", headers: upload.headers, body: invalid });

  await assert.rejects(storage.complete(upload.token), assertStorageError("UNSUPPORTED_FILE"));
  assert.equal([...s3.objects.keys()].some((key) => key.startsWith("_pending/")), false);
  assert.equal([...s3.objects.keys()].some((key) => key.startsWith("images/")), false);
});

test("complete reports a missing pending object", async (t) => {
  const s3 = await createMockS3(t);
  const storage = createStorage(makeConfig(s3.endpoint));
  const upload = await storage.presign("images", {
    filename: "avatar.png",
    contentType: "image/png",
    size: PNG.length,
  });

  await assert.rejects(storage.complete(upload.token), assertStorageError("OBJECT_NOT_FOUND"));
});

test("complete detects an ETag change between validation and copy", async (t) => {
  const s3 = await createMockS3(t);
  const storage = createStorage(makeConfig(s3.endpoint));
  const upload = await storage.presign("images", {
    filename: "avatar.png",
    contentType: "image/png",
    size: PNG.length,
  });
  await fetch(upload.url, { method: "PUT", headers: upload.headers, body: PNG });
  s3.setAfterGet(({ key, objects }) => {
    objects.set(key, {
      body: Buffer.from(PNG),
      contentType: "image/png",
      etag: '"changed-etag"',
      metadata: {},
    });
  });

  await assert.rejects(storage.complete(upload.token), assertStorageError("OBJECT_MISMATCH"));
  const copy = s3.requests.find(
    (request) => request.method === "PUT" && request.headers["x-amz-copy-source"],
  );
  assert.equal(copy.headers["x-amz-copy-source-if-match"], etagFor(PNG));
  assert.equal([...s3.objects.keys()].some((key) => key.startsWith("_pending/")), false);
});

test("remove and getUrl reject pending and traversal keys", async (t) => {
  const s3 = await createMockS3(t);
  const storage = createStorage(makeConfig(s3.endpoint));

  assert.throws(() => storage.getUrl("_pending/upload-id"), assertStorageError("INVALID_INPUT"));
  assert.throws(
    () => storage.getUrl("images/2026/08/01/../secret.png"),
    assertStorageError("INVALID_INPUT"),
  );
  await assert.rejects(
    storage.remove("_pending/upload-id"),
    assertStorageError("INVALID_INPUT"),
  );
});

test("provider failures use STORAGE_ERROR and preserve their cause", async (t) => {
  const s3 = await createMockS3(t);
  const storage = createStorage(makeConfig(s3.endpoint));
  s3.failNextRequest(403, "AccessDenied");

  await assert.rejects(
    storage.put("images", PNG, { filename: "avatar.png", contentType: "image/png" }),
    (error) =>
      error instanceof StorageError && error.code === "STORAGE_ERROR" && error.cause instanceof Error,
  );
});

test("configuration rejects ambiguous categories, unsupported extensions, and reused secrets", async (t) => {
  const s3 = await createMockS3(t);
  assert.throws(
    () => createStorage(makeConfig(s3.endpoint, { categories: { _pending: ["png"] } })),
    assertStorageError("INVALID_CONFIG"),
  );
  assert.throws(
    () =>
      createStorage(
        makeConfig(s3.endpoint, {
          categories: { images: ["png"], "images/private": ["png"] },
        }),
      ),
    assertStorageError("INVALID_CONFIG"),
  );
  assert.throws(
    () => createStorage(makeConfig(s3.endpoint, { categories: { files: ["not/valid"] } })),
    assertStorageError("INVALID_CONFIG"),
  );
  assert.throws(
    () =>
      createStorage(
        makeConfig(s3.endpoint, {
          credentials: {
            accessKeyId: "test-access-key",
            secretAccessKey: SIGNING_SECRET,
          },
          signingSecret: SIGNING_SECRET,
        }),
      ),
    assertStorageError("INVALID_CONFIG"),
  );
});
