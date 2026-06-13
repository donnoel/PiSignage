export const defaultWorkspaceId = "workspace-beam-dev";

export type WorkspaceOwned = {
  workspaceId: string;
};

export type WorkspaceRole = "content-manager" | "operator" | "platform-admin" | "viewer" | "workspace-admin";

export type WorkspaceMembership = {
  role: WorkspaceRole;
  workspaceId: string;
};

export type ActiveWorkspaceContext = {
  activeWorkspaceId: string;
  memberships: WorkspaceMembership[];
  userId: string;
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
