import { NextResponse } from "next/server";
import { getClientPlatformService } from "@/src/modules/client-platform/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const context=await resolveRequestContext(request);const {id}=await params;return NextResponse.json({data:await getClientPlatformService().revoke(context,id),meta:{traceId:context.traceId}},{headers:{"cache-control":"no-store"}});}catch(error){return applicationErrorResponse(error);}}
