export type OrgUnit = {
  id: string;
  tenantId: string;
  parentId?: string;
  name: string;
  path: string;
  status: "active" | "archived";
};

export type Position = {
  id: string;
  tenantId: string;
  orgUnitId: string;
  name: string;
  code: string;
  status: "active" | "archived";
};

export type Membership = {
  id: string;
  tenantId: string;
  userId: string;
  orgUnitId: string;
  positionId?: string;
  isManager: boolean;
  startsAt: Date;
  endsAt?: Date;
};

export type Delegation = {
  id: string;
  tenantId: string;
  delegatorId: string;
  delegateId: string;
  permissionPatterns: string[];
  resourceIds?: string[];
  startsAt: Date;
  expiresAt: Date;
  allowRedelegation: boolean;
  revokedAt?: Date;
};

export function isDelegationActive(delegation: Delegation, now = new Date()): boolean {
  return (
    !delegation.revokedAt &&
    delegation.startsAt.getTime() <= now.getTime() &&
    delegation.expiresAt.getTime() > now.getTime()
  );
}

