export type Channel = "web" | "feishu" | "dingtalk" | "wecom" | "system";

export type RequestContext = {
  tenantId: string;
  actorId: string;
  sessionId: string;
  channel: Channel;
  traceId: string;
  roles: string[];
  permissions: string[];
  dataScopes: DataScope[];
};

export type DataScope =
  | { type: "self" }
  | { type: "owned" }
  | { type: "team"; teamIds: string[] }
  | { type: "org_subtree"; orgUnitIds: string[] }
  | { type: "project"; projectIds: string[] }
  | { type: "explicit"; resourceIds: string[] }
  | { type: "tenant" };

export function assertRequestContext(context: RequestContext): void {
  if (!context.tenantId || !context.actorId || !context.traceId) {
    throw new Error("REQUEST_CONTEXT_INCOMPLETE");
  }
}

