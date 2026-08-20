import { ConnectorSecurityError } from "@/src/modules/integration/security/callback-crypto";

const entityMap: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(value: string): string {
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) return cdata[1];
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => entityMap[entity]);
}

export function parseFlatXml(xml: string): Record<string, string> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ConnectorSecurityError("PAYLOAD_INVALID");
  const root = xml.trim().match(/^<xml>([\s\S]*)<\/xml>$/i);
  if (!root) throw new ConnectorSecurityError("PAYLOAD_INVALID");
  const fields: Record<string, string> = {};
  const fieldPattern = /<([A-Za-z][\w.-]*)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = fieldPattern.exec(root[1]))) fields[match[1]] = decodeXml(match[2].trim());
  if (Object.keys(fields).length === 0) throw new ConnectorSecurityError("PAYLOAD_INVALID");
  return fields;
}

export function buildEncryptedXml(ciphertext: string): string {
  return `<xml><Encrypt><![CDATA[${ciphertext}]]></Encrypt></xml>`;
}
