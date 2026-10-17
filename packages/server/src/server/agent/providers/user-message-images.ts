import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentTimelineImage } from "../agent-sdk-types.js";
import { materializeProviderImage } from "./provider-image-output.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".bmp": "image/bmp",
};

function resolveMimeType(value: unknown, source: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof source !== "string") return undefined;
  return (
    /^data:([^;]+);base64,/.exec(source)?.[1] ??
    MIME_BY_EXTENSION[path.extname(source).toLowerCase()]
  );
}

// Only top-level image blocks belong to the user's message. Tool-result images are
// mapped separately, and must not become user attachments during history replay.
export async function userMessageImages(content: unknown): Promise<AgentTimelineImage[]> {
  if (!Array.isArray(content)) return [];
  const images: AgentTimelineImage[] = [];
  for (const value of content) {
    const block = record(value);
    const source = record(block.source);
    const local = block.type === "local_image" || block.type === "localImage";
    const file = block.type === "file";
    if (!local && !file && block.type !== "image") continue;
    const url = block.url ?? block.uri ?? source.url;
    const originalPath = local ? block.path : url;
    const rawMime = block.mimeType ?? block.mime ?? source.media_type;
    const mimeType = resolveMimeType(rawMime, originalPath);
    if (file && !mimeType?.startsWith("image/")) continue;
    const data = block.data ?? source.data;
    const resolvedSource = await resolveSource(originalPath, data, mimeType ?? "image/png");
    if (!resolvedSource) continue;
    images.push({
      id: createHash("sha256").update(resolvedSource).digest("hex"),
      source: resolvedSource,
      mimeType: mimeType ?? "image/png",
    });
  }
  return images;
}

async function resolveSource(
  source: unknown,
  data: unknown,
  mimeType: string,
): Promise<string | undefined> {
  const inline = inlineImageData(source, data);
  if (inline === null) return typeof source === "string" ? source : undefined;
  try {
    return (await materializeProviderImage({ data: inline, mimeType })).path;
  } catch {
    // An image that can't be materialized (over the size limit, temp dir unavailable)
    // drops from the message; the rest of the conversation still loads.
    return undefined;
  }
}

function inlineImageData(source: unknown, data: unknown): string | null {
  if (typeof data === "string") return data;
  if (typeof source === "string" && source.startsWith("data:image/")) return source;
  return null;
}
