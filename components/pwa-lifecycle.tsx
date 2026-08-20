"use client";
import { useEffect } from "react";

export function PwaLifecycle(){useEffect(()=>{if(!("serviceWorker" in navigator))return;let active=true;navigator.serviceWorker.register("/sw.js",{scope:"/"}).then(registration=>{if(active)window.dispatchEvent(new CustomEvent("nexus:pwa-ready",{detail:{scope:registration.scope}}));}).catch(()=>{if(active)window.dispatchEvent(new Event("nexus:pwa-failed"));});return()=>{active=false;};},[]);return null;}
