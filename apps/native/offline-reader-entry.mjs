// Compiled dependency closure; package runtime never resolves node_modules.
export {renderOffline} from '../../packages/desktop-host/src/package-exchange/offline-reader.mjs';
export {analyzeReferences} from './automation-validation-parser.mjs';

export {studentReferences,rewriteStudentLinks} from './teach-reference-parser.mjs';

export {convertGitBookMarkdown,rewriteGitBookAnchors} from './teach-gitbook-conversion.mjs';
export {portableHeadingOutput} from './teach-portable-headings.mjs';
export {studentNavigation} from './teach-navigation.mjs';
