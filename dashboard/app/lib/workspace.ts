export const defaultWorkspaceId = "workspace-beam-dev";

export type WorkspaceOwned = {
  workspaceId: string;
};

export type WorkspaceRole = "content-manager" | "operator" | "platform-admin" | "viewer" | "workspace-admin";

export type WorkspacePermission = "activity" | "admin" | "publish" | "read" | "recover" | "write";

export type WorkspaceRecord = {
  name: string;
  workspaceId: string;
};

export type WorkspaceMembership = {
  role: WorkspaceRole;
  workspaceId: string;
};

export type WorkspaceSessionUser = {
  displayName: string;
  email?: string;
  userId: string;
};

export type WorkspaceUserSession = {
  activeWorkspaceId: string;
  memberships: WorkspaceMembership[];
  sessionId: string;
  user: WorkspaceSessionUser;
  workspaces: WorkspaceRecord[];
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

export class WorkspaceSessionError extends Error {
  code = "workspace_session_invalid";
  status = 401;

  constructor(message = "Workspace session is invalid.") {
    super(message);
    this.name = "WorkspaceSessionError";
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

function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return (
    value === "content-manager" ||
    value === "operator" ||
    value === "platform-admin" ||
    value === "viewer" ||
    value === "workspace-admin"
  );
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function localDevWorkspaceSession(): WorkspaceUserSession {
  return {
    activeWorkspaceId: defaultWorkspaceId,
    memberships: [
      {
        role: "platform-admin",
        workspaceId: defaultWorkspaceId
      }
    ],
    sessionId: "local-dev-session",
    user: {
      displayName: "Local dev operator",
      userId: "local-dev-operator"
    },
    workspaces: [
      {
        name: "Beam Dev",
        workspaceId: defaultWorkspaceId
      }
    ]
  };
}

export function normalizeWorkspaceSession(value: unknown): WorkspaceUserSession {
  if (!isRecord(value)) {
    throw new WorkspaceSessionError();
  }

  const user = isRecord(value.user) ? value.user : null;
  const userId = normalizedString(user?.userId);
  const displayName = normalizedString(user?.displayName) || userId;
  const email = normalizedString(user?.email);
  const memberships = Array.isArray(value.memberships)
    ? value.memberships
        .filter(isRecord)
        .map((membership) => ({
          role: membership.role,
          workspaceId: workspaceIdOrDefault(normalizedString(membership.workspaceId))
        }))
        .filter((membership): membership is WorkspaceMembership => isWorkspaceRole(membership.role))
    : [];
  const uniqueMemberships = Array.from(
    new Map(memberships.map((membership) => [membership.workspaceId, membership])).values()
  );
  const activeWorkspaceId = workspaceIdOrDefault(normalizedString(value.activeWorkspaceId));

  if (!userId || uniqueMemberships.length === 0) {
    throw new WorkspaceSessionError();
  }

  if (!uniqueMemberships.some((membership) => membership.workspaceId === activeWorkspaceId)) {
    throw new WorkspaceSessionError("Active workspace is not in the user's memberships.");
  }

  const workspaceNames = new Map<string, string>();
  if (Array.isArray(value.workspaces)) {
    for (const workspace of value.workspaces.filter(isRecord)) {
      const workspaceId = workspaceIdOrDefault(normalizedString(workspace.workspaceId));
      const name = normalizedString(workspace.name);
      if (name) {
        workspaceNames.set(workspaceId, name);
      }
    }
  }

  return {
    activeWorkspaceId,
    memberships: uniqueMemberships,
    sessionId: normalizedString(value.sessionId) || `session-${userId}`,
    user: {
      displayName,
      ...(email ? { email } : {}),
      userId
    },
    workspaces: uniqueMemberships.map((membership) => ({
      name: workspaceNames.get(membership.workspaceId) ?? membership.workspaceId,
      workspaceId: membership.workspaceId
    }))
  };
}

export function activeWorkspaceSession(): WorkspaceUserSession {
  return normalizeWorkspaceSession(localDevWorkspaceSession());
}

export function workspaceContextFromSession(session: WorkspaceUserSession): ActiveWorkspaceContext {
  const normalizedSession = normalizeWorkspaceSession(session);
  return {
    activeWorkspaceId: normalizedSession.activeWorkspaceId,
    memberships: normalizedSession.memberships.map((membership) => ({
      ...membership,
      workspaceId: workspaceIdOrDefault(membership.workspaceId)
    })),
    userId: normalizedSession.user.userId
  };
}

export function activeWorkspaceContext(session: WorkspaceUserSession = activeWorkspaceSession()): ActiveWorkspaceContext {
  return workspaceContextFromSession(session);
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
