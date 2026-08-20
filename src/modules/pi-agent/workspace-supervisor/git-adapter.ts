import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  PiRepositoryBinding,
  PiWorkspaceProviderBranch,
  PiWorkspaceProviderCheckpoint,
  PiWorkspaceProviderDiff,
} from "@/src/modules/pi-agent/domain/workspace-contracts";
import type { PiSupervisorWorkspace, PiWorkspaceLease, PiWorkspaceSupervisorConfig, PiWorkspaceSupervisorContext } from "@/src/modules/pi-agent/workspace-supervisor/contracts";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validText(value: string, max = 512): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function assertContext(context: PiWorkspaceSupervisorContext): void {
  if (![context.tenantId, context.actorId, context.sessionId, context.runId, context.traceId].every((value) => validText(value))) throw new Error("PI_WORKSPACE_SCOPE_INVALID");
}

function sameScope(left: PiWorkspaceSupervisorContext, right: PiWorkspaceSupervisorContext): boolean {
  return left.tenantId === right.tenantId && left.actorId === right.actorId && left.sessionId === right.sessionId && left.runId === right.runId;
}

function assertCommitSha(value: string): void {
  if (!/^[a-f0-9]{40,64}$/i.test(value)) throw new Error("PI_BASE_COMMIT_INVALID");
}

function assertEphemeralBranch(value: string): void {
  if (!/^pi\/[A-Za-z0-9._/-]+$/.test(value) || value.includes("..") || value.includes("\\")) throw new Error("PI_EPHEMERAL_BRANCH_INVALID");
  const normalized = value.toLowerCase();
  if (["pi/main", "pi/master", "pi/production", "pi/prod"].includes(normalized) || normalized.includes("/release/")) throw new Error("PI_PROTECTED_BRANCH");
}

function assertRef(value: string, code: string): void {
  if (!validText(value, 512) || value.includes("..") || value.includes("\\") || value.startsWith("-") || /[~^:?*\[\s]/.test(value)) throw new Error(code);
}

function repositoryPath(repositoryRef: string): string {
  const normalized = repositoryRef.replace(/^forgejo:\/\//, "").replace(/^\/+/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(normalized)) throw new Error("PI_REPOSITORY_REF_INVALID");
  return normalized;
}

function baseUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("PI_FORGEJO_ENDPOINT_INVALID");
  return url;
}

function repositoryUrl(config: PiWorkspaceSupervisorConfig, repositoryRef: string): string {
  const base = baseUrl(config.forgejoBaseUrl);
  return new URL(`${repositoryPath(repositoryRef)}.git`, base).toString();
}

function safeLabel(value: string): string {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
  return normalized || "checkpoint";
}

type CommandResult = { stdout: string; stderr: string };

export class ForgejoGitWorkspaceAdapter {
  private readonly workspaces = new Map<string, PiSupervisorWorkspace>();

  constructor(private readonly config: PiWorkspaceSupervisorConfig) {
    baseUrl(config.forgejoBaseUrl);
    if (!validText(config.rootDirectory, 2_000) || !validText(config.forgejoUsername, 256) || !validText(config.forgejoToken, 2_000)) throw new Error("PI_FORGEJO_CREDENTIALS_REQUIRED");
  }

  async authorizeRepository(repository: PiRepositoryBinding, context: PiWorkspaceSupervisorContext): Promise<void> {
    assertContext(context);
    if (repository.provider !== "forgejo" || repository.tenantId !== context.tenantId || repository.status !== "active") throw new Error("PI_REPOSITORY_NOT_FOUND");
    await this.runGit(["ls-remote", "--heads", repositoryUrl(this.config, repository.repositoryRef)], undefined, this.credential(this.config.forgejoUsername, this.config.forgejoToken));
  }

  async prepare(input: { repository: PiRepositoryBinding; baseRef: string; baseCommitSha: string; context: PiWorkspaceSupervisorContext; lease: PiWorkspaceLease }): Promise<{ workspace: PiSupervisorWorkspace; workspaceDigest: string }> {
    this.assertLease(input.lease, input.context, input.repository.id, undefined, undefined);
    assertRef(input.baseRef, "PI_BASE_REF_INVALID");
    assertCommitSha(input.baseCommitSha);
    const id = randomUUID();
    const directory = `${this.config.rootDirectory.replace(/[\\/]$/, "")}/pi-${id}`;
    await mkdir(this.config.rootDirectory, { recursive: true });
    try {
      await this.runGit(["clone", "--no-tags", "--single-branch", "--branch", input.baseRef, repositoryUrl(this.config, input.repository.repositoryRef), directory], undefined, this.credential(input.lease.username, input.lease.token));
      const workspace: PiSupervisorWorkspace = {
        id,
        workspaceId: input.lease.workspaceId,
        providerWorkspaceRef: `forgejo://workspace/${id}`,
        directory,
        repository: input.repository,
        context: input.context,
        baseRef: input.baseRef,
        baseCommitSha: input.baseCommitSha.toLowerCase(),
      };
      this.workspaces.set(workspace.providerWorkspaceRef, workspace);
      return { workspace, workspaceDigest: digest(JSON.stringify({ repository: input.repository.repositoryRef, baseRef: input.baseRef, baseCommitSha: input.baseCommitSha.toLowerCase() })) };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async verifyBaseCommit(workspace: PiSupervisorWorkspace, baseRef: string, expectedCommitSha: string, lease: PiWorkspaceLease): Promise<void> {
    this.assertLease(lease, workspace.context, workspace.repository.id, workspace.workspaceId, workspace.branch);
    assertRef(baseRef, "PI_BASE_REF_INVALID");
    assertCommitSha(expectedCommitSha);
    const current = (await this.runGit(["rev-parse", `${baseRef}^{commit}`], workspace.directory, this.credential(lease.username, lease.token))).stdout.trim().toLowerCase();
    if (current !== expectedCommitSha.toLowerCase()) throw new Error("PI_BASE_COMMIT_MISMATCH");
  }

  async createBranch(workspace: PiSupervisorWorkspace, branch: string, baseCommitSha: string, lease: PiWorkspaceLease): Promise<PiWorkspaceProviderBranch> {
    this.assertLease(lease, workspace.context, workspace.repository.id, workspace.workspaceId, branch);
    assertEphemeralBranch(branch);
    assertCommitSha(baseCommitSha);
    if (workspace.baseCommitSha !== baseCommitSha.toLowerCase()) throw new Error("PI_BASE_COMMIT_MISMATCH");
    await this.runGit(["checkout", "-b", branch, baseCommitSha], workspace.directory, this.credential(lease.username, lease.token));
    const headCommitSha = (await this.runGit(["rev-parse", "HEAD"], workspace.directory, this.credential(lease.username, lease.token))).stdout.trim();
    workspace.branch = branch;
    workspace.headCommitSha = headCommitSha;
    return { branch, headCommitSha };
  }

  async checkpoint(workspace: PiSupervisorWorkspace, branch: string, label: string, lease: PiWorkspaceLease): Promise<PiWorkspaceProviderCheckpoint> {
    this.assertLease(lease, workspace.context, workspace.repository.id, workspace.workspaceId, branch);
    this.assertBranch(workspace, branch);
    await this.runGit(["add", "--all"], workspace.directory, this.credential(lease.username, lease.token));
    await this.runGit(["-c", "user.name=Pi Enterprise", "-c", "user.email=pi-enterprise@localhost", "commit", "--allow-empty", "-m", safeLabel(label)], workspace.directory, this.credential(lease.username, lease.token));
    const commitSha = (await this.runGit(["rev-parse", "HEAD"], workspace.directory, this.credential(lease.username, lease.token))).stdout.trim();
    workspace.headCommitSha = commitSha;
    return { commitSha, branch, messageDigest: digest(safeLabel(label)), createdAt: new Date().toISOString() };
  }

  async diff(workspace: PiSupervisorWorkspace, baseCommitSha: string, branch: string, lease: PiWorkspaceLease): Promise<PiWorkspaceProviderDiff> {
    this.assertLease(lease, workspace.context, workspace.repository.id, workspace.workspaceId, branch);
    this.assertBranch(workspace, branch);
    assertCommitSha(baseCommitSha);
    if (workspace.baseCommitSha !== baseCommitSha.toLowerCase()) throw new Error("PI_BASE_COMMIT_MISMATCH");
    await this.runGit(["add", "--all"], workspace.directory, this.credential(lease.username, lease.token));
    const diff = (await this.runGit(["diff", "--cached", "--binary", baseCommitSha], workspace.directory, this.credential(lease.username, lease.token))).stdout;
    const headCommitSha = (await this.runGit(["rev-parse", "HEAD"], workspace.directory, this.credential(lease.username, lease.token))).stdout.trim();
    workspace.headCommitSha = headCommitSha;
    return { baseCommitSha: baseCommitSha.toLowerCase(), headCommitSha, diff, diffDigest: digest(diff) };
  }

  async push(workspace: PiSupervisorWorkspace, branch: string, lease: PiWorkspaceLease): Promise<{ branch: string; headCommitSha: string }> {
    this.assertLease(lease, workspace.context, workspace.repository.id, workspace.workspaceId, branch);
    this.assertBranch(workspace, branch);
    await this.runGit(["push", "origin", `HEAD:refs/heads/${branch}`], workspace.directory, this.credential(lease.username, lease.token));
    const headCommitSha = (await this.runGit(["rev-parse", "HEAD"], workspace.directory, this.credential(lease.username, lease.token))).stdout.trim();
    workspace.headCommitSha = headCommitSha;
    return { branch, headCommitSha };
  }

  async cleanup(workspace: PiSupervisorWorkspace, lease: PiWorkspaceLease | undefined, context: PiWorkspaceSupervisorContext): Promise<void> {
    if (!sameScope(workspace.context, context)) throw new Error("PI_WORKSPACE_SCOPE_MISMATCH");
    if (lease) this.assertLease(lease, context, workspace.repository.id, workspace.workspaceId, workspace.branch);
    await rm(workspace.directory, { recursive: true, force: true });
    this.workspaces.delete(workspace.providerWorkspaceRef);
  }

  /**
   * Rehydrates only a workspace whose directory is still inside the configured
   * root and whose checkout still points at the expected repository. The
   * checkout itself is the source of truth for branch/head after a crash.
   */
  async restore(workspace: PiSupervisorWorkspace): Promise<boolean> {
    if (!/^forgejo:\/\/workspace\/[0-9a-f-]{36}$/i.test(workspace.providerWorkspaceRef) || !/^pi-[0-9a-f-]{36}$/i.test(basename(resolve(workspace.directory)))) throw new Error("PI_WORKSPACE_STATE_INVALID");
    assertContext(workspace.context);
    if (workspace.repository.provider !== "forgejo" || workspace.repository.tenantId !== workspace.context.tenantId) throw new Error("PI_WORKSPACE_STATE_INVALID");
    assertCommitSha(workspace.baseCommitSha);
    const root = resolve(this.config.rootDirectory);
    const directory = resolve(workspace.directory);
    const relativePath = relative(root, directory);
    if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith("..\\") || relativePath.startsWith("../")) throw new Error("PI_WORKSPACE_STATE_INVALID");
    try {
      await access(directory);
      const origin = (await this.runGit(["config", "--get", "remote.origin.url"], directory, this.credential(this.config.forgejoUsername, this.config.forgejoToken))).stdout.trim();
      if (this.normalizeRemote(origin) !== this.normalizeRemote(repositoryUrl(this.config, workspace.repository.repositoryRef))) return false;
      const headCommitSha = (await this.runGit(["rev-parse", "HEAD"], directory, this.credential(this.config.forgejoUsername, this.config.forgejoToken))).stdout.trim().toLowerCase();
      assertCommitSha(headCommitSha);
      const branchOutput = (await this.runGit(["rev-parse", "--abbrev-ref", "HEAD"], directory, this.credential(this.config.forgejoUsername, this.config.forgejoToken))).stdout.trim();
      const actualBranch = branchOutput === "HEAD" ? undefined : branchOutput;
      if (workspace.branch && actualBranch !== workspace.branch) return false;
      this.workspaces.set(workspace.providerWorkspaceRef, { ...workspace, branch: actualBranch, headCommitSha });
      return true;
    } catch {
      return false;
    }
  }

  snapshot(): PiSupervisorWorkspace[] {
    return [...this.workspaces.values()].map((workspace) => ({
      ...workspace,
      repository: { ...workspace.repository },
      context: { ...workspace.context },
    }));
  }

  get(providerWorkspaceRef: string, context: PiWorkspaceSupervisorContext): PiSupervisorWorkspace {
    const workspace = this.workspaces.get(providerWorkspaceRef);
    if (!workspace || !sameScope(workspace.context, context)) throw new Error("PI_WORKSPACE_NOT_FOUND");
    return workspace;
  }

  private assertBranch(workspace: PiSupervisorWorkspace, branch: string): void {
    if (!workspace.branch || workspace.branch !== branch) throw new Error("PI_EPHEMERAL_BRANCH_NOT_FOUND");
  }

  private assertLease(lease: PiWorkspaceLease, context: PiWorkspaceSupervisorContext, repositoryId: string, workspaceId?: string, branch?: string): void {
    assertContext(context);
    if (new Date(lease.expiresAt).getTime() <= Date.now()) throw new Error("PI_CREDENTIAL_LEASE_EXPIRED");
    if (!sameScope(lease.scope, context) || lease.repositoryId !== repositoryId || (workspaceId !== undefined && lease.workspaceId !== workspaceId) || (branch !== undefined && lease.branch !== branch)) throw new Error("PI_CREDENTIAL_SCOPE_MISMATCH");
  }

  private credential(username: string, token: string): { username: string; token: string } {
    return { username, token };
  }

  private normalizeRemote(value: string): string {
    return value.trim().replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
  }

  private async runGit(args: string[], cwd: string | undefined, credential: { username: string; token: string }): Promise<CommandResult> {
    void credential.username;
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: token ${credential.token}`,
    };
    try {
      const result = await execFileAsync("git", args, { cwd, env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true });
      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "unknown";
      if (args[0] === "rev-parse") throw new Error("PI_GIT_REF_NOT_FOUND");
      if (args[0] === "ls-remote") throw new Error("PI_REPOSITORY_UNAUTHORIZED");
      if (args[0] === "push") throw new Error("PI_GIT_PUSH_FAILED");
      throw new Error(`PI_GIT_OPERATION_FAILED_${code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20) || "UNKNOWN"}`);
    }
  }
}
