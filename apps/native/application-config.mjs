import {validateApplicationConfig} from './application-auth.mjs';
import {applicationAccount as compiled} from './dist-host/account-config.mjs';
export const applicationAccount = validateApplicationConfig(compiled);
