// Requirements: PR-004, PR-007, AR-011, AR-012, SR-003, SR-005, AC-008
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe,expect,it } from "vitest";
import manifest from "@/app/manifest";

describe("PWA security boundary",()=>{
  it("publishes an installable standalone manifest with safe relative shortcuts",()=>{const value=manifest();expect(value).toMatchObject({display:"standalone",start_url:"/?source=pwa",scope:"/"});expect(value.icons).toEqual(expect.arrayContaining([expect.objectContaining({sizes:"192x192"}),expect.objectContaining({sizes:"512x512"})]));expect(value.shortcuts?.every(shortcut=>shortcut.url.startsWith("/")&&!shortcut.url.startsWith("//"))).toBe(true);});
  it("keeps APIs and business navigations out of Cache Storage",async()=>{const worker=await readFile(path.resolve("public/sw.js"),"utf8");expect(worker).toContain('url.pathname.startsWith("/api/")');expect(worker).toContain('request.mode==="navigate"');expect(worker).toContain('fetch(request).catch(()=>caches.match("/offline.html"))');const precache=worker.match(/const PRECACHE=\[(.*?)\]/)?.[1]??"";expect(precache).not.toContain("/api/");expect(precache).not.toContain('"/"');});
  it("uses a generic offline page without seeded enterprise facts",async()=>{const offline=await readFile(path.resolve("public/offline.html"),"utf8");expect(offline).toContain("不包含任何企业或个人业务信息");expect(offline).not.toContain("曜石科技");expect(offline).not.toContain("华东");});
  it("ships public PWA assets in the non-root production image",async()=>{const dockerfile=await readFile(path.resolve("Dockerfile"),"utf8");expect(dockerfile).toContain("/app/public ./public");expect(dockerfile).toContain("USER nexus");});
});
