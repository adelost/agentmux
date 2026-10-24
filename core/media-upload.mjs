import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { IMAGE_EXTENSIONS } from "../lib.mjs";
import { notificationNonce } from "./notification-identity.mjs";

// https://docs.discord.com/developers/reference#uploading-files
/** WHAT: Defines the documented base attachment cap, verified 2026-10-24. WHY: Prevents uploads above the guaranteed Discord limit before any POST. */
export const MEDIA_UPLOAD_LIMIT = 20 * 1024 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4" };

/** WHAT: Reads one bounded supported attachment into an unchanged buffer. WHY: Prevents a changed file or unsupported upload from reaching the transport. */
export function readMediaUpload(path) {
  const extension = extname(path).toLowerCase();
  if (![...IMAGE_EXTENSIONS, ".mp4"].includes(extension)) throw new Error("unsupported media format");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("not a file");
    if (before.size < 1n || before.size > BigInt(MEDIA_UPLOAD_LIMIT)) throw new Error("attachment must be nonempty and at most 20 MiB");
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true });
    if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => before[key] !== after[key]) || BigInt(bytes.length) !== before.size) throw new Error("attachment changed during read");
    if (extension === ".mp4" && (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp")) throw new Error("unsupported MP4 container");
    return { path: resolve(path), name: basename(path), contentType: MIME[extension], bytes, sha256: hash(bytes), limitBytes: MEDIA_UPLOAD_LIMIT };
  } finally { closeSync(fd); }
}

function saveReceipt(path, record) {
  const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } }
}

/** WHAT: Dispatches a video once and stores its separate transport outcome. WHY: Keeps an uncertain upload from becoming a blind resend after timeout or restart. */
export async function sendMediaUpload({ channelId, media, caption = "", send, rootDir = join(homedir(), ".agentmux", "media-deliveries"), timeoutMs = 15000 }) {
  caption = String(caption).slice(0, 2000);
  const key = hash(JSON.stringify([String(channelId), media.sha256, caption]));
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const path = join(rootDir, `${key}.json`);
  let previous;
  try { previous = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error(`media outcome unknown; inspect ${path}`); }
  if (previous?.outcome === "sent" && previous.key === key && previous.channelId === String(channelId)
      && previous.sha256 === media.sha256 && previous.messageId) return { ...previous, receiptPath: path, alreadySent: true };
  if (previous) throw new Error(`media ${previous.outcome || "unknown"}; inspect ${path} before another upload`);
  const record = { version: 1, key, channelId: String(channelId), file: media.path, sha256: media.sha256,
    bytes: media.bytes.length, contentType: media.contentType, caption, startedAt: new Date().toISOString(), outcome: "unknown" };
  let fd;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`media already claimed; inspect ${path}`); throw error; }
  try { writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(rootDir, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
  try {
    const message = await send(channelId, media.path, caption, { kind: "file", fileBuffer: media.bytes,
      contentType: media.contentType, nonce: notificationNonce(`media:${key}`), signal: AbortSignal.timeout(timeoutMs) });
    if (!message?.id) throw new Error("Discord message receipt missing id");
    if (!(message.attachments || []).some(file => file.filename === media.name && file.size === media.bytes.length && file.content_type === media.contentType)) {
      record.messageId = message.id;
      throw new Error("Discord attachment receipt did not match the uploaded video");
    }
    Object.assign(record, { outcome: "sent", messageId: message.id, completedAt: new Date().toISOString(),
      attachments: (message.attachments || []).map(({ id, filename, size, content_type }) => ({ id, filename, size, contentType: content_type })) });
    saveReceipt(path, record);
    return { ...record, receiptPath: path, message };
  } catch (error) {
    if (record.outcome !== "sent") {
      record.outcome = error.notSent === true ? "not-sent" : "unknown";
      record.reason = error.message;
      try { saveReceipt(path, record); } catch { /* The pre-I/O unknown claim remains the resend fence. */ }
    }
    throw new Error(`media ${record.outcome === "sent" ? "receipt-unwritten" : record.outcome}; inspect ${path}: ${error.message}`);
  }
}
