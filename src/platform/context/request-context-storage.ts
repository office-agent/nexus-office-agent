import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "@/src/platform/context/request-context";

const storage=new AsyncLocalStorage<RequestContext>();
export function enterRequestContext(context:RequestContext):void{storage.enterWith(context);}
export function activeRequestContext():RequestContext|undefined{return storage.getStore();}
export function runWithRequestContext<T>(context:RequestContext, work:()=>Promise<T>):Promise<T>{return storage.run(context,work);}
