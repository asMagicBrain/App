import {validateGitHubRegistration} from './github-registration.mjs';
import {githubApp as compiled} from './dist-host/account-config.mjs';
export const githubApp = validateGitHubRegistration(compiled);
