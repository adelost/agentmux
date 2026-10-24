import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { parseFlags } from "./command-args.mjs";
import { findChannelForPane } from "./config.mjs";
import { sendFileToChannelId } from "./send-notify.mjs";
import { detectSenderFromEnv } from "../core/sender-detect.mjs";
import { readMediaUpload, sendMediaUpload } from "../core/media-upload.mjs";

/** WHAT: Dispatches a local image or MP4 through the existing Discord file transport. WHY: Keeps size checks and unknown video outcomes ahead of another upload. */
export async function cmdImage(args, ctx, { send = sendFileToChannelId, rootDir, log = console.log } = {}) {
  const { flags, positional } = parseFlags(args, { c: "string", channel: "string", p: "string", pane: "string", dry: "boolean" });
  if (!positional[0]) throw new Error("Usage: amux image <image-or-mp4> [caption] [-c channelId] [-p agent:pane] [--dry]");
  const media = readMediaUpload(resolve(positional[0])), caption = positional.slice(1).join(" ").trim();
  let channelId = flags.c || flags.channel;
  if (!channelId) {
    const sender = flags.p || flags.pane || detectSenderFromEnv(process.env, command => execSync(command, { encoding: "utf8", timeout: 2000 }));
    const match = /^([^:]+):(\d+)$/u.exec(sender || "");
    if (!match) throw new Error("No sender detected: pass -c channelId or -p agent:pane");
    channelId = findChannelForPane(ctx.configPath, match[1], Number(match[2]));
    if (!channelId) throw new Error(`No Discord channel bound to ${sender}`);
  }
  if (flags.dry) {
    log(`image: ${media.name} → ${channelId}, ${media.bytes.length} bytes (${media.contentType}), cap ${media.limitBytes}`);
    return { dry: true, channelId, sha256: media.sha256, bytes: media.bytes.length, contentType: media.contentType };
  }
  if (media.contentType === "video/mp4") {
    const receipt = await sendMediaUpload({ channelId, media, caption, send, ...(rootDir && { rootDir }) });
    log(`image (${media.name}) → ${channelId} · message ${receipt.messageId} · ${receipt.receiptPath}${receipt.alreadySent ? " (already delivered)" : ""}`);
    return receipt;
  }
  const message = await send(channelId, media.path, caption, { fileBuffer: media.bytes, contentType: media.contentType });
  log(`image (${media.name}) → ${channelId}`);
  return message;
}
