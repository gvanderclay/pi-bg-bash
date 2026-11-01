// Actual Pi 1.4, deterministic in-process responses only. No credentials/network.
// Usage: node test/runtime-probe.mjs /absolute/pi-1.4/node_modules
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import register from "../src/index.ts";
import { HOLDS_KEY } from "../src/holds.ts";
import { endSession, getRegistry } from "../src/registry.ts";
import { processPort, setProcessPort } from "../src/port.ts";
import { outputState, pumpOutput } from "../src/watch-events.ts";

assert.ok(process.argv[2], "pass the explicit installed Pi1.4 node_modules path");
const modules = resolve(process.argv[2]);
const core = join(modules, "@earendil-works/pi-coding-agent");
assert.equal(JSON.parse(readFileSync(join(core, "package.json"), "utf8")).version, "1.4.0");
const sdk = await import(pathToFileURL(join(core, "dist/index.js")));
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(modules, "@earendil-works/pi-ai/dist/utils/event-stream.js")));
const tmp = resolve(".scratch/tmp");
mkdirSync(tmp, { recursive: true });
const usage = { input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, cost:{input:0, output:0, cacheRead:0, cacheWrite:0, total:0} };
const model = { id:"deterministic-probe", name:"deterministic-probe", api:"openai-completions", provider:"fixture", baseUrl:"http://127.0.0.1:1/never", reasoning:false, input:["text"], cost:{input:0, output:0, cacheRead:0, cacheWrite:0}, contextWindow:100000, maxTokens:100 };
const toolCall = (name, id, args) => ({ type:"toolCall", name, id, arguments:args });
async function until(predicate, label, ms=5000) {
  const end = Date.now()+ms;
  while (Date.now()<end) { if (predicate()) return; await delay(10); }
  throw new Error("deadline: "+label);
}
async function fixture(extra=()=>{}, plan=()=>[]) {
  const directory = mkdtempSync(join(tmp,"bg-runtime-"));
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(directory,"state");
  const runtime = await sdk.ModelRuntime.create({
    credentials: { read:async()=>undefined, list:async()=>[], modify:async(_id,update)=>update(undefined), delete:async()=>{} },
    modelsPath:null, modelsStorePath:join(directory,"models-store.json"), allowModelNetwork:false, refreshOnCreate:false,
  });
  // Prompt preflight only; the stream below is wholly deterministic and has no transport.
  runtime.hasConfiguredAuth=()=>true;
  const requests=[], errors=[];
  const services = await sdk.createAgentSessionServices({
    cwd:directory, agentDir:join(directory,"agent"), modelRuntime:runtime,
    settingsManager:sdk.SettingsManager.inMemory({cacheWarming:"off",compaction:{enabled:false},retry:{enabled:false}}),
    resourceLoaderOptions:{
      noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
      extensionFactories:[register,sdk.createCodemodeExtension({mode:"only"}),extra],
    },
  });
  const {session} = await sdk.createAgentSessionFromServices({services,sessionManager:sdk.SessionManager.inMemory(directory),model,tools:["bash","bash_watch","bash_kill","bash_output","bash_tasks","codemode","probe_native"]});
  session.agent.getApiKey=()=>undefined;
  session.agent.streamFunction=(_model,context)=>{
    requests.push(context);
    const content=plan(requests.length,context);
    const message={role:"assistant",api:model.api,provider:model.provider,model:model.id,usage,timestamp:Date.now(),stopReason:content.length?"toolUse":"stop",content:content.length?content:[{type:"text",text:"local deterministic final"}]};
    const stream=createAssistantMessageEventStream();stream.push({type:"done",reason:message.stopReason,message});return stream;
  };
  await session.bindExtensions({onError:error=>errors.push(error)});
  return {session, requests, errors, directory, async close(){
    await endSession(); session.dispose();
    delete globalThis[HOLDS_KEY];
    if(previousState===undefined)delete process.env.XDG_STATE_HOME;else process.env.XDG_STATE_HOME=previousState;
    rmSync(directory,{recursive:true,force:true});
  }};
}

test("actual Pi1.4 codemode.only declares native watch and excludes it from callable tools; observer does not transform context",async()=>{
  let callable;
  const f=await fixture(pi=>{
    pi.registerTool({name:"probe_native",label:"probe",description:"fixture",exposure:"model-only",parameters:{type:"object",properties:{}},
      execute:async(_id,_params,_signal,_update,ctx)=>{callable=ctx.tools.map(tool=>tool.name);return{content:[{type:"text",text:"probe complete"}],details:undefined};}});
  },n=>n===1?[toolCall("probe_native","probe-1",{})]:[]);
  try {
    await f.session.prompt("local fixture");
    const names=(f.requests[0].tools??f.requests[0].messages.flatMap(message=>message.toolsAdded??[])).map(tool=>tool.name);
    assert.ok(names.includes("bash_watch"));assert.ok(!names.includes("bash"));
    assert.ok(!callable.includes("bash_watch"));assert.ok(callable.includes("bash"));
    assert.equal(f.requests.length,2);
    assert.ok(JSON.stringify(f.requests[1].messages).includes("probe complete"));
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

for(const boundary of ["agent_before_settle","agent_settled"]) {
  test("actual Pi1.4 triggerTurn steering at "+boundary+" starts a new request",async()=>{
    let sent=false;
    const f=await fixture(pi=>{
      pi.on(boundary,()=>{if(sent)return;sent=true;pi.sendMessage({customType:"fixture-wake",content:"settle-window wake",display:false},{deliverAs:"steer",triggerTurn:true});});
    });
    try {
      await f.session.prompt("first fixture");
      await until(()=>f.requests.length===2,"settle window wake");
      await f.session.agent.waitForIdle();
      assert.equal(f.requests.length,2);
      assert.ok(JSON.stringify(f.requests[1].messages).includes("settle-window wake"));
      assert.deepEqual(f.errors,[]);
    }finally{await f.close();}
  });
}

test("actual Pi1.4 nested bash deny hook prevents both process and atomic hold",async()=>{
  let denied=0;
  const f=await fixture(pi=>{
    pi.on("tool_call",event=>{if(event.toolName==="bash"){denied++;return{block:true,reason:"fixture deny original bash command"};}});
  },n=>n===1?[toolCall("codemode","deny-code",{code:'text(await tools.bash({command:"echo should-not-run",background:true,hold:true}));'})]:[]);
  try {
    await f.session.prompt("deny fixture");
    assert.equal(denied,1);
    assert.equal(getRegistry().tasks.size,0);
    assert.equal(globalThis[HOLDS_KEY],undefined);
    assert.ok(JSON.stringify(f.requests[1].messages).includes("fixture deny"));
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test("actual Pi1.4 codemode nested successful kill releases atomic hold after normal observed run",async()=>{
  let hostId;
  const f=await fixture(pi=>{
    pi.on("session_start",(_event,ctx)=>{hostId=ctx.sessionManager.getSessionId();globalThis[HOLDS_KEY]={version:1,hosts:new Map([[hostId,new Map([["fixture","runtime"]])]]),holds:new Map()};});
  },n=>{
    const id=[...getRegistry().tasks.keys()][0];
    if(n===1)return[toolCall("codemode","launch-code",{code:'text(await tools.bash({command:"echo ready; sleep 60",background:true,hold:true}));'})];
    if(n===2)return[toolCall("bash_watch","watch-native",{id})];
    if(n===3)return[toolCall("codemode","kill-code",{code:`text(await tools.bash_kill({id:${JSON.stringify(id)}}));`})];
    return[];
  });
  try {
    await f.session.prompt("held fixture");
    const task=[...getRegistry().tasks.values()][0];
    assert.equal(task.killCallId,"kill-code");
    assert.equal(task.terminalObserved,true);
    assert.equal(globalThis[HOLDS_KEY].holds.get(hostId).get(task.holdId).ready,true);
    assert.ok(!f.session.messages.some(message=>message.role==="toolResult"&&message.toolCallId.includes("/")));
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

for (const failAfterKill of [false,true]) {
test("actual Pi1.4 codemode stuck kill does not release a hold"+(failAfterKill?" after codemode throw":"" )+" (scripted process port, real time)",async()=>{
  const real=processPort();
  const f=await fixture(pi=>{
    pi.on("session_start",(_event,ctx)=>{const id=ctx.sessionManager.getSessionId();globalThis[HOLDS_KEY]={version:1,hosts:new Map([[id,new Map([["fixture","runtime"]])]]),holds:new Map()};});
  },n=>{
    const id=[...getRegistry().tasks.keys()][0];
    if(n===1)return[toolCall("codemode","launch-code",{code:'text(await tools.bash({command:"fixture-only",background:true,hold:true}));'})];
    if(n===2)return[toolCall("codemode","stuck-code",{code:`text(await tools.bash_kill({id:${JSON.stringify(id)}})); ${failAfterKill ? 'throw new Error("after stuck kill");' : ""}`})];
    return[];
  });
  const {writeFileSync}=await import("node:fs");
  setProcessPort({launch:async options=>{writeFileSync(options.logPath,"");return 123456;},pidAlive:()=>true,groupAlive:()=>true,signalGroup:()=>true});
  const previous=process.env.PI_BG_BASH_GRACE_MS;process.env.PI_BG_BASH_GRACE_MS="1";
  try {
    await f.session.prompt("stuck fixture");
    const task=[...getRegistry().tasks.values()][0];
    assert.equal(task.killCallId,undefined);assert.equal(task.terminalObserved,false);
    assert.equal(f.session.messages.find(m=>m.role==="toolResult"&&m.toolCallId==="stuck-code")?.isError,failAfterKill);
    assert.equal(globalThis[HOLDS_KEY].holds.get(task.ownerSessionId).get(task.holdId).ready,false);
    assert.deepEqual(f.errors,[]);
  }finally{
    setProcessPort({...real,groupAlive:()=>false,signalGroup:()=>false});
    await f.close();setProcessPort(real);
    if(previous===undefined)delete process.env.PI_BG_BASH_GRACE_MS;else process.env.PI_BG_BASH_GRACE_MS=previous;
  }
});
}

const host=(pi,box)=>pi.on("session_start",(_e,ctx)=>{box.id=ctx.sessionManager.getSessionId();globalThis[HOLDS_KEY]={version:1,hosts:new Map([[box.id,new Map([["fixture","runtime"]])]]),holds:new Map()};});

test("R2: successful nested kill then codemode throw releases after normal run",async()=>{
  const box={};
  const f=await fixture(pi=>host(pi,box),n=>{
    const id=[...getRegistry().tasks.keys()][0];
    if(n===1)return[toolCall("codemode","launch-code",{code:'text(await tools.bash({command:"sleep 60",background:true,hold:true}));'})];
    if(n===2)return[toolCall("codemode","kill-then-fail",{code:`text(await tools.bash_kill({id:${JSON.stringify(id)}})); throw new Error("later step failed");`})];
    return[];
  });
  try{
    await f.session.prompt("A");
    const task=[...getRegistry().tasks.values()][0];
    const tr=f.session.messages.find(m=>m.role==="toolResult"&&m.toolCallId==="kill-then-fail");
    assert.equal(tr?.isError,true); assert.equal(task.state,"killed"); assert.equal(task.killCallId,"kill-then-fail"); assert.equal(task.terminalObserved,true); assert.equal(globalThis[HOLDS_KEY].holds.get(box.id).get(task.holdId).ready,true);
  }finally{await f.close();}
});

test("R1 B: clear_queue recovers an unseen outstanding output batch",async()=>{
  let release;const gate=new Promise(r=>release=r);
  const f=await fixture(pi=>{
    pi.registerTool({name:"probe_native",label:"probe",description:"fixture",exposure:"model-only",parameters:{type:"object",properties:{}},
      execute:async()=>{await gate;return{content:[{type:"text",text:"blocked tool done"}],details:undefined};}});
  },n=>{
    const id=[...getRegistry().tasks.keys()][0];
    if(n===1)return[toolCall("codemode","launch",{code:'text(await tools.bash({command:"for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do echo line$i; sleep 0.2; done",background:true}));'})];
    if(n===2)return[toolCall("bash_watch","w",{id})];
    if(n===3)return[toolCall("probe_native","block",{})];
    return[];
  });
  try{
    const run=f.session.prompt("B");
    await until(()=>f.requests.length===3,"blocked tool");
    await delay(500);
    pumpOutput();
    const first=outputState().outstanding;
    assert.equal(first?.sent,true); assert.equal(f.session.pendingMessageCount,0,"custom steers are not included by pendingMessageCount");
    f.session.clearQueue();
    release();
    await run; await f.session.agent.waitForIdle();
    await delay(800);
    for(let i=0;i<3;i++){pumpOutput();await delay(300);}
    await f.session.agent.waitForIdle();
    const after=outputState().outstanding;
    const delivered=f.session.messages.filter(m=>m.role==="custom"&&m.customType==="pi-bg-bash-output").length;
    assert.ok(delivered>0,"cleared output must be recovered, not strand the session gate"); assert.equal(f.session.messages.filter(m=>m.role==="custom"&&m.details?.token===first.token).length,1,"recovery keeps the original token without duplicate delivery"); assert.notEqual(after?.token,first.token); assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test("R1 C: clear_queue recovers an unseen held completion",async()=>{
  const box={};let release;const gate=new Promise(r=>release=r);
  const f=await fixture(pi=>{host(pi,box);
    pi.registerTool({name:"probe_native",label:"probe",description:"fixture",exposure:"model-only",parameters:{type:"object",properties:{}},
      execute:async()=>{await gate;return{content:[{type:"text",text:"blocked tool done"}],details:undefined};}});
  },n=>{
    if(n===1)return[toolCall("codemode","launch",{code:'text(await tools.bash({command:"sleep 0.2",background:true,hold:true}));'})];
    if(n===2)return[toolCall("probe_native","block",{})];
    return[];
  });
  try{
    const run=f.session.prompt("C");
    await until(()=>f.requests.length===2,"blocked");
    const task=[...getRegistry().tasks.values()][0];
    await until(()=>task.notified,"completion sent",8000);
    f.session.clearQueue(); release();
    await run; await f.session.agent.waitForIdle(); await delay(2500); await f.session.agent.waitForIdle();
    const completions=f.session.messages.filter(m=>m.role==="custom"&&m.customType==="pi-bg-bash").length;
    assert.equal(task.state,"exited"); assert.equal(task.notified,true); assert.equal(completions,1,"one recovered held terminal reaches the transcript"); assert.equal(task.terminalObserved,true); assert.equal(globalThis[HOLDS_KEY].holds.get(box.id).get(task.holdId).ready,true); assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});


test("R1: Escape-style abort pauses lost output until the next intentional run",async()=>{
  let release; const gate=new Promise(resolve=>release=resolve);
  const f=await fixture(pi=>{
    pi.registerTool({name:"probe_native",label:"probe",description:"blocked fixture",exposure:"model-only",parameters:{type:"object",properties:{}},
      execute:async()=>{await gate;return{content:[{type:"text",text:"released"}],details:undefined};}});
  },n=>{
    const id=[...getRegistry().tasks.keys()][0];
    if(n===1)return[toolCall("codemode","launch",{code:'text(await tools.bash({command:"echo WAITING; sleep 60",background:true}));'})];
    if(n===2)return[toolCall("bash_watch","watch",{id})];
    if(n===3)return[toolCall("probe_native","block",{})];
    return[];
  });
  try {
    const run=f.session.prompt("abort output fixture");
    await until(()=>f.requests.length===3,"blocked output owner");
    await until(()=>readFileSync([...getRegistry().tasks.values()][0].logPath,"utf8").includes("WAITING"),"producer output");
    pumpOutput();
    const token=outputState().outstanding.token;
    f.session.clearQueue();
    const stopped=f.session.abort(); release();
    await run;await stopped;
    assert.equal(outputState().paused,true);
    assert.equal(outputState().outstanding.sent,false,"unseen output is rearmed, not forgotten");
    await delay(2200);pumpOutput();
    assert.equal(f.session.messages.filter(m=>m.details?.token===token).length,0,"stop wins over unsolicited output");
    await f.session.prompt("intentional resume");
    await until(()=>f.session.messages.some(m=>m.details?.token===token),"same-token recovered output");
    await f.session.agent.waitForIdle();
    assert.equal(f.session.messages.filter(m=>m.details?.token===token).length,1);
    assert.deepEqual(f.errors,[]);
  }finally{release();await f.close();}
});

test("R1: Escape-style abort pauses lost held completion, preserving the exact payload/token",async()=>{
  const box={}; let release;const gate=new Promise(resolve=>release=resolve);
  const f=await fixture(pi=>{host(pi,box);
    pi.registerTool({name:"probe_native",label:"probe",description:"blocked fixture",exposure:"model-only",parameters:{type:"object",properties:{}},
      execute:async()=>{await gate;return{content:[{type:"text",text:"released"}],details:undefined};}});
  },n=>n===1?[toolCall("codemode","launch",{code:'text(await tools.bash({command:"echo finished; sleep 0.1",background:true,hold:true}));'})]:
    n===2?[toolCall("probe_native","block",{})]:[]);
  try {
    const run=f.session.prompt("abort held completion");
    await until(()=>f.requests.length===2,"blocked completion owner");
    const task=[...getRegistry().tasks.values()][0];
    await until(()=>task.notified,"completion queued",8000);
    const token=task.terminalToken, content=task.completion.content;
    f.session.clearQueue();const stopped=f.session.abort();release();
    await run;await stopped;
    assert.equal(task.terminalSeen,undefined);
    assert.equal(task.terminalObserved,false);
    assert.equal(task.completion.sent,false);
    await delay(2200);pumpOutput();
    assert.equal(f.session.messages.filter(m=>m.details?.token===token).length,0,"no retry wakes a stopped owner");
    assert.equal(globalThis[HOLDS_KEY].holds.get(box.id).get(task.holdId).ready,false);
    await f.session.prompt("intentional completion resume");
    await until(()=>task.terminalObserved,"observed recovered terminal");
    await f.session.agent.waitForIdle();
    const messages=f.session.messages.filter(m=>m.details?.token===token);
    assert.equal(messages.length,1);assert.equal(messages[0].content,content);
    assert.equal(globalThis[HOLDS_KEY].holds.get(box.id).get(task.holdId).ready,true);
    assert.deepEqual(f.errors,[]);
  }finally{release();await f.close();}
});

test("R1: seen-but-aborted held terminal is not replayed; later normal context commits it",async()=>{
  const box={};let release;const gate=new Promise(resolve=>release=resolve);
  const f=await fixture(pi=>{host(pi,box);
    pi.registerTool({name:"probe_native",label:"probe",description:"blocked after observation",exposure:"model-only",parameters:{type:"object",properties:{}},
      execute:async()=>{await gate;return{content:[{type:"text",text:"released"}],details:undefined};}});
  },n=>n===1?[toolCall("codemode","launch",{code:'text(await tools.bash({command:"sleep 0.1",background:true,hold:true}));'})]:
    n===3?[toolCall("probe_native","block-observed",{})]:[]);
  try {
    await f.session.prompt("observe then abort");
    const task=[...getRegistry().tasks.values()][0];
    await until(()=>f.requests.length===3,"terminal-triggered request",8000);
    assert.equal(task.terminalSeen,true);
    assert.equal(task.terminalObserved,false);
    f.session.clearQueue();const stopped=f.session.abort();release();await stopped;
    assert.equal(task.terminalObserved,false);
    assert.equal(f.session.messages.filter(m=>m.details?.token===task.terminalToken).length,1);
    await f.session.prompt("intentional normal processing");
    assert.equal(task.terminalObserved,true);
    assert.equal(f.session.messages.filter(m=>m.details?.token===task.terminalToken).length,1,"seen terminal is not duplicated");
    assert.deepEqual(f.errors,[]);
  }finally{release();await f.close();}
});

test("R1: seen output followed by abort is not replayed",async()=>{
  let releaseFirst,releaseSecond;
  const first=new Promise(resolve=>releaseFirst=resolve),second=new Promise(resolve=>releaseSecond=resolve);
  let calls=0;
  const f=await fixture(pi=>{
    pi.registerTool({name:"probe_native",label:"probe",description:"blocked output fixture",exposure:"model-only",parameters:{type:"object",properties:{}},
      execute:async()=>{await (++calls===1?first:second);return{content:[{type:"text",text:"released"}],details:undefined};}});
  },n=>{
    const id=[...getRegistry().tasks.keys()][0];
    if(n===1)return[toolCall("codemode","launch",{code:'text(await tools.bash({command:"echo WAITING; sleep 60",background:true}));'})];
    if(n===2)return[toolCall("bash_watch","watch",{id})];
    if(n===3||n===4)return[toolCall("probe_native","block-"+n,{})];
    return[];
  });
  try {
    const run=f.session.prompt("observe output then abort");
    await until(()=>f.requests.length===3,"first blocked request");
    await until(()=>readFileSync([...getRegistry().tasks.values()][0].logPath,"utf8").includes("WAITING"),"producer output");pumpOutput();
    const token=outputState().outstanding.token;releaseFirst();
    await until(()=>f.requests.length===4,"request observing output");
    assert.equal(outputState().outstanding,undefined);
    f.session.clearQueue();const stopped=f.session.abort();releaseSecond();await run;await stopped;
    await f.session.prompt("intentional resume after observed output");
    pumpOutput();
    assert.equal(f.session.messages.filter(m=>m.details?.token===token).length,1);
    assert.deepEqual(f.errors,[]);
  }finally{releaseFirst();releaseSecond();await f.close();}
});

test("R1: held completion sent after agent_end is not duplicated in the settle window",async()=>{
  const box={};let delayed=false;
  const f=await fixture(pi=>{host(pi,box);
    pi.on("agent_before_settle",async()=>{
      const task=[...getRegistry().tasks.values()][0];
      if(delayed||!task)return;delayed=true;
      await until(()=>task.notified,"post-agent_end held completion",8000);
    });
  },n=>n===1?[toolCall("codemode","launch",{code:'text(await tools.bash({command:"sleep 0.1",background:true,hold:true}));'})]:[]);
  try {
    await f.session.prompt("late settle fixture");
    const task=[...getRegistry().tasks.values()][0];
    await until(()=>task.terminalObserved,"normal observation");
    assert.equal(f.session.messages.filter(m=>m.details?.token===task.terminalToken).length,1);
    assert.equal(globalThis[HOLDS_KEY].holds.get(box.id).get(task.holdId).ready,true);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test("R1: cleared terminal after agent_end plus stop recovers after an intentional run, not during stop",async()=>{
  const box={};let delayed=false,stopped;
  let f;
  f=await fixture(pi=>{host(pi,box);
    pi.on("agent_before_settle",async()=>{
      const task=[...getRegistry().tasks.values()][0];
      if(delayed||!task)return;delayed=true;
      await until(()=>task.notified,"post-agent_end completion to clear",8000);
      f.session.clearQueue();stopped=f.session.abort();
    });
  },n=>n===1?[toolCall("codemode","launch",{code:'text(await tools.bash({command:"sleep 0.1",background:true,hold:true}));'})]:[]);
  try {
    await f.session.prompt("clear late terminal and stop");await stopped;
    assert.equal(outputState().paused,true,"a stop after agent_end must also pause output");
    const task=[...getRegistry().tasks.values()][0];
    const before=f.requests.length;
    await delay(2200);pumpOutput();
    assert.equal(f.requests.length,before,"stop in the settle window is respected");
    assert.equal(task.terminalObserved,false);
    await f.session.prompt("intentional late-terminal resume");
    await until(()=>task.terminalObserved,"late dropped token recovered");
    assert.equal(f.session.messages.filter(m=>m.details?.token===task.terminalToken).length,1);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});


test("ordinary codemode bash returns normal output/exit with no automatic-task guidance or task handle",async()=>{
  let result;
  const f=await fixture(pi=>{
    pi.on("tool_result",event=>{if(event.toolName==="bash")result=event.structuredContent;});
  },n=>n===1?[toolCall("codemode","plain-foreground",{code:'text(await tools.bash({command:"printf foreground-ok"}));'})]:[]);
  try {
    const description=f.session.getToolDefinition("bash").description;
    assert.match(description,/bash waits for command exit and returns its output/);
    assert.doesNotMatch(description,/120 s|moves to the background on its own/);
    await f.session.prompt("ordinary foreground fixture");
    assert.equal(result.output,"foreground-ok");
    assert.equal(result.exit_code,0);
    assert.equal("task_id" in result,false);
    assert.equal(getRegistry().tasks.size,0);
    assert.equal(getRegistry().groups.size,0);
    assert.equal(f.session.messages.filter(m=>m.customType==="pi-bg-bash").length,0);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
