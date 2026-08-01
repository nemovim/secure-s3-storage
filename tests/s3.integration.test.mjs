import assert from "node:assert/strict";
import test from "node:test";

import { createStorage } from "../dist/index.js";

const requiredEnvironment = [
  "S3_TEST_BUCKET",
  "S3_TEST_ENDPOINT",
  "S3_TEST_PUBLIC_BASE_URL",
  "S3_TEST_REGION",
  "S3_TEST_ACCESS_KEY_ID",
  "S3_TEST_SECRET_ACCESS_KEY",
  "S3_TEST_SIGNING_SECRET",
];
const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);

test(
  "S3-compatible presigned PUT integration",
  {
    skip:
      missingEnvironment.length > 0
        ? `Set ${missingEnvironment.join(", ")} to run the live integration test.`
        : false,
    timeout: 30_000,
  },
  async () => {
    const storage = createStorage({
      bucket: process.env.S3_TEST_BUCKET,
      endpoint: process.env.S3_TEST_ENDPOINT,
      publicBaseUrl: process.env.S3_TEST_PUBLIC_BASE_URL,
      region: process.env.S3_TEST_REGION,
      credentials: {
        accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY,
      },
      signingSecret: process.env.S3_TEST_SIGNING_SECRET,
      forcePathStyle: process.env.S3_TEST_FORCE_PATH_STYLE === "true",
      maxFileSize: 1024,
      categories: { images: ["png"] },
    });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const upload = await storage.presign("images", {
      filename: "integration.png",
      contentType: "image/png",
      size: png.length,
    });

    const response = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: png,
    });
    assert.equal(response.ok, true, await response.text());

    const object = await storage.complete(upload.token);
    try {
      assert.match(object.key, /^images\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]+\.png$/);
      assert.equal(storage.getUrl(object.key).startsWith(process.env.S3_TEST_PUBLIC_BASE_URL), true);
      assert.deepEqual(await storage.complete(upload.token), object);
    } finally {
      await storage.remove(object.key);
    }
  },
);
