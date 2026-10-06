import type { AgentTimelineItem } from "../agent-sdk-types.js";

interface CustomMessage {
  role: "custom";
  customType?: unknown;
  details?: unknown;
}

/**
 * An extension marks a custom message as its agent speaking to the user with
 * `details.paseo.render: "assistant"`. `attribution: "agent"` can't stand in
 * for that: it records who initiated the message, and agent-initiated context
 * (reminders, peer messages, agent-invoked skills) carries it too.
 */
function rendersAsAssistant(message: CustomMessage): boolean {
  const { details } = message;
  if (!details || typeof details !== "object") return false;
  const paseo = Reflect.get(details, "paseo");
  return !!paseo && typeof paseo === "object" && Reflect.get(paseo, "render") === "assistant";
}

/**
 * Show extension context as an expandable tool row, or as an assistant reply
 * when the extension asks for it. `id` must be unique per message: the stream
 * coalescer would otherwise glue a reply onto the one it arrives next to.
 */
export function mapCustomMessageToTimelineItem(
  message: CustomMessage,
  text: string,
  id: string,
): AgentTimelineItem {
  if (rendersAsAssistant(message)) {
    return { type: "assistant_message", text, messageId: id };
  }
  const customType =
    typeof message.customType === "string" && message.customType.trim()
      ? message.customType
      : "custom-message";
  return {
    type: "tool_call",
    callId: id,
    name: customType,
    status: "completed",
    detail: { type: "plain_text", text },
    metadata: {
      synthetic: true,
      customType,
      ...(message.details === undefined ? {} : { details: message.details }),
    },
    error: null,
  };
}
