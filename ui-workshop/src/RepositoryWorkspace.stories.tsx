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
export const ProEditor:Story={name:'Pro Editor — source, visual and split',render:()=> <ProEditorStudy/>,parameters:{controls:{disable:true},docs:{description:{story:'Shared repository editor and bundled Pro plugin with an explicit in-memory file adapter. Equations and Mermaid use the existing offline readers; Source, Visual, Split and undo share one CM6 session. Save changes only the in-memory sample. Native files, Git and artifact execution require separate packaged acceptance.'}}}};
export const Teach:Story={name:'asTeach — Courses and workspace',render:()=> <PluginWorkspaceStudy initialView="teach"/>,parameters:{controls:{disable:true}}};

export const TeachFirstCourse:Story={name:'asTeach — first course',render:()=> <PluginWorkspaceStudy initialView="teach" initialEmpty/>,parameters:{controls:{disable:true}}};
export const TeachDES5002Reference:Story={name:'asTeach — DES5002 reference',render:()=> <TeachReferenceStudy/>,parameters:{controls:{disable:true},docs:{description:{story:'Read-only local reference. Course text and images are loaded only from an explicitly configured external test fixture; none are bundled with Storybook.'}}}};

export const ReadingNavigation:Story={name:'Reading navigation — history and evidence',render:()=> <ReadingNavigationStudy/>,parameters:{controls:{disable:true},docs:{description:{story:'Shared reading history and CM6 in-memory study. Two fictional measured/target reports, exact return positions and failed navigation. Native repository identities, filesystem references and persistence require packaged acceptance.'}}}};
