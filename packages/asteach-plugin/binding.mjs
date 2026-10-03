export const teachPackageDigest='21cc7809476e9cd2b3959a1148bdd14f3293df34102aae75e41364e1dd872c0b';
export const legacyTeachPackageDigest='73d24a5d2253d72545a336352842b724b46121a86b006e0e058f307a4ca616db';
// Preserve the exact previously installed teaching package across application upgrades.
export const isTrustedTeachPackage=entry=>entry?.id==='asmagicbrain.asteach'
 && ((entry.version==='0.1.2'&&entry.digest===teachPackageDigest)||(entry.version==='0.1.1'&&entry.digest===legacyTeachPackageDigest))
 && entry.manifest?.publisher?.id==='asmagicbrain.plugins'&&entry.manifest?.execution?.kind==='declarative'
 && Array.isArray(entry.manifest?.permissions)&&entry.manifest.permissions.length===0;
