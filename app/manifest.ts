import type { MetadataRoute } from "next";

export default function manifest():MetadataRoute.Manifest{return {
  id:"/",name:"枢纽 · 统一办公平台 Agent",short_name:"枢纽办公",description:"目标、项目、审批、知识与企业 Agent 的统一管理工作台。",start_url:"/?source=pwa",scope:"/",display:"standalone",orientation:"any",background_color:"#f4f1e9",theme_color:"#14272c",lang:"zh-CN",categories:["business","productivity"],
  icons:[{src:"/icons/nexus-192.svg",sizes:"192x192",type:"image/svg+xml",purpose:"any"},{src:"/icons/nexus-512.svg",sizes:"512x512",type:"image/svg+xml",purpose:"maskable"}],
  shortcuts:[
    {name:"今日工作台",short_name:"今日",url:"/?view=today",icons:[{src:"/icons/nexus-192.svg",sizes:"192x192",type:"image/svg+xml"}]},
    {name:"项目与任务",short_name:"项目",url:"/?view=projects",icons:[{src:"/icons/nexus-192.svg",sizes:"192x192",type:"image/svg+xml"}]},
    {name:"智能审批",short_name:"审批",url:"/?view=approvals",icons:[{src:"/icons/nexus-192.svg",sizes:"192x192",type:"image/svg+xml"}]},
  ],
};}
