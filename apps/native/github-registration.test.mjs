import test from 'node:test';
import assert from 'node:assert/strict';
import {validateGitHubRegistration, registrationSummary} from './github-registration.mjs';
import {githubApp} from './github-config.mjs';
test('shipped registration is a frozen public identifier pair', () => {
  assert.deepEqual(Object.keys(githubApp).sort(), ['clientId', 'slug']);
  assert.deepEqual(registrationSummary(githubApp), {...githubApp, configured: githubApp.clientId !== null});
  assert.ok(Object.isFrozen(githubApp));
});
test('an explicitly unregistered build remains unavailable', () => {
  assert.deepEqual(registrationSummary({clientId:null,slug:null}),{clientId:null,slug:null,configured:false});
});
test('GitHub App registration validates its public identifiers together', () => {
  for(const clientId of ['Iv1.SyntheticRegistration', 'Iv23.SyntheticRegistration', 'Iv23SyntheticRegistration']) {
    assert.deepEqual(registrationSummary({clientId,slug:'asmagicbrain-pilot'}),{clientId,slug:'asmagicbrain-pilot',configured:true});
  }
});
test('partial registrations, credential material and alternate provider URLs fail without echo', () => {
  const marker='synthetic-private-value';
  for(const value of [null,[],{clientId:null,slug:'pilot'},{clientId:'Iv1.public',slug:null},{clientId:'ghp_'+marker,slug:'pilot'},
    {clientId:'Iv1.public',slug:'https://evil.invalid'}, {clientId:'Iv1.public',slug:'pilot',clientSecret:marker},
    {clientId:'Iv1.public',slug:'pilot',accessToken:marker},{clientId:'Iv1.public',slug:'pilot',authorizationUrl:'https://evil.invalid'}]) {
    assert.throws(()=>validateGitHubRegistration(value),e=>!e.message.includes(marker));
  }
});
