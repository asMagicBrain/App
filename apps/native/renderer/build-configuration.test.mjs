import test from 'node:test';
import assert from 'node:assert/strict';
import {loadNativeBuildConfiguration} from './build-configuration.mjs';

const development={channel:'development',presentation:'full-with-grey',canToggleUnavailable:true,validationOnly:false};
const preview={channel:'preview',presentation:'implemented-only',canToggleUnavailable:false,validationOnly:false};

test('renderer accepts only complete, consistent host build configurations',async()=>{
  for(const configuration of [development,preview]){
    const result=await loadNativeBuildConfiguration({getBuildConfiguration:async()=>configuration});
    assert.deepEqual(result,configuration);
    assert.notEqual(result,configuration);
    assert(Object.isFrozen(result));
  }
});

test('missing, unknown, and mismatched build configuration cannot mount developer UI',async()=>{
  for(const bridge of [undefined,{}, {getBuildConfiguration:null}]){
    await assert.rejects(loadNativeBuildConfiguration(bridge),/configuration is unavailable/);
  }
  const invalid=[undefined,null,{},'preview',{...development,channel:'other'},
    {...preview,presentation:'full-with-grey'},{...preview,canToggleUnavailable:true},
    {...preview,validationOnly:true},{...development,validationOnly:true},
    {...development,presentation:'implemented-only'},{...development,canToggleUnavailable:false}];
  for(const configuration of [development,preview])for(const field of Object.keys(configuration)){
    const missing={...configuration};delete missing[field];invalid.push(missing);
  }
  for(const value of invalid){
    await assert.rejects(loadNativeBuildConfiguration({getBuildConfiguration:async()=>value}),/configuration could not be verified/);
  }
});

test('host configuration read failure is propagated without a fallback',async()=>{
  const error=new Error('Host unavailable');
  await assert.rejects(loadNativeBuildConfiguration({getBuildConfiguration:async()=>{throw error;}}),value=>value===error);
});
