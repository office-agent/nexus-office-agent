const CACHE_NAME="nexus-static-0.9.0";
const PRECACHE=["/offline.html","/manifest.webmanifest","/icons/nexus-192.svg","/icons/nexus-512.svg"];
self.addEventListener("install",event=>{event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(PRECACHE)).then(()=>self.skipWaiting()));});
self.addEventListener("activate",event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith("nexus-static-")&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener("fetch",event=>{
  const request=event.request;if(request.method!=="GET")return;const url=new URL(request.url);if(url.origin!==self.location.origin)return;
  if(url.pathname.startsWith("/api/")||url.pathname.startsWith("/auth/"))return;
  if(request.mode==="navigate"){event.respondWith(fetch(request).catch(()=>caches.match("/offline.html")));return;}
  const staticAsset=url.pathname.startsWith("/_next/static/")||url.pathname.startsWith("/icons/")||PRECACHE.includes(url.pathname);
  if(staticAsset)event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok&&response.type==="basic")caches.open(CACHE_NAME).then(cache=>cache.put(request,response.clone()));return response;})));
});
self.addEventListener("push",event=>{let path="/";try{const data=event.data?.json();if(typeof data?.path==="string"&&data.path.startsWith("/")&&!data.path.startsWith("//"))path=data.path;}catch{}event.waitUntil(self.registration.showNotification("枢纽有新的工作更新",{body:"打开平台查看详情。",icon:"/icons/nexus-192.svg",badge:"/icons/nexus-192.svg",data:{path},tag:"nexus-work-update"}));});
self.addEventListener("notificationclick",event=>{event.notification.close();const path=event.notification.data?.path||"/";event.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(clients=>{for(const client of clients){if("focus" in client){client.navigate(path);return client.focus();}}return self.clients.openWindow(path);}));});
self.addEventListener("message",event=>{if(event.data?.type==="CLEAR_STATIC_CACHE")event.waitUntil(caches.delete(CACHE_NAME));});
