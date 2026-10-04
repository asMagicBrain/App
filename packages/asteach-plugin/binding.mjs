export const teachPackageDigest='3a78556e3a6f8ab41e03a622eff6afc93c6f3cc7f7ee394efe4d6b55407133af';
export const preAudienceTeachPackageDigest='4355f4435ad9c665dfc897a1d0552bc05e8e343aa84149648720d4da829ef387';
export const pipelineTeachPackageDigest='10ced464e2f9f50ade8aa92eb8bd65160d1dfd0e419bbd9ae201fe3df5d1fc10';
export const previousTeachPackageDigest='21cc7809476e9cd2b3959a1148bdd14f3293df34102aae75e41364e1dd872c0b';
export const legacyTeachPackageDigest='73d24a5d2253d72545a336352842b724b46121a86b006e0e058f307a4ca616db';
// Preserve the exact previously installed teaching package across application upgrades.
export const isTrustedTeachPackage=entry=>entry?.id==='asmagicbrain.asteach'
 && ((entry.version==='0.1.5'&&entry.digest===teachPackageDigest)||(entry.version==='0.1.4'&&entry.digest===preAudienceTeachPackageDigest)||(entry.version==='0.1.3'&&entry.digest===pipelineTeachPackageDigest)||(entry.version==='0.1.2'&&entry.digest===previousTeachPackageDigest)||(entry.version==='0.1.1'&&entry.digest===legacyTeachPackageDigest))
 && entry.manifest?.publisher?.id==='asmagicbrain.plugins'&&entry.manifest?.execution?.kind==='declarative'
 && Array.isArray(entry.manifest?.permissions)&&entry.manifest.permissions.length===0;
