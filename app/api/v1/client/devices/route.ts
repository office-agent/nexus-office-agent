import { NextResponse } from "next/server";
import { registerClientDeviceSchema } from "@/src/modules/client-platform/application/schemas";
import { getClientPlatformService } from "@/src/modules/client-platform/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse,parseJson } from "@/src/platform/http/api-response";

export const dynamic="force-dynamic";
export async function GET(request:Request){try{const context=await resolveRequestContext(request);return NextResponse.json({data:await getClientPlatformService().listDevices(context),meta:{traceId:context.traceId}},{headers:{"cache-control":"no-store"}});}catch(error){return applicationErrorResponse(error);}}
export async function POST(request:Request){try{const context=await resolveRequestContext(request);const input=registerClientDeviceSchema.parse(await parseJson(request));return NextResponse.json({data:await getClientPlatformService().registerDevice(context,input),meta:{traceId:context.traceId}},{status:201,headers:{"cache-control":"no-store"}});}catch(error){return applicationErrorResponse(error);}}
