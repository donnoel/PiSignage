function firstForwardedValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

export function publicOriginForRequest(request: Request): string {
  const configured = process.env.BEAM_PUBLIC_DASHBOARD_URL?.trim().replace(/\/+$/, "");
  if (configured) {
    return configured;
  }

  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"));
  if (forwardedHost) {
    const forwardedProto = firstForwardedValue(request.headers.get("x-forwarded-proto")) ?? "https";
    return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, "");
  }

  return new URL(request.url).origin;
}

export function publicUrlForRequest(request: Request, pathname: string): string {
  return new URL(pathname, `${publicOriginForRequest(request)}/`).toString();
}
