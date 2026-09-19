import type { Meta, StoryObj } from '@storybook/react-vite';
import {FocusedWriting} from './FocusedWriting';
export {FocusedWriting} from './FocusedWriting';
const meta={title:'asMagicBrain/Focused writing',component:FocusedWriting,parameters:{layout:'fullscreen'},args:{initialSidebar:false}} satisfies Meta<typeof FocusedWriting>;
export default meta;
type Story=StoryObj<typeof meta>;
export const ReferenceWindow:Story={};
export const SidebarOpen:Story={args:{initialSidebar:true}};
