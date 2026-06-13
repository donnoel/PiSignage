import { NextResponse } from "next/server";
import { WorkspaceAuthorizationError } from "./workspace";

type ErrorWithStatus = Error & {
  code?: string;
  status?: number;
};

function statusFromError(error: unknown, fallbackStatus: number): number {
  if (error instanceof WorkspaceAuthorizationError) {
    return error.status;
  }

  if (error instanceof Error) {
    const status = (error as ErrorWithStatus).status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
      return status;
    }
  }

  return fallbackStatus;
}

export function apiErrorResponse(error: unknown, fallback: string, fallbackStatus = 500): NextResponse {
  const message = error instanceof Error ? error.message : fallback;
  const status = statusFromError(error, fallbackStatus);
  const code = error instanceof WorkspaceAuthorizationError ? error.code : undefined;

  return NextResponse.json(
    code ? { code, error: message } : { error: message },
    { status }
  );
}
