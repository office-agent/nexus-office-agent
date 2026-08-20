// Explicit LAN-only runtime. This profile intentionally uses the local
// acceptance identity and must stay behind a trusted private network.
process.env.NODE_ENV = "production";
process.env.NEXUS_DEPLOYMENT_MODE = "lan";
process.env.NEXUS_ALLOW_DEMO_IDENTITY = "true";
process.env.LAN_STORAGE_MODE ??= "memory";
process.env.HOSTNAME ??= "0.0.0.0";
process.env.PORT ??= "3117";

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  if ((args[index] === "--origin" || args[index] === "--public-origin") && args[index + 1]) {
    process.env.PUBLIC_APP_ORIGIN = args[index + 1];
    index += 1;
  }
}

await import("./start-standalone.mjs");
