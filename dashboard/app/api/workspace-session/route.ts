import { NextResponse } from "next/server";
import { apiErrorResponse } from "../../lib/api-error-response";
import { activeWorkspaceSession, workspaceContextFromSession } from "../../lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = activeWorkspaceSession();
    const context = workspaceContextFromSession(session);

    return NextResponse.json({
      activeWorkspaceId: context.activeWorkspaceId,
      memberships: session.memberships,
      sessionId: session.sessionId,
      user: session.user,
      workspaces: session.workspaces
    });
  } catch (error) {
    return apiErrorResponse(error, "Workspace session is unavailable.");
  }
}
