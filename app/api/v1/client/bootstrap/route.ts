import { NextResponse } from "next/server";
import { getClientPlatformService } from "@/src/modules/client-platform/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic="force-dynamic";
export async function GET(request:Request){
  try{const context=await resolveRequestContext(request);const url=new URL(request.url);const data=await getClientPlatformService().bootstrap(context,url.searchParams.get("installationId")??undefined,url.searchParams.get("appVersion")??undefined);return NextResponse.json({data,meta:{traceId:context.traceId,serverTime:new Date().toISOString()}},{headers:{"cache-control":"no-store"}});}catch(error){return applicationErrorResponse(error);}
}
