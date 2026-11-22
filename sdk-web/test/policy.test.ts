import {beforeAll,describe,expect,it} from "vitest";
import {verifyPolicyBundle, type PolicyBundle, type PolicyVersionStore} from "../src/policy.js";

let publicKeyBase64: string;
let privateKey: CryptoKey;
function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record=value as Record<string,unknown>;
  return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
async function signedBundle(version=1): Promise<PolicyBundle> {
  const payload={schema_version:1 as const,policy_version:version,issued_at:1_900_000_000,expires_at:1_900_000_600,origins:["https://api.test","https://backup.test"],max_attempts:2};
  const signature=await crypto.subtle.sign({name:"Ed25519"},privateKey,new TextEncoder().encode(canonical(payload)));
  return {...payload,signature:{algorithm:"Ed25519",key_id:"test-key",value:base64(signature)}};
}
function store(): PolicyVersionStore & {highest:number} {
  return {highest:0,async advanceIfNewer(version:number){if(version<=this.highest)return false;this.highest=version;return true;}};
}
const options=(versionStore:PolicyVersionStore,now=1_900_000_100)=>({
  publicKeys:{"test-key":publicKeyBase64},
  allowedOrigins:["https://api.test","https://backup.test","https://third.test"],
  versionStore,now,
});
beforeAll(async()=>{
  const pair=await crypto.subtle.generateKey({name:"Ed25519"},true,["sign","verify"]) as CryptoKeyPair;
  privateKey=pair.privateKey;
  publicKeyBase64=base64(await crypto.subtle.exportKey("raw",pair.publicKey));
});
describe("verifyPolicyBundle",()=>{
 it("verifies an owner signature and returns a narrowed immutable policy",async()=>{
  const versionStore=store(),bundle=await signedBundle();
  const verified=await verifyPolicyBundle(bundle,options(versionStore));
  expect(verified).toEqual({schemaVersion:1,version:1,issuedAt:1_900_000_000,expiresAt:1_900_000_600,origins:["https://api.test","https://backup.test"],maxAttempts:2});
  expect(Object.isFrozen(verified)).toBe(true);
  expect(Object.isFrozen(verified.origins)).toBe(true);
  expect(versionStore.highest).toBe(1);
 });
 it("rejects any payload mutation",async()=>{
  const bundle=await signedBundle(); bundle.expires_at++;
  await expect(verifyPolicyBundle(bundle,options(store()))).rejects.toThrow("signature");
 });
 it("rejects unknown signing keys",async()=>{
  const bundle=await signedBundle(); bundle.signature.key_id="unknown";
  await expect(verifyPolicyBundle(bundle,options(store()))).rejects.toThrow("Unknown policy signing key");
 });
 it("rejects expired and future-issued policies",async()=>{
  const bundle=await signedBundle();
  await expect(verifyPolicyBundle(bundle,options(store(),1_900_000_700))).rejects.toThrow("currently valid");
  await expect(verifyPolicyBundle(bundle,options(store(),1_899_999_000))).rejects.toThrow("currently valid");
 });
 it("rejects a policy that expands the owner origin allowlist",async()=>{
  const bundle=await signedBundle(); bundle.origins.push("https://not-approved.test");
  await expect(verifyPolicyBundle(bundle,options(store()))).rejects.toThrow("cannot expand");
 });
 it("rejects replayed or rolled-back policy versions",async()=>{
  const versionStore=store(),bundle=await signedBundle(4),opts=options(versionStore);
  await verifyPolicyBundle(bundle,opts);
  await expect(verifyPolicyBundle(bundle,opts)).rejects.toThrow("rollback or replay");
  await expect(verifyPolicyBundle(await signedBundle(3),opts)).rejects.toThrow("rollback or replay");
  expect(versionStore.highest).toBe(4);
 });
 it("rejects malformed signature bytes and non-HTTPS origins",async()=>{
  const badSignature=await signedBundle(); badSignature.signature.value="not-base64";
  await expect(verifyPolicyBundle(badSignature,options(store()))).rejects.toThrow("base64");
  const badOrigin=await signedBundle(); badOrigin.origins=["http://api.test"];
  await expect(verifyPolicyBundle(badOrigin,options(store()))).rejects.toThrow("HTTPS origins");
 });
 it("rejects invalid attempt limits and duplicate origins",async()=>{
  const tooMany=await signedBundle(); tooMany.max_attempts=9;
  await expect(verifyPolicyBundle(tooMany,options(store()))).rejects.toThrow("max_attempts");
  const duplicate=await signedBundle(); duplicate.origins=["https://api.test","https://api.test"];
  await expect(verifyPolicyBundle(duplicate,options(store()))).rejects.toThrow("unique");
 });
});
