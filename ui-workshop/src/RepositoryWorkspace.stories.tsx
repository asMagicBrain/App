import type { Meta, StoryObj } from '@storybook/react-vite';
import { FocusedWriting } from './FocusedWriting';
import { OutlineCompanionStudy } from './OutlineCompanionStudy';
import { PluginWorkspaceStudy } from './PluginWorkspaceStudy';
import { TeachReferenceStudy } from './TeachReferenceStudy';
import { ProEditorStudy } from './pro-editor/ProEditorStudy';
import { ReadingNavigationStudy } from './ReadingNavigationStudy';
const meta={title:'asMagicBrain/Repository workspace',component:FocusedWriting,parameters:{layout:'fullscreen'},args:{repositoryHeader:true,repositoryCode:true}} satisfies Meta<typeof FocusedWriting>;
export default meta;
type Story=StoryObj<typeof meta>;
export const Workspace:Story={name:'Workspace'};
export const FilesOpen:Story={name:'Workspace with files',args:{initialSidebar:true}};
export const ApplicationHome:Story={name:'Application home',args:{initialWorkspaceView:'home',initialTheme:'light-default'}};
export const OwnerHome:Story={name:'Local organization',args:{initialWorkspaceView:'organization',initialTheme:'light-default'}};


export const FileEditor:Story={name:'File view and editor — GitHub reference',args:{initialRepository:'asTeach-App',initialEdit:true,initialTheme:'light-default'}};

export const FolderView:Story={name:'Folder view — GitHub reference',args:{initialRepository:'asTeach-App',initialDirectory:'docs',initialTheme:'light-default'}};

export const FileManagement:Story={name:'File management',args:{initialRepository:'Workspace',initialDirectory:'',initialTheme:'light-default'}};

export const AccountSettings:Story={name:'Account and commit settings',args:{initialRepository:'Workspace',initialDirectory:'',initialTheme:'light-default',initialSettingsOpen:true}};
export const SignedInAccount:Story={name:'Account menu — signed-in preview',args:{initialRepository:'Workspace',initialDirectory:'',initialTheme:'light-default',accountPreview:true}};

export const OutlineCompanion:Story={name:'Integrated document outline',render:()=> <OutlineCompanionStudy/>,parameters:{controls:{disable:true}}};
export const Plugins:Story={name:'Plugins — manager and asTeach',render:()=> <PluginWorkspaceStudy/>,parameters:{controls:{disable:true},docs:{description:{story:'Storybook-only plugin workspace. asTeach edits and enablement stay in memory for this session; no repository files, accounts or native settings are changed.'}}}};
export const PluginFoundation:Story={name:'Plugins — bundled Markdown tools',args:{pluginFoundation:true,initialRepository:'Workspace',initialDirectory:'',initialTheme:'light-default'},parameters:{docs:{description:{story:'Shared native plugin host and retained CM6 sessions. Markdown tools access the selected local document only when explicitly enabled. asTeach remains a separate UI study.'}}}};
export const ProEditor:Story={name:'Editor — source, visual and split',render:()=> <ProEditorStudy/>,parameters:{controls:{disable:true},docs:{description:{story:'Built-in shared repository editor with an explicit in-memory file adapter. Equations and Mermaid use the existing offline readers; Source, Visual, Split and undo share one CM6 session. Save changes only the in-memory sample. Native files, Git and artifact execution require separate packaged acceptance.'}}}};
export const Teach:Story={name:'asTeach — Courses and workspace',render:()=> <PluginWorkspaceStudy initialView="teach"/>,parameters:{controls:{disable:true}}};

export const TeachBatch1Review:Story={name:'asTeach — Batch 1 review',render:()=> <PluginWorkspaceStudy initialView="teach" initialLanding="courses"/>,parameters:{controls:{disable:true},docs:{description:{story:'Review checkpoint for Home, the complete Courses catalog, current/latest-term navigation and local course setup. Start in Courses; choose asTeach for Home, open a course to enter its current term, or use + to inspect course creation. All changes remain in this Storybook tab.'}}}};

export const TeachBatch2Review:Story={name:'asTeach — Batch 2 review',render:()=> <PluginWorkspaceStudy initialView="teach" initialCourseId="des101"/>,parameters:{controls:{disable:true},docs:{description:{story:'Review checkpoint for one continuous Instructor document, Preview/Edit/Split modes, explicit Student-copy review and the editable course calendar. Use Course pages on the left to move among Instructor page, Student page and Course calendar. All changes and Student versions remain in this Storybook tab; publication outputs stay unavailable for Batch 3.'}}}};

export const TeachBatch3Review:Story={name:'asTeach — Batch 3 review',render:()=> <PluginWorkspaceStudy initialView="teach" initialCourseId="des101" initialSectionId="student" initialReviewedStudent/>,parameters:{controls:{disable:true},docs:{description:{story:'Review checkpoint for derived Student publication. It starts with a seeded reviewed Student version so Export, GitHub and GitBook output previews can be inspected immediately. Compare one-page and multipage organization, proposed files, destination-specific boundaries and validation. Every action is session-only; no package, repository, account or online site is changed.'}}}};

export const TeachFirstCourse:Story={name:'asTeach — first course',render:()=> <PluginWorkspaceStudy initialView="teach" initialEmpty/>,parameters:{controls:{disable:true}}};
export const TeachDES5002Reference:Story={name:'asTeach — DES5002 reference',render:()=> <TeachReferenceStudy/>,parameters:{controls:{disable:true},docs:{description:{story:'Read-only local reference. Course text and images are loaded only from an explicitly configured external test fixture; none are bundled with Storybook.'}}}};

export const ReadingNavigation:Story={name:'Reading navigation — history and evidence',render:()=> <ReadingNavigationStudy/>,parameters:{controls:{disable:true},docs:{description:{story:'Shared reading history and CM6 in-memory study. Two fictional measured/target reports, exact return positions and failed navigation. Native repository identities, filesystem references and persistence require packaged acceptance.'}}}};
