export const defaultWorkspaceId = "workspace-beam-dev";

export type WorkspaceOwned = {
  workspaceId: string;
};

export function workspaceIdOrDefault(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed || defaultWorkspaceId;
}

export function withDefaultWorkspace<TValue extends object>(
  value: TValue & { workspaceId?: string | null }
): TValue & WorkspaceOwned {
  return {
    ...value,
    workspaceId: workspaceIdOrDefault(value.workspaceId)
  };
}
