import { NextResponse } from "next/server";
import { clearSessionCookieHeader } from "@/src/platform/identity/session";

export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL("/", request.url), 303);
  response.headers.append("set-cookie", clearSessionCookieHeader());
  response.headers.set("cache-control", "no-store");
  return response;
}
