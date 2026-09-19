import type { Meta, StoryObj } from '@storybook/react-vite';
import { FocusedWriting } from './FocusedWriting';
import { OutlineCompanionStudy } from './OutlineCompanionStudy';
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
