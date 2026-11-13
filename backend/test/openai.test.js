import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIClient, validateOpenAIBase } from '../lib/openai.js';
const config={openaiBaseUrl:'https://api.example.com/v1',openaiApiKey:'secret-key',requestTimeoutMs:1000};
test('OpenAI adapter sends chat completions and maps result',async()=>{
 let captured;
 const generate=createOpenAIClient({config,fetchImpl:async(url,init)=>{
 captured={url,init}; return new Response(JSON.stringify({choices:[{message:{content:'result'},finish_reason:'length'}],usage:{total_tokens:55}}));
 }});
 const result=await generate({model:'vendor/model',systemInstruction:'rules',prompt:'text',generationConfig:{temperature:.5,topP:.9,maxOutputTokens:100}});
 assert.equal(captured.url,'https://api.example.com/v1/chat/completions');
 const payload=JSON.parse(captured.init.body); assert.equal(payload.messages[0].role,'system'); assert.equal(payload.max_tokens,100); assert.equal(payload.model,'vendor/model'); assert.equal(captured.init.redirect,'error');
 assert.equal(result.text,'result'); assert.equal(result.truncated,true); assert.equal(result.usage.totalTokenCount,55);
});
test('OpenAI adapter rejects unsafe configured URLs and hides raw failures',async()=>{
 for(const url of ['http://api.example.com','https://localhost/v1','https://127.0.0.1/v1','https://user:secret@api.example.com/v1','https://api.example.com?key=x']) assert.throws(()=>validateOpenAIBase(url));
 const generate=createOpenAIClient({config,fetchImpl:async()=>new Response(JSON.stringify({error:{message:'PRIVATE PROMPT secret-key'}}),{status:401})});
 await assert.rejects(()=>generate({prompt:'x',generationConfig:{}}),e=>e.status===401&&!e.message.includes('PRIVATE'));
});
test('OpenAI content filter and empty result fail safely',async()=>{
 for(const data of [{choices:[{finish_reason:'content_filter'}]},{choices:[]}]) {
 const generate=createOpenAIClient({config,fetchImpl:async()=>new Response(JSON.stringify(data))});
 await assert.rejects(()=>generate({prompt:'x',generationConfig:{}}));
 }
});
