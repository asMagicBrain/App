import type {PackageRow,PackageChoice} from '../../packages/desktop-host/src/package-exchange/index.mjs';
export function selectNonconflictingUpdates(rows:PackageRow[],current?:Record<string,PackageChoice>):Record<string,PackageChoice>;
