import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProvider,
} from "../../agent-sdk-types.js";
import { splitMultiSelectAnswer } from "../question-card-answer.js";
import {
  OmpAskDialogQuestionsSchema,
  type OmpAgentMessage,
  type OmpExtensionUiResponse,
  type OmpRuntimeEvent,
} from "./rpc-types.js";

type UiRequest = Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>;
type UiResponse = OmpExtensionUiResponse;
type SendResponse = (id: string, response: UiResponse) => void;

const OTHER = "Other (type your own)";
const ANSWER_HEADER = "Response";

interface SelectOption {
  label: string;
  description?: string;
}

interface AskQuestion {
  title: string;
  multi: boolean;
  options: SelectOption[];
}

interface PendingAnswer {
  question: AskQuestion;
  selected: string[];
  custom: string | null;
  next: "select" | "editor";
}

/** One question of an open `ask` dialog card, keyed in the card's answers by `header`. */
interface DialogQuestion {
  id: string;
  header: string;
  multi: boolean;
  /** Card option label (with " (Recommended)") -> the label OMP expects back. */
  labels: Map<string, string>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readSelectOptions(event: UiRequest): SelectOption[] {
  const details = Array.isArray(event.optionDetails) ? event.optionDetails : [];
  return (event.options ?? []).map((label, index) => {
    const description = string(record(details[index])?.description);
    return description?.trim() ? { label, description } : { label };
  });
}

function isOptionalInput(placeholder: string | undefined): boolean {
  return /\boptional\b|\bskip\b/i.test(placeholder ?? "");
}

function inputTitle(title: string | undefined, placeholder: string | undefined): string {
  if (!isOptionalInput(placeholder)) return title ?? "Enter a value";
  return /\bcomment\b/i.test(`${title ?? ""}\n${placeholder ?? ""}`)
    ? "Optional comment"
    : "Optional response";
}

function genericQuestion(
  event: UiRequest,
  provider: AgentProvider,
  title: string,
  options: SelectOption[],
  input: { placeholder?: string; allowEmpty?: boolean; dismissLabel?: string } = {},
): AgentPermissionRequest {
  return {
    id: event.id,
    provider,
    name: `OMP ${event.method}`,
    kind: "question",
    title,
    input: {
      questions: [
        { question: title, header: ANSWER_HEADER, options, multiSelect: false, ...input },
      ],
    },
    metadata: { extensionUiMethod: event.method, answerHeader: ANSWER_HEADER },
  };
}

function mapGenericQuestion(
  event: UiRequest,
  provider: AgentProvider,
): AgentPermissionRequest | null {
  switch (event.method) {
    case "select":
      return genericQuestion(
        event,
        provider,
        event.title ?? "Select an option",
        readSelectOptions(event),
      );
    case "input": {
      const placeholder = event.placeholder;
      const optional = isOptionalInput(placeholder);
      return genericQuestion(event, provider, inputTitle(event.title, placeholder), [], {
        ...(placeholder ? { placeholder } : {}),
        ...(optional ? { allowEmpty: true, dismissLabel: "Skip" } : {}),
      });
    }
    case "editor":
      return genericQuestion(event, provider, event.title ?? "Edit text", []);
    case "confirm":
      return genericQuestion(
        event,
        provider,
        [event.title, event.message].filter(Boolean).join("\n\n"),
        [{ label: "Yes" }, { label: "No" }],
      );
    default:
      return null;
  }
}

function genericResponse(
  request: AgentPermissionRequest,
  response: AgentPermissionResponse,
): UiResponse {
  if (response.behavior === "deny") return { cancelled: true };
  const answers = record(response.updatedInput?.answers);
  const answer = Object.values(answers ?? {}).find(
    (value): value is string => typeof value === "string",
  );
  if (answer === undefined) return { cancelled: true };
  return request.metadata?.extensionUiMethod === "confirm"
    ? { confirmed: /^yes$/i.test(answer.trim()) }
    : { value: answer };
}

function questionTitle(title: string): string {
  return title.replace(/^\(\d+ selected\) /, "");
}

function matchesQuestion(title: string, question: AskQuestion): boolean {
  const plainTitle = questionTitle(title);
  if (plainTitle === question.title) return true;
  return (
    plainTitle.startsWith(question.title) &&
    /^ \(\d+\/\d+\)$/.test(plainTitle.slice(question.title.length))
  );
}

function readQuestions(args: unknown): AskQuestion[] {
  const questions = record(args)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((item) => {
    const question = record(item);
    if (typeof question?.question !== "string" || !Array.isArray(question.options)) return [];
    const options = question.options.flatMap((optionValue) => {
      const option = record(optionValue);
      if (typeof option?.label !== "string") return [];
      return [
        {
          label: option.label,
          ...(typeof option.description === "string" ? { description: option.description } : {}),
        },
      ];
    });
    return [{ title: question.question, multi: question.multi === true, options }];
  });
}

function selectedAnswer(
  answer: string,
  labels: string[],
  multi: boolean,
): { selected: string[]; custom: string | null } {
  if (!multi)
    return labels.includes(answer)
      ? { selected: [answer], custom: null }
      : { selected: [], custom: answer };
  return splitMultiSelectAnswer(answer, labels);
}

function uniqueHeader(header: string, used: Set<string>): string {
  let candidate = header;
  for (let n = 2; used.has(candidate); n++) candidate = `${header} (${n})`;
  used.add(candidate);
  return candidate;
}

/**
 * Owns OMP question mapping: the one-card `ask` dialog, and the select-based ask
 * sequence of OMP builds and tools that don't use it.
 */
export class OmpQuestionUi {
  private questions: AskQuestion[] = [];
  private pending: PendingAnswer | null = null;
  private readonly dialogs = new Map<string, DialogQuestion[]>();

  observeMessage(message: OmpAgentMessage): void {
    if (message.role !== "assistant") return;
    for (const item of message.content) {
      if (item.type === "toolCall" && item.name === "ask") this.start(item.name, item.arguments);
    }
  }

  start(toolName: string, args: unknown): void {
    if (toolName === "ask") {
      this.questions = readQuestions(args);
      this.pending = null;
    }
  }

  finish(toolName: string): void {
    if (toolName === "ask") {
      this.questions = [];
      this.pending = null;
    }
  }

  handleRequest(
    event: UiRequest,
    provider: AgentProvider,
    send: SendResponse,
  ): AgentPermissionRequest | null {
    if (event.method === "ask") return this.mapAskDialog(event, provider, send);
    if (this.consume(event, send)) return null;
    return this.mapAsk(event, provider) ?? mapGenericQuestion(event, provider);
  }

  /** Shows every question of an OMP `ask` dialog request in one card. */
  private mapAskDialog(
    event: UiRequest,
    provider: AgentProvider,
    send: SendResponse,
  ): AgentPermissionRequest | null {
    const parsed = OmpAskDialogQuestionsSchema.safeParse(event.questions);
    if (!parsed.success) {
      send(event.id, { cancelled: true });
      return null;
    }
    const used = new Set<string>();
    const dialog: DialogQuestion[] = [];
    const questions = parsed.data.map((question, index) => {
      const header = uniqueHeader(question.header?.trim() || `Question ${index + 1}`, used);
      const options = question.options.map((option, optionIndex) => ({
        label:
          optionIndex === question.recommended ? `${option.label} (Recommended)` : option.label,
        ...(option.description ? { description: option.description } : {}),
        ...(option.preview ? { preview: option.preview } : {}),
      }));
      dialog.push({
        id: question.id,
        header,
        multi: question.multi === true,
        labels: new Map(options.map((option, i) => [option.label, question.options[i].label])),
      });
      return {
        question: question.question,
        header,
        options,
        multiSelect: question.multi === true,
        allowOther: true,
      };
    });
    this.dialogs.set(event.id, dialog);
    return {
      id: event.id,
      provider,
      name: "OMP ask",
      kind: "question",
      title: parsed.data[0].question,
      input: { questions },
    };
  }

  private respondDialog(
    id: string,
    dialog: DialogQuestion[],
    response: AgentPermissionResponse,
    send: SendResponse,
  ): void {
    const answers = record(
      response.behavior === "allow" ? response.updatedInput?.answers : undefined,
    );
    const results: NonNullable<UiResponse["answers"]> = [];
    for (const question of dialog) {
      const answer = answers?.[question.header];
      if (typeof answer !== "string") {
        send(id, { cancelled: true });
        return;
      }
      const { selected, custom } = selectedAnswer(
        answer,
        [...question.labels.keys()],
        question.multi,
      );
      results.push({
        id: question.id,
        selectedOptions: selected.map((label) => question.labels.get(label) ?? label),
        ...(custom === null ? {} : { customInput: custom }),
      });
    }
    send(id, { answers: results });
  }

  private mapAsk(event: UiRequest, provider: AgentProvider): AgentPermissionRequest | null {
    if (event.method !== "select" || typeof event.title !== "string") return null;
    const title = event.title;
    const question = this.questions.find((item) => matchesQuestion(title, item));
    if (!question || !Array.isArray(event.options) || !event.options.includes(OTHER)) return null;

    const descriptions = new Map(
      question.options.map((option) => [option.label, option.description]),
    );
    const options = readSelectOptions(event)
      .filter((option) => option.label !== OTHER && !option.label.endsWith(" Done selecting"))
      .map((option) => {
        const description =
          descriptions.get(option.label) ??
          descriptions.get(option.label.replace(/ \(Recommended\)$/, "")) ??
          option.description;
        return description ? { label: option.label, description } : { label: option.label };
      });
    return {
      id: event.id,
      provider,
      name: "OMP ask",
      kind: "question",
      title: question.title,
      input: {
        questions: [
          {
            question: question.title,
            header: ANSWER_HEADER,
            options,
            multiSelect: question.multi,
            allowOther: true,
          },
        ],
      },
      metadata: {
        ompAsk: true,
        answerHeader: ANSWER_HEADER,
        optionLabels: options.map((option) => option.label),
      },
    };
  }

  respond(
    request: AgentPermissionRequest,
    response: AgentPermissionResponse,
    send: SendResponse,
  ): void {
    const dialog = this.dialogs.get(request.id);
    if (dialog) {
      this.dialogs.delete(request.id);
      this.respondDialog(request.id, dialog, response, send);
      return;
    }
    if (request.metadata?.ompAsk !== true) {
      send(request.id, genericResponse(request, response));
      return;
    }
    const question = this.questions.find((item) => item.title === request.title);
    const answers = record(
      response.behavior === "allow" ? response.updatedInput?.answers : undefined,
    );
    const answer = answers?.[ANSWER_HEADER];
    if (response.behavior === "deny" || typeof answer !== "string" || !question) {
      this.pending = null;
      send(request.id, { cancelled: true });
      return;
    }

    const labels = Array.isArray(request.metadata.optionLabels)
      ? request.metadata.optionLabels.filter((item): item is string => typeof item === "string")
      : [];
    const { selected, custom } = selectedAnswer(answer, labels, question.multi);
    if (selected.length === 0 && custom === null) {
      this.pending = null;
      send(request.id, { cancelled: true });
      return;
    }
    if (question.multi) {
      this.pending = { question, selected: selected.slice(1), custom, next: "select" };
      send(request.id, { value: selected[0] ?? OTHER });
      if (selected.length === 0) this.pending.next = "editor";
    } else if (custom !== null) {
      this.pending = { question, selected: [], custom, next: "editor" };
      send(request.id, { value: OTHER });
    } else {
      this.pending = null;
      send(request.id, { value: selected[0] });
    }
  }

  consume(event: UiRequest, send: SendResponse): boolean {
    const pending = this.pending;
    if (pending?.next === "editor" && event.method === "editor" && pending.custom !== null) {
      this.pending = null;
      send(event.id, { value: pending.custom });
      return true;
    }
    if (
      !pending ||
      typeof event.title !== "string" ||
      !matchesQuestion(event.title, pending.question)
    )
      return false;
    if (pending.next !== "select" || event.method !== "select" || !Array.isArray(event.options))
      return false;

    const choice = pending.selected[0];
    if (choice && event.options.includes(choice)) {
      pending.selected.shift();
      send(event.id, { value: choice });
      return true;
    }
    if (pending.custom !== null && event.options.includes(OTHER)) {
      pending.next = "editor";
      send(event.id, { value: OTHER });
      return true;
    }
    const done = event.options.find((option) => option.endsWith(" Done selecting"));
    if (!done) {
      // OMP omits Done for multi-question asks and expects a right-arrow
      // navigation callback, which its RPC response cannot express.
      this.pending = null;
      send(event.id, { cancelled: true });
      return true;
    }
    this.pending = null;
    send(event.id, { value: done });
    return true;
  }
}
