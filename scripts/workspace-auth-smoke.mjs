import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workspaceSourcePath = path.join(repoRoot, "dashboard", "app", "lib", "workspace.ts");
const workspaceSource = await readFile(workspaceSourcePath, "utf8");
const { outputText } = ts.transpileModule(workspaceSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: workspaceSourcePath
});
const moduleContext = {
  exports: {},
  module: { exports: {} }
};
moduleContext.exports = moduleContext.module.exports;
vm.runInNewContext(outputText, moduleContext, { filename: workspaceSourcePath });

const {
  WorkspaceAuthorizationError,
  WorkspaceSessionError,
  activeWorkspaceContext,
  activeWorkspaceSession,
  canUseWorkspace,
  defaultWorkspaceId,
  localDevWorkspaceSession,
  normalizeWorkspaceSession,
  requireWorkspacePermission
} = moduleContext.module.exports;

const failures = [];

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function contextFor(role, workspaceId = defaultWorkspaceId) {
  return {
    activeWorkspaceId: workspaceId,
    memberships: [{ role, workspaceId }],
    userId: `${role}-smoke-user`
  };
}

function assertDenied(label, permission, context, workspaceId = defaultWorkspaceId) {
  try {
    requireWorkspacePermission(permission, workspaceId, context);
    failures.push(`${label}: expected ${permission} to be denied`);
  } catch (error) {
    assert(error instanceof WorkspaceAuthorizationError, `${label}: expected WorkspaceAuthorizationError`);
    assert(error.status === 403, `${label}: expected status 403`);
    assert(error.code === "workspace_forbidden", `${label}: expected workspace_forbidden code`);
  }
}

function assertInvalidSession(label, session) {
  try {
    normalizeWorkspaceSession(session);
    failures.push(`${label}: expected session normalization to fail`);
  } catch (error) {
    assert(error instanceof WorkspaceSessionError, `${label}: expected WorkspaceSessionError`);
    assert(error.status === 401, `${label}: expected status 401`);
    assert(error.code === "workspace_session_invalid", `${label}: expected workspace_session_invalid code`);
  }
}

const viewer = contextFor("viewer");
assert(canUseWorkspace("read", defaultWorkspaceId, viewer), "viewer can read");
assert(!canUseWorkspace("write", defaultWorkspaceId, viewer), "viewer cannot write");
assertDenied("viewer write", "write", viewer);

const operator = contextFor("operator");
assert(canUseWorkspace("publish", defaultWorkspaceId, operator), "operator can publish");
assert(canUseWorkspace("recover", defaultWorkspaceId, operator), "operator can recover");
assert(canUseWorkspace("activity", defaultWorkspaceId, operator), "operator can write activity evidence");
assert(!canUseWorkspace("write", defaultWorkspaceId, operator), "operator cannot edit content");
assertDenied("operator write", "write", operator);

const contentManager = contextFor("content-manager");
assert(canUseWorkspace("write", defaultWorkspaceId, contentManager), "content manager can write");
assert(canUseWorkspace("publish", defaultWorkspaceId, contentManager), "content manager can publish");
assert(!canUseWorkspace("recover", defaultWorkspaceId, contentManager), "content manager cannot recover");
assertDenied("content manager recovery", "recover", contentManager);

const admin = contextFor("workspace-admin");
for (const permission of ["activity", "admin", "publish", "read", "recover", "write"]) {
  assert(canUseWorkspace(permission, defaultWorkspaceId, admin), `workspace admin can ${permission}`);
}

assert(!canUseWorkspace("read", "workspace-other", viewer), "membership does not cross workspaces");
assertDenied("cross-workspace read", "read", viewer, "workspace-other");

const localSession = localDevWorkspaceSession();
assert(localSession.activeWorkspaceId === defaultWorkspaceId, "local session uses default workspace");
assert(localSession.user.userId === "local-dev-operator", "local session has stable user id");
assert(localSession.workspaces.some((workspace) => workspace.workspaceId === defaultWorkspaceId), "local session lists default workspace");

const normalizedSession = normalizeWorkspaceSession({
  activeWorkspaceId: "  workspace-client-a  ",
  memberships: [
    { role: "viewer", workspaceId: "workspace-client-a" },
    { role: "not-a-role", workspaceId: "workspace-client-b" }
  ],
  sessionId: " session-a ",
  user: {
    displayName: " Test User ",
    email: " test@example.com ",
    userId: " user-a "
  },
  workspaces: [
    { name: " Client A ", workspaceId: "workspace-client-a" },
    { name: " Client B ", workspaceId: "workspace-client-b" }
  ]
});
assert(normalizedSession.activeWorkspaceId === "workspace-client-a", "session normalizes active workspace");
assert(normalizedSession.memberships.length === 1, "session drops invalid roles");
assert(normalizedSession.user.email === "test@example.com", "session normalizes email");
assert(normalizedSession.workspaces[0]?.name === "Client A", "session keeps workspace display name");

const activeSession = activeWorkspaceSession();
const activeContext = activeWorkspaceContext(activeSession);
assert(activeContext.activeWorkspaceId === defaultWorkspaceId, "active context preserves session workspace");
assert(activeContext.userId === activeSession.user.userId, "active context preserves session user");
assert(canUseWorkspace("admin", defaultWorkspaceId, activeContext), "local session can administer default workspace");

assertInvalidSession("missing user", {
  activeWorkspaceId: defaultWorkspaceId,
  memberships: [{ role: "viewer", workspaceId: defaultWorkspaceId }]
});
assertInvalidSession("missing membership", {
  activeWorkspaceId: defaultWorkspaceId,
  memberships: [],
  user: { displayName: "Viewer", userId: "viewer" }
});
assertInvalidSession("active workspace outside membership", {
  activeWorkspaceId: "workspace-other",
  memberships: [{ role: "viewer", workspaceId: defaultWorkspaceId }],
  user: { displayName: "Viewer", userId: "viewer" }
});

if (failures.length > 0) {
  console.error("Workspace auth smoke failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Workspace auth smoke checks passed.");
