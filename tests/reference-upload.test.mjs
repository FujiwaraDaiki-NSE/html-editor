import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { readFolderUpload } from "../server/reference-upload.mjs";

test("multipart folder uploads keep relative paths and binary bytes", async () => {
  const form = new FormData();
  form.append("資料/docs/data.bin", new File([new Uint8Array([0, 255, 128])], "data.bin"));
  const encoded = new Request("http://localhost", { method: "POST", body: form });
  const request = Readable.fromWeb(encoded.body);
  request.headers = { "content-type": encoded.headers.get("content-type") };
  const files = await readFolderUpload(request);
  assert.equal(files[0].path, "資料/docs/data.bin");
  assert.deepEqual([...new Uint8Array(await files[0].file.arrayBuffer())], [0, 255, 128]);
});

test("folder upload rejects nonmultipart requests and nonfile fields", async () => {
  await assert.rejects(readFolderUpload({ headers: {} }), /multipart/);
  const form = new FormData();
  form.append("folder/file", "not a file");
  const encoded = new Request("http://localhost", { method: "POST", body: form });
  const request = Readable.fromWeb(encoded.body);
  request.headers = { "content-type": encoded.headers.get("content-type") };
  await assert.rejects(readFolderUpload(request), /files only/);
});
