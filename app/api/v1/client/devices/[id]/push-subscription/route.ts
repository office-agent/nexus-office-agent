import { NextResponse } from "next/server";
import { pushSubscriptionSchema } from "@/src/modules/client-platform/application/schemas";
import { getClientDataEncryptionKey,getClientPlatformService } from "@/src/modules/client-platform/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse,parseJson } from "@/src/platform/http/api-response";
import { encryptSensitiveJson,sensitiveValueDigest } from "@/src/platform/security/encrypted-envelope";

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const context=await resolveRequestContext(request);const {id}=await params;const input=pushSubscriptionSchema.parse(await parseJson(request));const {key,keyRef}=await getClientDataEncryptionKey();const envelope=encryptSensitiveJson(input,key,`${context.tenantId}:${context.actorId}:${id}`);await getClientPlatformService().subscribe(context,id,{...envelope,keyRef,endpointDigest:sensitiveValueDigest(input.endpoint)});return NextResponse.json({data:{subscribed:true},meta:{traceId:context.traceId}},{status:201,headers:{"cache-control":"no-store"}});}catch(error){return applicationErrorResponse(error);}}
export async function DELETE(request:Request,{params}:{params:Promise<{id:string}>}){try{const context=await resolveRequestContext(request);const {id}=await params;await getClientPlatformService().unsubscribe(context,id);return NextResponse.json({data:{subscribed:false},meta:{traceId:context.traceId}},{headers:{"cache-control":"no-store"}});}catch(error){return applicationErrorResponse(error);}}
