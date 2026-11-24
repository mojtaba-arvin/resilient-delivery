import {describe,expect,it,vi} from "vitest";
import {ResilientClient} from "../src/client.js";

describe("ResilientClient",()=>{
 it("fails over only across configured origins",async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response("down",{status:503})).mockResolvedValueOnce(new Response("ok"));
  const c=new ResilientClient({primaryOrigin:"https://api.test",fallbackOrigins:["https://backup.test"],fetch,random:()=>0.5,sleep:async()=>{}});
  const r=await c.fetch("/health");
  expect(r.status).toBe(200); expect(fetch).toHaveBeenCalledTimes(2);
  expect(new Set(fetch.mock.calls.map(([u])=>new URL(String(u)).origin))).toEqual(new Set(["https://api.test","https://backup.test"]));
 });
 it("does not retry POST without an idempotency key",async()=>{
  const fetch=vi.fn().mockRejectedValue(new TypeError("offline"));
  const c=new ResilientClient({primaryOrigin:"https://api.test",fallbackOrigins:["https://backup.test"],fetch});
  await expect(c.fetch("/pay",{method:"POST",body:"{}"})).rejects.toThrow("offline");
  expect(fetch).toHaveBeenCalledTimes(1);
 });
 it("retries POST only when an idempotency key is supplied",async()=>{
  const fetch=vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(new Response("created",{status:201}));
  const c=new ResilientClient({primaryOrigin:"https://api.test",fallbackOrigins:["https://backup.test"],fetch,sleep:async()=>{},random:()=>0.5});
  expect((await c.fetch("/pay",{method:"POST",headers:{"Idempotency-Key":"key-1"},body:"{}"})).status).toBe(201);
  expect(fetch).toHaveBeenCalledTimes(2);
 });
 it("rejects unlisted absolute origins before network I/O",async()=>{
  const fetch=vi.fn(); const c=new ResilientClient({primaryOrigin:"https://api.test",fetch});
  await expect(c.fetch("https://other.test/x")).rejects.toThrow("allowlist"); expect(fetch).not.toHaveBeenCalled();
 });
 it("rejects protocol-relative URLs outside the allowlist",async()=>{
  const fetch=vi.fn(); const c=new ResilientClient({primaryOrigin:"https://api.test",fetch});
  await expect(c.fetch("//outside.test/path")).rejects.toThrow("allowlist"); expect(fetch).not.toHaveBeenCalled();
 });
 it("rejects automatic redirects that could escape the allowlist",async()=>{
  const fetch=vi.fn(); const c=new ResilientClient({primaryOrigin:"https://api.test",fetch});
  await expect(c.fetch("/",{redirect:"follow"})).rejects.toThrow("redirect");
  expect(fetch).not.toHaveBeenCalled();
 });
 it("uses redirect:error by default",async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(null,{status:204}));
  const c=new ResilientClient({primaryOrigin:"https://api.test",fetch});
  await c.fetch("/");
  expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
 });
 it("does not mark a route unhealthy for ordinary application 4xx responses",async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response("not found",{status:404}));
  const c=new ResilientClient({primaryOrigin:"https://api.test",fetch});
  await c.fetch("/");
  expect(c.getRouteScores()[0]).toEqual({alpha:2,beta:1});
 });
 it("fails over after a per-attempt deadline",async()=>{
  const fetch=vi.fn((_url: URL, init?: RequestInit)=>new Promise<Response>((_resolve,reject)=>{
   init?.signal?.addEventListener("abort",()=>reject(init.signal?.reason),{once:true});
  }));
  const c=new ResilientClient({primaryOrigin:"https://api.test",fallbackOrigins:["https://backup.test"],fetch,timeoutMs:5,sleep:async()=>{},random:()=>0.5});
  await expect(c.fetch("/health")).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(2);
 });
 it("does not fail over when the caller cancels",async()=>{
  const controller=new AbortController();
  const fetch=vi.fn((_url: URL, init?: RequestInit)=>new Promise<Response>((_resolve,reject)=>{
   init?.signal?.addEventListener("abort",()=>reject(init.signal?.reason),{once:true});
  }));
  const c=new ResilientClient({primaryOrigin:"https://api.test",fallbackOrigins:["https://backup.test"],fetch,timeoutMs:1000});
  const pending=c.fetch("/health",{signal:controller.signal});
  controller.abort(new DOMException("caller cancelled","AbortError"));
  await expect(pending).rejects.toThrow("caller cancelled");
  expect(fetch).toHaveBeenCalledTimes(1);
 });
 it("rejects more than 32 configured routes because collector route indexes are 0–31",()=>{
  const fallbackOrigins=Array.from({length:32},(_,i)=>"https://backup-"+i+".test");
  expect(()=>new ResilientClient({primaryOrigin:"https://api.test",fallbackOrigins})).toThrow("At most 32");
 });
 it("rounds observation durations to integer milliseconds",async()=>{
  const onObservation=vi.fn(),fetch=vi.fn().mockResolvedValue(new Response("ok"));
  const now=vi.fn().mockReturnValueOnce(100.2).mockReturnValueOnce(101.8);
  const c=new ResilientClient({primaryOrigin:"https://api.test",fetch,onObservation,telemetryConsent:true,now});
  await c.fetch("/");
  expect(onObservation.mock.calls[0]?.[0]?.durationMs).toBe(2);
  expect(Number.isInteger(onObservation.mock.calls[0]?.[0]?.durationMs)).toBe(true);
 });
 it("caps observation durations at the collector's 10-minute maximum",async()=>{
  const onObservation=vi.fn(),fetch=vi.fn().mockResolvedValue(new Response("ok"));
  const now=vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(700_000.8);
  const c=new ResilientClient({primaryOrigin:"https://api.test",fetch,onObservation,telemetryConsent:true,now});
  await c.fetch("/");
  expect(onObservation.mock.calls[0]?.[0]?.durationMs).toBe(600_000);
 });
 it("validates timeout and retry-delay bounds",()=>{
  expect(()=>new ResilientClient({primaryOrigin:"https://api.test",timeoutMs:0})).toThrow(RangeError);
  expect(()=>new ResilientClient({primaryOrigin:"https://api.test",retryBaseDelayMs:100,retryMaxDelayMs:50})).toThrow(RangeError);
 });
 it("does not let a telemetry callback break delivery",async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response("ok"));
  const c=new ResilientClient({primaryOrigin:"https://api.test",fetch,telemetryConsent:true,onObservation:()=>{throw new Error("observer failure");}});
  expect((await c.fetch("/")).status).toBe(200);
 });
 it("does not emit telemetry without consent",async()=>{
  const onObservation=vi.fn(),fetch=vi.fn().mockResolvedValue(new Response("ok"));
  const c=new ResilientClient({primaryOrigin:"https://api.test",fetch,onObservation});
  await c.fetch("/"); expect(onObservation).not.toHaveBeenCalled();
 });
 it("emits minimized observations only after consent",async()=>{
  const onObservation=vi.fn(),fetch=vi.fn().mockResolvedValue(new Response("ok"));
  const c=new ResilientClient({primaryOrigin:"https://api.test",fetch,onObservation,telemetryConsent:true,now:(()=>{let n=0;return()=>++n;})()});
  await c.fetch("/");
  expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({schemaVersion:1,routeIndex:0,outcome:"success",durationMs:1}));
  expect(JSON.stringify(onObservation.mock.calls)).not.toContain("api.test");
 });
});
