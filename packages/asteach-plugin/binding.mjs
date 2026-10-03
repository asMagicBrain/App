export const teachPackageDigest='1a2d2b708f0386fb3a68dcc7bf0aa35f070e53cafdfba2fa7edcd44efcfd8749';
export const legacyTeachPackageDigest='73d24a5d2253d72545a336352842b724b46121a86b006e0e058f307a4ca616db';
// Preserve the exact previously installed teaching package across application upgrades.
export const isTrustedTeachPackage=entry=>entry?.id==='asmagicbrain.asteach'
 && ((entry.version==='0.1.2'&&entry.digest===teachPackageDigest)||(entry.version==='0.1.1'&&entry.digest===legacyTeachPackageDigest))
 && entry.manifest?.publisher?.id==='asmagicbrain.plugins'&&entry.manifest?.execution?.kind==='declarative'
 && Array.isArray(entry.manifest?.permissions)&&entry.manifest.permissions.length===0;
