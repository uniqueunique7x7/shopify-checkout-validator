import { NextResponse, type NextRequest } from "next/server";

/**
 * Security headers for the local dashboard. The backend is expected to be
 * reachable only from this machine, so CSP stays tight by default.
 */
export function middleware(_request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
