import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ModeTransition, transitionTeardown, type TransitionRequest, type TransitionHooks } from "../src/transition";
import { handleRequest, type RuntimeSettings } from "../src/router";
const env: RuntimeSettings = {
  FEED_ENVIRONMENT: "production", FEED_IMAGE_BUILD_ID: "d".repeat(64), FEED_RELEASE_SHA: "a".repeat(40),
  FEED_IMAGE_REFERENCE: `registry.cloudflare.com/8f19bebe359e4ec1a24c68c5f49c1584/ghfind-feed@sha256:${"b".repeat(64)}`,
  FEED_MODE: "baseline", FEED_WRITER_EPOCH: "1", FEED_EXECUTOR_ENABLED: "true", FEED_SOURCE_RELAY_ENABLED: "true",
  FEED_QUEUE_NAME: "ghfind-feed-production-jobs", FEED_DLQ_NAME: "ghfind-feed-production-dlq",
  FEED_GATEWAY_SECRET: "g".repeat(32), FEED_SIGNING_SECRET: "s".repeat(32), FEED_BRIDGE_SECRET: "b".repeat(32),
  FEED_RUNTIME_ADMIN_SECRET: "r".repeat(32), FEED_EXECUTOR_SECRET: "e".repeat(32), FEED_SOURCE_SECRET: "q".repeat(32), FEED_DELIVERY_SECRET: "d".repeat(32),
  WORKER_VERSION: { id: "12345678-1234-4234-8234-123456789012", tag: "test", timestamp: "2026-09-09T00:00:00Z" },
};
const input: TransitionRequest = {sourceSha: env.FEED_RELEASE_SHA, imageBuildId: env.FEED_IMAGE_BUILD_ID!, mode: "baseline", writerEpoch: 1};
function fixture(patch: Record<string, unknown> = {}) {
  const state = { running: true, actorId: "1".repeat(64), mode: "off", stops: 0, starts: 0 };
  const hooks: TransitionHooks = {
    state: () => ({running: state.running, actorId: state.actorId}),
    fetch: async () => Response.json({ ready: true, version: env.FEED_RELEASE_SHA, imageBuildId: env.FEED_IMAGE_BUILD_ID,
      contractVersion: "1", storageWriterVersion: 2, storeProfile: "cf_d1_r2", service: "feed-api", writerEpoch: 1, mode: state.mode, ...patch }),
    stop: async () => { state.stops++; state.running = false; },
    start: async () => { assert.equal(state.running, false); state.starts++; state.running = true; state.mode = "baseline"; },
  };
  return { state, hooks };
}
const limits = {totalMs: 150, stopMs: 25, pollMs: 1};
test("pinned SDK start leaves running off-mode environment unchanged until native exit", async () => {
  const sdk = readFileSync(new URL("../node_modules/@cloudflare/containers/dist/lib/container.js", import.meta.url), "utf8");
  const start = sdk.indexOf("    async startContainerIfNotRunning(waitOptions, options) {");
  const end = sdk.indexOf("    async doStartContainer(", start);
  assert.ok(start >= 0 && end > start);
  const method = Function(`return ({${sdk.slice(start, end)}})`)().startContainerIfNotRunning;
  const instance = { container: { running: true, monitor: () => ({}) }, envVars: {mode:"baseline"}, actualMode: "off", starts: 0,
    async doStartContainer() { this.starts++; this.actualMode = this.envVars.mode; } };
  await method.call(instance, {});
  assert.equal(instance.actualMode, "off"); assert.equal(instance.starts, 0);
  instance.container.running = false;
  await method.call(instance, {});
  assert.equal(instance.actualMode, "baseline"); assert.equal(instance.starts, 1);
  const stopAt = sdk.indexOf("    async stop(signal = 'SIGTERM') {");
  const destroyAt = sdk.indexOf("    async destroy()", stopAt);
  const stop = Function("signalToNumbers", `return ({${sdk.slice(stopAt, destroyAt)}}).stop`)({SIGTERM:15});
  let signals = 0;
  const stillRunning = {container:{running:true,signal:()=>{signals++;}},syncPendingStoppedEvents:async()=>{}};
  await stop.call(stillRunning);
  assert.equal(signals,1); assert.equal(stillRunning.container.running,true);
  const onStartAt = sdk.indexOf("    onStart()", destroyAt);
  assert.ok(onStartAt > destroyAt);
  const destroy = Function(`return ({${sdk.slice(destroyAt, onStartAt)}})` )().destroy;
  let destroyed = 0;
  await destroy.call({container:{destroy:async()=>{destroyed++;}}});
  assert.equal(destroyed,1);
});
test("off teardown destroys the instance; baseline still SIGTERM-stops the current image", async () => {
  const calls: string[] = [];
  const sdk = {
    destroy: async () => { calls.push("destroy"); },
    stop: async (signal: "SIGTERM") => { calls.push(`stop:${signal}`); },
  };
  await transitionTeardown("off", sdk);
  await transitionTeardown("baseline", sdk);
  assert.deepEqual(calls, ["destroy", "stop:SIGTERM"]);
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.equal(source.split("transitionTeardown(input.mode").length - 1, 2);
  assert.equal(source.split("super.destroy()").length - 1, 2);
  assert.equal(source.split('instance(target).stop("SIGTERM")').length - 1, 1);
});
test("off to baseline waits for native stop, applies new env, then verifies the actual binary", async () => {
  const f = fixture();
  f.hooks.stop = async () => { f.state.stops++; setTimeout(() => {f.state.running = false;}, 5); };
  const result = await new ModeTransition(limits).run("api-0", env, input, f.hooks);
  assert.deepEqual(result, {restarted:true, target:"api-0", ...input});
  assert.equal(f.state.stops, 1); assert.equal(f.state.starts, 1);
});
test("stopped native actor starts without pretending an old process could be probed", async () => {
  const f = fixture(); f.state.running = false;
  await new ModeTransition(limits).run("api-0", env, input, f.hooks);
  assert.equal(f.state.stops, 0); assert.equal(f.state.starts, 1);
});
test("wrong process identity is rejected before any lifecycle mutation", async () => {
  for (const patch of [{version:"b".repeat(40)}, {imageBuildId:"e".repeat(64)}, {contractVersion:"2"},
    {storageWriterVersion:1}, {writerEpoch:2}, {storeProfile:"postgres"}, {service:"feed-worker"}, {mode:"unknown"}]) {
    const f = fixture(patch);
    await assert.rejects(new ModeTransition(limits).run("api-0", env, input, f.hooks), /container_version_or_contract_mismatch/);
    assert.equal(f.state.stops,0); assert.equal(f.state.starts,0);
  }
});
test("SIGTERM acknowledgement without exit fails at stop deadline without start", async () => {
  const f=fixture(); f.hooks.stop=async()=>{ f.state.stops++; };
  await assert.rejects(new ModeTransition(limits).run("api-0",env,input,f.hooks), /transition_stop_timeout/);
  assert.equal(f.state.starts,0);
});
test("hung stop keeps actor locked after timeout until underlying work settles",async()=>{
  const f=fixture(); let release!:()=>void;
  f.hooks.stop=()=>new Promise<void>(resolve=>{release=resolve;});
  const transition=new ModeTransition(limits);
  await assert.rejects(transition.run("api-0",env,input,f.hooks), /transition_stop_timeout/);
  await assert.rejects(transition.run("api-0",env,input,f.hooks), /transition_in_progress/);
  release(); await new Promise(resolve=>setTimeout(resolve,1)); assert.equal(f.state.starts,0);
});
test("start timeout aborts and cannot subsequently produce success or allow concurrent restart",async()=>{
  const f=fixture(); let release!:()=>void; let signal:AbortSignal|undefined;
  f.hooks.start=(abort)=>{signal=abort; return new Promise<void>(resolve=>{release=resolve;});};
  const transition=new ModeTransition({totalMs:30,stopMs:20,pollMs:1});
  await assert.rejects(transition.run("api-0",env,input,f.hooks),/transition_timeout/);
  assert.equal(signal?.aborted,true);
  await assert.rejects(transition.run("api-0",env,input,f.hooks),/transition_in_progress/);
  release(); await new Promise(resolve=>setTimeout(resolve,1));
});
test("same baseline recovery is allowed but a restart preserving off env fails strict final proof",async()=>{
  const good=fixture();good.state.mode="baseline";
  await new ModeTransition(limits).run("api-0",env,input,good.hooks);
  const bad=fixture();bad.hooks.start=async()=>{bad.state.running=true;};
  await assert.rejects(new ModeTransition(limits).run("api-0",env,input,bad.hooks),/container_version_or_contract_mismatch/);
});
test("production restart route requires exact authenticated bounded contract and only fixed actors",async()=>{
  let calls=0;
  const dispatch={fetch:async()=>Response.json({}),stop:async()=>{},restart:async(target:string,data:TransitionRequest)=>{calls++;return {restarted:true,target,...data};}};
  const request=(path:string,body:unknown=input,auth=env.FEED_RUNTIME_ADMIN_SECRET)=>new Request(`https://runtime/internal/runtime/${path}`,{
    method:"POST",headers:{authorization:`Bearer ${auth}`},body:JSON.stringify(body)});
  assert.equal((await handleRequest(request("api-0/restart"),env,dispatch)).status,200);
  for(const body of [{...input,sourceSha:"b".repeat(40)},{...input,imageBuildId:"b".repeat(64)},{...input,writerEpoch:2},{...input,mode:"off"},{...input,extra:true},null])
    assert.equal((await handleRequest(request("api-0/restart",body),env,dispatch)).status,400);
  assert.equal((await handleRequest(request("api-0/restart",input,"x"),env,dispatch)).status,401);
  assert.equal((await handleRequest(request("api-3/restart"),env,dispatch)).status,404);
  assert.equal((await handleRequest(request("api-0/restart?x=1"),env,dispatch)).status,404);
  const stale = await handleRequest(request("api-0/restart"),{...env,FEED_MODE:"off"},dispatch);
  assert.equal(stale.status,409);
  assert.deepEqual(await stale.json(),{error:"transition_environment_not_ready",workerVersionId:env.WORKER_VERSION.id});
  assert.equal(stale.headers.get("cache-control"),"no-store");
  for(const body of [{...input,sourceSha:"b".repeat(40)},{...input,imageBuildId:"b".repeat(64)},{...input,writerEpoch:2},{...input,extra:true},null])
    assert.equal((await handleRequest(request("api-0/restart",body),{...env,FEED_MODE:"off"},dispatch)).status,400);
  const staging={...env,FEED_ENVIRONMENT:"staging",FEED_QUEUE_NAME:"ghfind-feed-staging-jobs",FEED_DLQ_NAME:"ghfind-feed-staging-dlq"};
  assert.equal((await handleRequest(request("api-0/restart"),staging,dispatch)).status,405);
  assert.equal((await handleRequest(request("executor-0/restart"),{...env,FEED_EXECUTOR_ENABLED:"false"},dispatch)).status,503);
  const malformed=new Request("https://runtime/internal/runtime/api-0/restart",{method:"POST",headers:{authorization:`Bearer ${env.FEED_RUNTIME_ADMIN_SECRET}`},body:"{"});
  assert.equal((await handleRequest(malformed,env,dispatch)).status,400);
  assert.equal((await handleRequest(request("api-0/restart",{...input,extra:"x".repeat(1024)}),env,dispatch)).status,413);
  assert.equal(calls,1);
});

test("authenticated configuration reports exact edge identity without touching any actor",async()=>{
  const forbidden=async()=>{assert.fail("configuration must not invoke an actor");};
  const dispatch={fetch:forbidden,stop:forbidden,restart:forbidden,probe:forbidden,actorId:()=>{assert.fail("configuration must not resolve an actor");}};
  const request=(path="/internal/runtime/configuration",auth=env.FEED_RUNTIME_ADMIN_SECRET,method="GET")=>
    new Request(`https://runtime${path}`,{method,headers:{authorization:`Bearer ${auth}`}});
  for(const mode of ["off","baseline"] as const){
    const result=await handleRequest(request(),{...env,FEED_MODE:mode},dispatch);
    assert.equal(result.status,200);assert.equal(result.headers.get("cache-control"),"no-store");
    assert.deepEqual(await result.json(),{service:"feed-runtime",version:env.FEED_RELEASE_SHA,contractVersion:"1",
      workerVersionId:env.WORKER_VERSION.id,configuredImage:env.FEED_IMAGE_REFERENCE,imageBuildId:env.FEED_IMAGE_BUILD_ID,mode,writerEpoch:1});
  }
  assert.equal((await handleRequest(request(undefined,"wrong"),env,dispatch)).status,401);
  assert.equal((await handleRequest(request("/internal/runtime/configuration?x=1"),env,dispatch)).status,404);
  assert.equal((await handleRequest(request(undefined,undefined,"POST"),env,dispatch)).status,404);
  assert.equal((await handleRequest(request(),{...env,FEED_IMAGE_BUILD_ID:"invalid"},dispatch)).status,503);
});

test("final dependency failure or actor drift after stop cannot grant a restart receipt",async()=>{
  for(const failure of ["dependency","actor"]) {
    const f=fixture(); const fetch=f.hooks.fetch; const start=f.hooks.start;
    f.hooks.start=async(signal)=>{await start(signal);if(failure==="actor")f.state.actorId="2".repeat(64);};
    f.hooks.fetch=async(request)=>f.state.starts && failure==="dependency"
      ? Response.json({...await (await fetch(request)).json() as object,ready:false},{status:503}) : fetch(request);
    await assert.rejects(new ModeTransition(limits).run("api-0",env,input,f.hooks),
      failure==="dependency"?/container_dependency_not_ready/:/container_version_or_contract_mismatch/);
  }
});
test("untyped lifecycle failures are named instead of collapsing into feed_unavailable",async()=>{
  const noInstance = fixture(); noInstance.state.running = false;
  noInstance.hooks.start = async () => { throw new Error("There is no container instance that can be provided to this Durable Object, try again later"); };
  await assert.rejects(new ModeTransition(limits).run("api-0",env,input,noInstance.hooks), /container_no_instance/);
  const startFailed = fixture(); startFailed.state.running = false;
  startFailed.hooks.start = async () => { throw new Error("Container exited with code 1"); };
  await assert.rejects(new ModeTransition(limits).run("api-0",env,input,startFailed.hooks), /container_start_failed/);
  assert.equal(startFailed.state.starts, 0);
  const stopFailed = fixture();
  stopFailed.hooks.stop = async () => { throw new TypeError("stop failed"); };
  await assert.rejects(new ModeTransition(limits).run("api-0",env,input,stopFailed.hooks), /container_stop_failed/);
  assert.equal(stopFailed.state.starts, 0);
  const textBody = fixture(); textBody.state.running = false;
  textBody.hooks.fetch = async () => new Response("Failed to start container: boom", { status: 500 });
  await assert.rejects(new ModeTransition(limits).run("api-0",env,input,textBody.hooks), /container_response_not_json/);
});
test("restart RPC failures answer a fixed code, never the platform message",async()=>{
  const request = new Request("https://runtime/internal/runtime/api-0/restart",{method:"POST",
    headers:{authorization:`Bearer ${env.FEED_RUNTIME_ADMIN_SECRET}`,"content-type":"application/json"},body:JSON.stringify(input)});
  const fail = (error: unknown) => ({fetch:async()=>Response.json({}),stop:async()=>{},restart:async()=>{ throw error; }});
  const cases: [unknown, string][] = [
    [Object.assign(new Error("Durable Object reset because its code was updated."), { durableObjectReset: true, retryable: true }), "actor_reset_by_deploy"],
    [Object.assign(new Error("Durable Object is overloaded."), { overloaded: true }), "actor_overloaded"],
    [Object.assign(new Error("Network connection lost."), { retryable: true }), "actor_rpc_retryable_error"],
    [new Error("internal error; reference = abc"), "container_rpc_failed"],
  ];
  for (const [error, code] of cases) {
    const response = await handleRequest(request.clone(), env, fail(error));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: code });
  }
});

// Production invokes runtimeRestart over a DO RPC boundary, which strips custom
// Error prototypes. The result envelope must survive that boundary unchanged.
test("stale DO validation is returned as a typed failure without a lifecycle retry", async () => {
  const { captureTransitionResult, readTransitionResult } = await import("../src/transition-rpc");
  const f = fixture(); let calls = 0;
  const dispatch = { fetch: (_target: string, request: Request) => f.hooks.fetch(request), stop: f.hooks.stop,
    restart: async (target: string, data: TransitionRequest) => {
      calls++;
      const encoded = await captureTransitionResult(() => new ModeTransition(limits).run(
        target as "api-0", { ...env, FEED_MODE: "off" }, data, f.hooks));
      return readTransitionResult(structuredClone(encoded));
    },
  };
  const response = await handleRequest(new Request("https://runtime/internal/runtime/api-0/restart", {
    method: "POST", headers: { authorization: `Bearer ${env.FEED_RUNTIME_ADMIN_SECRET}` }, body: JSON.stringify(input),
  }), env, dispatch);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_transition" });
  assert.equal(calls, 1); assert.equal(f.state.stops, 0); assert.equal(f.state.starts, 0);
});

test("transition RPC carries only allowlisted local errors and no messages or stack", async () => {
  const { captureTransitionResult, readTransitionResult } = await import("../src/transition-rpc");
  const { HTTPError } = await import("../src/security");
  for (const [code, status] of Object.entries({ invalid_transition: 400, transition_in_progress: 409,
    transition_timeout: 503, transition_stop_timeout: 503, container_version_or_contract_mismatch: 503,
    container_dependency_not_ready: 503, container_not_ready: 503, body_too_large: 413, body_timeout: 408 })) {
    const error = new HTTPError(status, code); error.message = "private diagnostic"; error.stack = "private stack";
    const encoded = await captureTransitionResult(async () => { throw error; });
    assert.deepEqual(encoded, { kind: "http-error", code, status });
    assert.throws(() => readTransitionResult(structuredClone(encoded)),
      (received: unknown) => received instanceof HTTPError && received.code === code && received.status === status && received.message === code);
  }
  for (const error of [Object.assign(new Error("provider failure"), { code: "invalid_transition", status: 400 }),
    new HTTPError(503, "invalid_transition"), new HTTPError(503, "private_provider_error")])
    await assert.rejects(captureTransitionResult(async () => { throw error; }), (received: unknown) => received === error);
});

test("malformed transition RPC replies fail closed and successful receipts retain their exact shape", async () => {
  const { captureTransitionResult, readTransitionResult } = await import("../src/transition-rpc");
  const success = { restarted: true, target: "api-0", ...input };
  assert.deepEqual(readTransitionResult(structuredClone(await captureTransitionResult(async () => success))), success);
  for (const reply of [null, [], {}, { kind: "http-error", code: "toString", status: 503 },
    { kind: "http-error", code: "invalid_transition", status: 503 },
    { kind: "http-error", code: "invalid_transition", status: 400, message: "private data" },
    { kind: "http-error", code: "transition_environment_not_ready", status: 409 },
    { kind: "result" }, { kind: "result", value: success, extra: true }])
    assert.throws(() => readTransitionResult(reply as never), /^Error: invalid transition RPC result$/);
});


test("mixed-version DO and edge replies keep the successful receipt accepted by release identity checks", async () => {
  const { captureTransitionResult, readTransitionResult } = await import("../src/transition-rpc");
  const { transitionActors } = await import(new URL("../../../scripts/feed-production-transition.mjs", import.meta.url).href);
  const anchor = { status: "passed", mode: "paused", sourceSha: input.sourceSha, backend: "go", store: "cf_d1_r2",
    workerVersionId: env.WORKER_VERSION.id };
  for (const newDO of [false, true]) for (const newEdge of [false, true]) {
    let calls = 0;
    const evidence = await transitionActors(input, { paused: async () => anchor,
      send: async (target: string) => {
        calls++;
        const receipt = { restarted: true, target, ...input };
        const wire = structuredClone(newDO ? await captureTransitionResult(async () => receipt) : receipt);
        assert.deepEqual(wire, receipt);
        return newEdge ? readTransitionResult(wire) : wire;
      },
    });
    assert.equal(calls, 3); assert.equal(evidence.status, "passed");
  }
  for (const reply of [{ rejectedWithoutMutation: true }, { restarted: true, target: "api-0", ...input, extra: true },
    { restarted: true, target: "api-0", ...input, sourceSha: "b".repeat(40) }]) {
    let calls = 0;
    await assert.rejects(transitionActors(input, { paused: async () => anchor, preflight: async () => {},
      send: async () => { calls++; return readTransitionResult(structuredClone(reply)); },
    }));
    assert.equal(calls, 1);
  }
});


test("off bootstrap destroy-then-start cannot reuse a still-running old instance", async () => {
  const f = fixture(); f.state.mode = "baseline";
  const off = {...env, FEED_MODE: "off"}, request: TransitionRequest = {...input, mode: "off"};
  f.hooks.stop = async () => { f.state.stops++; f.state.running = false; };
  f.hooks.start = async () => {
    assert.equal(f.state.running, false, "start must observe the destroyed instance");
    f.state.starts++; f.state.running = true; f.state.mode = "off";
  };
  const result = await new ModeTransition(limits).run("api-0", off, request, f.hooks);
  assert.deepEqual(result, {restarted: true, target: "api-0", ...request});
  assert.equal(f.state.stops, 1); assert.equal(f.state.starts, 1);
});
test("off bootstrap replaces an old running process without claiming its binary is current", async () => {
  const f = fixture(); f.state.mode = "baseline";
  const off = {...env, FEED_MODE: "off"}, request: TransitionRequest = {...input, mode: "off"};
  let probes = 0;
  f.hooks.fetch = async () => {
    probes++;
    assert.equal(f.state.starts, 1, "old process must not be mistaken for new-release readiness");
    return Response.json({ready:true,version:off.FEED_RELEASE_SHA,imageBuildId:off.FEED_IMAGE_BUILD_ID,
      contractVersion:"1",storageWriterVersion:2,storeProfile:"cf_d1_r2",service:"feed-api",writerEpoch:1,mode:f.state.mode});
  };
  f.hooks.start = async () => { assert.equal(f.state.running,false); f.state.starts++; f.state.running=true; f.state.mode="off"; };
  const result = await new ModeTransition(limits).run("api-0",off,request,f.hooks);
  assert.deepEqual(result,{restarted:true,target:"api-0",...request});
  assert.equal(f.state.stops,1); assert.equal(f.state.starts,1); assert.equal(probes,1);
});
test("off bootstrap keeps exact final identity and native stop requirements", async () => {
  const off = {...env, FEED_MODE:"off"}, request: TransitionRequest = {...input,mode:"off"};
  for (const patch of [{version:"c".repeat(40)},{imageBuildId:"e".repeat(64)},{mode:"baseline"},{contractVersion:"2"},{writerEpoch:2}]) {
    const f=fixture(patch); const start=f.hooks.start;
    f.hooks.start=async(signal)=>{await start(signal); f.state.mode="off";};
    await assert.rejects(new ModeTransition(limits).run("api-0",off,request,f.hooks),/container_version_or_contract_mismatch/);
    assert.equal(f.state.stops,1); assert.equal(f.state.starts,1);
  }
  const running=fixture(); running.hooks.stop=async()=>{running.state.stops++;};
  await assert.rejects(new ModeTransition(limits).run("api-0",off,request,running.hooks),/transition_stop_timeout/);
  assert.equal(running.state.starts,0);
  const invalidActor=fixture(); invalidActor.state.actorId="wrong";
  await assert.rejects(new ModeTransition(limits).run("api-0",off,request,invalidActor.hooks),/container_version_or_contract_mismatch/);
  assert.equal(invalidActor.state.stops,0);
  for (const mismatch of [{...input},{...request,mode:"unknown"},{...request,sourceSha:"c".repeat(40)}]) {
    const f=fixture();
    await assert.rejects(new ModeTransition(limits).run("api-0",off,mismatch as TransitionRequest,f.hooks),/invalid_transition/);
    assert.equal(f.state.stops,0); assert.equal(f.state.starts,0);
  }
});
test("off restart dispatches only matching off requests; stale baseline requests retain no-mutation 409", async () => {
  const off={...env,FEED_MODE:"off"}; let calls=0;
  const dispatch={fetch:async()=>Response.json({}),stop:async()=>{},restart:async(target:string,data:TransitionRequest)=>{calls++;return {restarted:true,target,...data};}};
  const request=(body:unknown,auth=env.FEED_RUNTIME_ADMIN_SECRET,path="api-0")=>new Request(`https://runtime/internal/runtime/${path}/restart`,{
    method:"POST",headers:{authorization:`Bearer ${auth}`},body:JSON.stringify(body)});
  const body={...input,mode:"off"};
  const response=await handleRequest(request(body),off,dispatch);
  assert.equal(response.status,200); assert.deepEqual(await response.json(),{restarted:true,target:"api-0",...body});
  assert.equal(calls,1);
  assert.equal((await handleRequest(request(input),off,dispatch)).status,409);
  assert.equal((await handleRequest(request(body),env,dispatch)).status,400);
  for(const bad of [{...body,mode:"unknown"},{...body,extra:true},{...body,imageBuildId:"e".repeat(64)},null])
    assert.equal((await handleRequest(request(bad),off,dispatch)).status,400);
  assert.equal((await handleRequest(request(body,"wrong"),off,dispatch)).status,401);
  assert.equal((await handleRequest(request(body,undefined,"api-3"),off,dispatch)).status,404);
  assert.equal(calls,1);
});
