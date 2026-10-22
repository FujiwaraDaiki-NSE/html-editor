import { Readable } from "node:stream";

export async function readFolderUpload(request) {
  const contentType = request.headers["content-type"];
  if (!contentType?.startsWith("multipart/form-data;")) throw new Error("Folder upload must use multipart/form-data.");
  const limit = 502 * 1024 * 1024;
  async function* chunks() {
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error("Folder upload exceeds 500 MB."), { code: "WEAVE_REQUEST_TOO_LARGE" });
      yield chunk;
    }
  }
  const body = Readable.toWeb(Readable.from(chunks()));
  const form = await new Request("http://localhost/", { method: "POST", headers: { "content-type": contentType }, body, duplex: "half" }).formData();
  return [...form.entries()].map(([path, file]) => {
    if (!(file instanceof File)) throw new Error("Folder upload must contain files only.");
    return { path, file };
  });
}
