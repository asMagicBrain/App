import type {PluginPackageEntry} from '../native-types';

export const trustedProPackage = Object.freeze({
  id:'asmagicbrain.pro-editor',
  version:'0.1.0',
  digest:'089d829a2550464662a50642c1e84504209d38affc278a4044e8587e19aa5344',
  publisherId:'asmagicbrain.plugins',
});

/** Installed archives remain inert. This exact identity only admits the
 * separately reviewed first-party module already compiled into the app. */
export function isTrustedProPackage(entry:PluginPackageEntry):boolean {
  return entry.id===trustedProPackage.id&&entry.version===trustedProPackage.version
    &&entry.digest===trustedProPackage.digest&&entry.manifest.publisher.id===trustedProPackage.publisherId
    &&entry.manifest.execution.kind==='declarative'&&entry.manifest.permissions.length===0;
}
