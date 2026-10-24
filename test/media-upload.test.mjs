import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdImage } from "../cli/image.mjs";
import { MEDIA_UPLOAD_LIMIT, readMediaUpload, sendMediaUpload } from "../core/media-upload.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach(root => { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); }));
function fixture(extension = ".mp4") {
  const root = mkdtempSync(join(tmpdir(), "media-upload-")); roots.push(root);
  const path = join(root, `fixture${extension}`), bytes = Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypisom"), 0, 0, 0, 0, ...Buffer.from("isommp42")]);
  writeFileSync(path, bytes);
  return { root, path, bytes, media: () => readMediaUpload(path) };
}
const response = media => ({ id: "discord-receipt", attachments: [{ id: "attachment", filename: media.name, size: media.bytes.length, content_type: media.contentType }] });

it("accepts MP4 in the actual CLI path without creating a send during dry-run", async () => {
  const fx = fixture(), send = vi.fn();
  const result = await cmdImage([fx.path, "--dry", "-c", "target"], {}, { send, log: () => {} });
  expect(result).toMatchObject({ dry: true, channelId: "target", contentType: "video/mp4", bytes: fx.bytes.length });
  expect(send).not.toHaveBeenCalled();
});

it("rejects unsupported, empty, invalid-container and over-limit files before the transport or receipt setup", async () => {
  for (const kind of ["extension", "empty", "container", "oversize"]) {
    const fx = fixture(kind === "extension" ? ".txt" : ".mp4"), send = vi.fn();
    if (kind === "empty") truncateSync(fx.path, 0);
    if (kind === "container") writeFileSync(fx.path, "This is not an MP4 file.");
    if (kind === "oversize") truncateSync(fx.path, MEDIA_UPLOAD_LIMIT + 1);
    await expect(cmdImage([fx.path, "-c", "target"], {}, { send, rootDir: join(fx.root, "receipts"), log: () => {} })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  }
});

it("keeps ordinary image uploads on their existing transport", async () => {
  const fx = fixture(".png"), send = vi.fn(async () => ({ id: "image-receipt" }));
  await cmdImage([fx.path, "caption", "-c", "target"], {}, { send, log: () => {} });
  expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0][3].contentType).toBe("image/png");
  expect(send.mock.calls[0][3].fileBuffer.equals(fx.bytes)).toBe(true);
});

it("retains exact bytes, MIME and receipt across a second invocation without another POST", async () => {
  const fx = fixture(), media = fx.media(), rootDir = join(fx.root, "receipts");
  const send = vi.fn(async (_channel, _path, _caption, options) => {
    expect(options.fileBuffer.equals(fx.bytes)).toBe(true); expect(options.contentType).toBe("video/mp4");
    expect(options.nonce).toBeTruthy(); return response(media);
  });
  const options = { channelId: "target", media, caption: "Approved clip", rootDir, send };
  const first = await sendMediaUpload(options), second = await sendMediaUpload(options);
  expect(first).toMatchObject({ outcome: "sent", messageId: "discord-receipt" });
  expect(second).toMatchObject({ alreadySent: true, messageId: "discord-receipt" });
  expect(send).toHaveBeenCalledOnce(); expect(JSON.parse(readFileSync(first.receiptPath))).toMatchObject({ outcome: "sent", sha256: media.sha256 });
});

it.each(["lost-response", "missing-id", "missing-video", "http-rejection"])("never resends after %s", async failure => {
  const fx = fixture(), media = fx.media(), rootDir = join(fx.root, "receipts");
  const send = vi.fn(async () => {
    if (failure === "lost-response") throw Error("connection lost after upload");
    if (failure === "http-rejection") throw Object.assign(Error("HTTP 413"), { notSent: true });
    if (failure === "missing-video") return { id: "discord-receipt", attachments: [] };
    return {};
  });
  const options = { channelId: "target", media, rootDir, send };
  await expect(sendMediaUpload(options)).rejects.toThrow(/media (unknown|not-sent)/);
  await expect(sendMediaUpload(options)).rejects.toThrow(/media (unknown|not-sent)/);
  expect(send).toHaveBeenCalledOnce();
});

it("keeps a timed-out upload unknown without starting another request", async () => {
  const fx = fixture(), media = fx.media(), rootDir = join(fx.root, "receipts");
  const send = vi.fn(async (_channel, _path, _caption, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const options = { channelId: "target", media, rootDir, send, timeoutMs: 20 };
  await expect(sendMediaUpload(options)).rejects.toThrow("media unknown");
  await expect(sendMediaUpload(options)).rejects.toThrow("media unknown");
  expect(send).toHaveBeenCalledOnce();
});

it("claims concurrent requests once and preserves the pre-I/O unknown fence if the final receipt cannot be written", async () => {
  const fx = fixture(), media = fx.media(), rootDir = join(fx.root, "receipts");
  mkdirSync(rootDir);
  const send = vi.fn(async () => { chmodSync(rootDir, 0o500); return response(media); });
  const options = { channelId: "target", media, rootDir, send };
  try {
    const settled = await Promise.allSettled([sendMediaUpload(options), sendMediaUpload(options)]);
    expect(settled.every(result => result.status === "rejected")).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    await expect(sendMediaUpload(options)).rejects.toThrow("unknown");
    expect(send).toHaveBeenCalledOnce();
  } finally { chmodSync(rootDir, 0o700); }
});
