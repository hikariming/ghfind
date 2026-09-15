import test from 'node:test';
import assert from 'node:assert/strict';
import { imageProof } from './feed-image-proof.mjs';
const env={RELEASE_SHA:'a'.repeat(40),FEED_IMAGE_BUILD_ID:'b'.repeat(64),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2'};
const image='registry.cloudflare.com/8f19bebe359e4ec1a24c68c5f49c1584/ghfind-feed@sha256:'+'c'.repeat(64);
const binaries=()=>['feed-api','feed-worker'].map(service=>({service,version:env.RELEASE_SHA,imageBuildId:env.FEED_IMAGE_BUILD_ID}));
test('digest receipt binds both actual compiled entrypoints to a unique Actions build',()=>{
  const r=imageProof(image,binaries(),env);assert.equal(r.image,image);assert.equal(r.imageBuildId,env.FEED_IMAGE_BUILD_ID);
  assert.equal(r.runAttempt,'2');
});
test('same source SHA cannot authorize a binary from another build',()=>{
  for(const patch of [{imageBuildId:'d'.repeat(64)},{imageBuildId:undefined},{version:'d'.repeat(40)},{extra:'must-not-record'}]){
    const b=binaries();Object.assign(b[0],patch);assert.throws(()=>imageProof(image,b,env));
  }
  assert.throws(()=>imageProof(image,[binaries()[0],binaries()[0]],env));
  for(const patch of [{FEED_IMAGE_BUILD_ID:undefined},{GITHUB_RUN_ATTEMPT:'0'},{GITHUB_RUN_ID:undefined}])
    assert.throws(()=>imageProof(image,binaries(),{...env,...patch}));
  assert.throws(()=>imageProof('mutable:latest',binaries(),env));
});
