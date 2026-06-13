export const defaultWorkspaceId = "workspace-beam-dev";

export type WorkspaceOwned = {
  workspaceId: string;
};

export type WorkspaceRole = "content-manager" | "operator" | "platform-admin" | "viewer" | "workspace-admin";

export type WorkspacePermission = "activity" | "admin" | "publish" | "read" | "recover" | "write";

export type WorkspaceMembership = {
  role: WorkspaceRole;
  workspaceId: string;
};

export type ActiveWorkspaceContext = {
  activeWorkspaceId: string;
  memberships: WorkspaceMembership[];
  userId: string;
};

export class WorkspaceAuthorizationError extends Error {
  code = "workspace_forbidden";
  status = 403;

  constructor(permission: WorkspacePermission, workspaceId: string) {
    super(`User is not allowed to ${permission} workspace ${workspaceId}.`);
    this.name = "WorkspaceAuthorizationError";
  }
}

const rolePermissions: Record<WorkspaceRole, ReadonlySet<WorkspacePermission>> = {
  "content-manager": new Set(["activity", "read", "write", "publish"]),
  operator: new Set(["activity", "read", "publish", "recover"]),
  "platform-admin": new Set(["admin", "read", "write", "publish", "recover"]),
  viewer: new Set(["read"]),
  "workspace-admin": new Set(["admin", "read", "write", "publish", "recover"])
};

export function workspaceIdOrDefault(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed || defaultWorkspaceId;
}

export function activeWorkspaceContext(): ActiveWorkspaceContext {
  return {
    activeWorkspaceId: defaultWorkspaceId,
    memberships: [
      {
        role: "platform-admin",
        workspaceId: defaultWorkspaceId
      }
    ],
    userId: "local-dev-operator"
  };
}

export function activeWorkspaceId(context: ActiveWorkspaceContext = activeWorkspaceContext()): string {
  return workspaceIdOrDefault(context.activeWorkspaceId);
}

export function workspaceMembershipFor(
  workspaceId: string = activeWorkspaceId(),
  context: ActiveWorkspaceContext = activeWorkspaceContext()
): WorkspaceMembership | null {
  const normalizedWorkspaceId = workspaceIdOrDefault(workspaceId);
  return context.memberships.find((membership) => workspaceIdOrDefault(membership.workspaceId) === normalizedWorkspaceId) ?? null;
}

export function canUseWorkspace(
  permission: WorkspacePermission,
  workspaceId: string = activeWorkspaceId(),
  context: ActiveWorkspaceContext = activeWorkspaceContext()
): boolean {
  const membership = workspaceMembershipFor(workspaceId, context);
  if (!membership) {
    return false;
  }

  const allowed = rolePermissions[membership.role] ?? rolePermissions.viewer;
  return allowed.has("admin") || allowed.has(permission);
}

export function requireWorkspacePermission(
  permission: WorkspacePermission,
  workspaceId: string = activeWorkspaceId(),
  context: ActiveWorkspaceContext = activeWorkspaceContext()
): void {
  const normalizedWorkspaceId = workspaceIdOrDefault(workspaceId);
  if (!canUseWorkspace(permission, normalizedWorkspaceId, context)) {
    throw new WorkspaceAuthorizationError(permission, normalizedWorkspaceId);
  }
}

export function requireActiveWorkspacePermission(permission: WorkspacePermission): void {
  requireWorkspacePermission(permission, activeWorkspaceId());
}

export function withDefaultWorkspace<TValue extends object>(
  value: TValue & { workspaceId?: string | null }
): TValue & WorkspaceOwned {
  return {
    ...value,
    workspaceId: workspaceIdOrDefault(value.workspaceId)
  };
}

export function workspaceMatches(
  value: { workspaceId?: string | null },
  workspaceId: string = activeWorkspaceId()
): boolean {
  return workspaceIdOrDefault(value.workspaceId) === workspaceId;
}

export function filterWorkspaceItems<TValue extends object>(
  values: Array<TValue & { workspaceId?: string | null }>,
  workspaceId: string = activeWorkspaceId()
): Array<TValue & WorkspaceOwned> {
  return values.map(withDefaultWorkspace).filter((value) => workspaceMatches(value, workspaceId));
}
