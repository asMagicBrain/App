import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateApplicationConfig} from './application-auth.mjs';
import {validateGitHubRegistration} from './github-registration.mjs';

const offline = {applicationAccount: {origin: null, publishableKey: null, providers: {github: false, email: false}}, githubApp: {clientId: null, slug: null}};
// Public registration identifiers, explicitly selected for the official build.
// No provider secret, service-role key, or grant is distributed here.
const official = {applicationAccount: {
  origin: 'https://brgxjdhkcfvbpsziebus.supabase.co',
  publishableKey: 'sb_publishable_OqM2QiC02TXfR5xRXKg0ig_3YotINtN',
  providers: {github: true, email: true},
}, githubApp: {clientId: 'Iv23liEbR0Z04ixQrp1m', slug: 'asmagicbrain'}};

export function resolveAccountBuildConfig(selector = 'offline') {
  let value, id;
  if (selector === 'offline' || selector === 'official') {value = selector === 'official' ? official : offline; id = selector;}
  else {
    if (typeof selector !== 'string' || !path.isAbsolute(selector)) throw Error('ASMB_ACCOUNT_CONFIG must be offline, official, or an absolute JSON file path.');
    const stat = fs.lstatSync(selector);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw Error('Account configuration must be a physical JSON file of at most 16 KiB.');
    value = JSON.parse(fs.readFileSync(selector, 'utf8')); id = 'custom';
  }
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'applicationAccount,githubApp') throw Error('Account configuration must contain only applicationAccount and githubApp.');
  const application = value.applicationAccount;
  if (!application || Array.isArray(application) || Object.keys(application).sort().join(',') !== 'origin,providers,publishableKey' || (application.origin === null && (application.publishableKey !== null || application.providers?.github !== false || application.providers?.email !== false || Object.keys(application.providers).length !== 2))) throw Error('Application configuration must contain only origin, publishableKey and providers; offline values must all be disabled.');
  const applicationAccount = validateApplicationConfig(value.applicationAccount), githubApp = validateGitHubRegistration(value.githubApp);
  const sha256 = createHash('sha256').update(JSON.stringify({applicationAccount, githubApp})).digest('hex');
  return Object.freeze({id, sha256, applicationAccount, githubApp});
}
