export type TenantStatus = "provisioning" | "active" | "suspended" | "closed";

export type Tenant = {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type UserStatus = "invited" | "active" | "suspended" | "departed";

export type User = {
  id: string;
  tenantId: string;
  displayName: string;
  email?: string;
  status: UserStatus;
  locale: string;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ExternalProvider = "feishu" | "dingtalk" | "wecom";

export type ExternalIdentity = {
  id: string;
  tenantId: string;
  connectionId: string;
  provider: ExternalProvider;
  subjectType: "user" | "department" | "chat" | "app";
  externalSubjectId: string;
  internalSubjectType: "user" | "org_unit" | "conversation";
  internalSubjectId: string;
  status: "candidate" | "verified" | "conflict" | "revoked";
  verifiedAt?: Date;
};

export function assertSameTenant(tenantId: string, entity: { tenantId: string }): void {
  if (tenantId !== entity.tenantId) throw new Error("CROSS_TENANT_ACCESS_DENIED");
}

