import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { SendMessageCommand } from "@/src/modules/integration/domain/connector";

export type RenderedPlatformMessage = { messageType: string; body: Record<string, unknown> };

function assertConfirmationFields(message: SendMessageCommand["message"]): void {
  if (message.type !== "confirmation") return;
  if (!message.actionId || !message.proposalHash || !message.expiresAt) throw new Error("CONFIRMATION_REFERENCE_REQUIRED");
  if (Date.parse(message.expiresAt) <= Date.now()) throw new Error("CONFIRMATION_EXPIRED");
}

function actionValue(message: SendMessageCommand["message"]): Record<string, string> {
  return { action_id: message.actionId ?? "", proposal_hash: message.proposalHash ?? "", expires_at: message.expiresAt ?? "" };
}

export function renderPlatformMessage(provider: ExternalProvider, message: SendMessageCommand["message"]): RenderedPlatformMessage {
  assertConfirmationFields(message);
  if (provider === "feishu") {
    if (message.type !== "confirmation") return { messageType: "text", body: { text: message.text } };
    return { messageType: "interactive", body: { config: { wide_screen_mode: true }, header: { title: { tag: "plain_text", content: message.title ?? "Agent 操作确认" }, template: "orange" }, elements: [{ tag: "div", text: { tag: "lark_md", content: message.text } }, { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "确认并执行" }, type: "primary", value: actionValue(message) }] }] } };
  }
  if (provider === "dingtalk") {
    if (message.type !== "confirmation") return { messageType: "sampleText", body: { content: message.text } };
    return { messageType: "interactiveCard", body: { cardTemplateId: "nexus-agent-confirmation", cardData: { cardParamMap: { title: message.title ?? "Agent 操作确认", text: message.text, actionPayload: JSON.stringify(actionValue(message)), deepLink: message.deepLink ?? "" } } } };
  }
  if (message.type !== "confirmation") return { messageType: "text", body: { content: message.text } };
  return { messageType: "template_card", body: { card_type: "button_interaction", source: { desc: "企业 Agent" }, main_title: { title: message.title ?? "Agent 操作确认", desc: message.text }, button_list: [{ text: "确认并执行", style: 1, key: JSON.stringify(actionValue(message)) }], jump_list: message.deepLink ? [{ type: 1, title: "在网页中查看", url: message.deepLink }] : [] } };
}
