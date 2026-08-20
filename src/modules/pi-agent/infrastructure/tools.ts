import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { PiProfileId, PiSandbox, PiSandboxProvider } from "@/src/modules/pi-agent/domain/contracts";
import { assertPiToolAllowed } from "@/src/modules/pi-agent/application/policy";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: {} };
}

export function createPiWorkspaceTools(input: {
  context: RequestContext;
  profile: PiProfileId;
  sandbox: PiSandbox;
  provider: PiSandboxProvider;
}) {
  const { context, profile, sandbox, provider } = input;
  const allowed = (toolName: string) => assertPiToolAllowed(profile, toolName, context);

  return [
    defineTool({
      name: "workspace_read", label: "Workspace read", promptSnippet: "Read a file from the isolated workspace.",
      description: "Read a UTF-8 text file from the current tenant-scoped sandbox. Paths are relative to the workspace.",
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }) }),
      async execute(_toolCallId, params) {
        allowed("workspace_read");
        const file = await provider.read(sandbox, params.path);
        return text(JSON.stringify({ path: file.path, digest: file.digest, content: file.content }));
      },
    }),
    defineTool({
      name: "workspace_list", label: "Workspace list", promptSnippet: "List files in the isolated workspace.",
      description: "List direct children under a relative path in the current tenant-scoped sandbox.",
      parameters: Type.Object({ path: Type.Optional(Type.String({ maxLength: 512 })) }),
      async execute(_toolCallId, params) {
        allowed("workspace_list");
        return text(JSON.stringify(await provider.list(sandbox, params.path ?? "")));
      },
    }),
    defineTool({
      name: "workspace_write", label: "Workspace write", promptSnippet: "Write a file inside the isolated workspace.",
      description: "Write a UTF-8 text file inside the current tenant-scoped sandbox. This never writes to the host filesystem.",
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }), content: Type.String({ maxLength: 2_000_000 }) }),
      async execute(_toolCallId, params) {
        allowed("workspace_write");
        const file = await provider.write(sandbox, params.path, params.content);
        return text(JSON.stringify({ path: file.path, digest: file.digest, bytes: file.content.length }));
      },
    }),
    defineTool({
      name: "workspace_apply_patch", label: "Workspace patch", promptSnippet: "Apply an exact-context patch inside the isolated workspace.",
      description: "Replace one exact text fragment in a workspace file. The operation fails if the old context is absent.",
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }), oldText: Type.String({ minLength: 1, maxLength: 100_000 }), newText: Type.String({ maxLength: 100_000 }) }),
      async execute(_toolCallId, params) {
        allowed("workspace_apply_patch");
        const file = await provider.applyPatch(sandbox, params.path, params.oldText, params.newText);
        return text(JSON.stringify({ path: file.path, digest: file.digest, bytes: file.content.length }));
      },
    }),
    defineTool({
      name: "workspace_run", label: "Sandbox command", promptSnippet: "Run a command in the isolated sandbox.",
      description: "Run a command in the session sandbox. The server policy, not the model, determines whether execution is available.",
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 8_000 }) }),
      async execute(_toolCallId, params, signal) {
        allowed("workspace_run");
        const result = await provider.run(sandbox, params.command, signal);
        return text(JSON.stringify(result));
      },
    }),
  ];
}
