import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { initStorage, StorageValidationError } from "../dist/index.js";

const categories = {
  images: ["png"],
};

function createStorage(options = {}) {
  return initStorage({
    bucket: "example-bucket",
    endpoint: "https://example-bucket.s3.ap-northeast-2.amazonaws.com",
    publicBaseUrl: "https://example-bucket.s3.ap-northeast-2.amazonaws.com",
    region: "ap-northeast-2",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    categories,
    ...options,
  });
}

test("uses the exact publicBaseUrl for AWS", () => {
  const storage = createStorage();

  assert.equal(
    storage.getUrl("images/2026/07/30/example.png"),
    "https://example-bucket.s3.ap-northeast-2.amazonaws.com/images/2026/07/30/example.png",
  );
});

test("uses the exact publicBaseUrl for us-east-1", () => {
  const storage = createStorage({
    endpoint: "https://example-bucket.s3.amazonaws.com",
    publicBaseUrl: "https://example-bucket.s3.amazonaws.com",
  });

  assert.equal(
    storage.getUrl("images/2026/07/30/example.png"),
    "https://example-bucket.s3.amazonaws.com/images/2026/07/30/example.png",
  );
});

test("uses publicBaseUrl for an S3-compatible provider", () => {
  const storage = createStorage({
    region: "auto",
    endpoint: "https://account-id.r2.cloudflarestorage.com/example-bucket",
    publicBaseUrl: "https://files.example.com/",
  });

  assert.equal(
    storage.getUrl("images/2026/07/30/example image.png"),
    "https://files.example.com/images/2026/07/30/example%20image.png",
  );
});

test("supports a URL object and a path prefix in publicBaseUrl", () => {
  const storage = createStorage({
    publicBaseUrl: new URL("http://localhost:9000/example-bucket///"),
  });

  assert.equal(
    storage.getUrl("images/2026/07/30/example.png"),
    "http://localhost:9000/example-bucket/images/2026/07/30/example.png",
  );
});

test("encodes each object-key path segment", () => {
  const storage = createStorage({ publicBaseUrl: "https://files.example.com" });

  assert.equal(
    storage.getUrl("images/2026/07/30/한글 #1.png"),
    "https://files.example.com/images/2026/07/30/%ED%95%9C%EA%B8%80%20%231.png",
  );
});

test("keeps the API endpoint separate from the public URL", () => {
  const storage = createStorage({
    endpoint: "https://account-id.r2.cloudflarestorage.com/example-bucket",
    publicBaseUrl: "https://cdn.example.com",
  });

  assert.equal(
    storage.getUrl("images/2026/07/30/example.png"),
    "https://cdn.example.com/images/2026/07/30/example.png",
  );
});

test("rejects invalid or unsafe publicBaseUrl values", () => {
  const unsafeValues = [
    "not a URL",
    "javascript:alert(1)",
    "https://user@example.com/files",
    "https://user:password@example.com/files",
    "https://files.example.com/files?download=1",
    "https://files.example.com/files#image",
  ];

  for (const publicBaseUrl of unsafeValues) {
    assert.throws(
      () => createStorage({ publicBaseUrl }),
      StorageValidationError,
      publicBaseUrl,
    );
  }
});

test("rejects invalid or unsafe exact API endpoints", () => {
  const unsafeValues = [
    "not a URL",
    "ftp://storage.example.com/example-bucket",
    "https://user@example.com/example-bucket",
    "https://storage.example.com/example-bucket?version=1",
    "https://storage.example.com/example-bucket#objects",
  ];

  for (const endpoint of unsafeValues) {
    assert.throws(() => createStorage({ endpoint }), StorageValidationError, endpoint);
  }
});

test("requires an explicit region and credentials", () => {
  assert.throws(() => createStorage({ region: "" }), StorageValidationError);
  assert.throws(() => createStorage({ region: undefined }), StorageValidationError);
  assert.throws(() => createStorage({ accessKeyId: "" }), StorageValidationError);
  assert.throws(() => createStorage({ accessKeyId: undefined }), StorageValidationError);
  assert.throws(() => createStorage({ secretAccessKey: "" }), StorageValidationError);
  assert.throws(() => createStorage({ secretAccessKey: undefined }), StorageValidationError);
});

test("keeps object-key traversal validation", () => {
  const storage = createStorage({ publicBaseUrl: "https://files.example.com" });

  assert.throws(
    () => storage.getUrl("images/2026/07/30/../secret.png"),
    StorageValidationError,
  );
});

test("uses an exact bucket API endpoint without a path-style option", async (t) => {
  let requestedUrl;
  const server = createServer((request, response) => {
    requestedUrl = request.url;
    response.writeHead(204);
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => server.close());

  const address = server.address();
  assert(address && typeof address === "object");

  const storage = createStorage({
    endpoint: `http://127.0.0.1:${address.port}/storage/v1/s3/example-bucket`,
    publicBaseUrl:
      "https://project-ref.supabase.co/storage/v1/object/public/example-bucket",
    region: "project-region",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  });

  await storage.remove("images/2026/07/30/example.png");

  assert.equal(
    new URL(requestedUrl, "http://localhost").pathname,
    "/storage/v1/s3/example-bucket/images/2026/07/30/example.png",
  );
  assert.equal(
    storage.getUrl("images/2026/07/30/example.png"),
    "https://project-ref.supabase.co/storage/v1/object/public/example-bucket/images/2026/07/30/example.png",
  );
});
