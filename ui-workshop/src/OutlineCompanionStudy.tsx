import React from 'react';
import {FocusedWriting} from './FocusedWriting';

/** Current same-window outline; retain the story export so review links work. */
export function OutlineCompanionStudy() {
  return <FocusedWriting repositoryHeader repositoryCode initialRepository="asTeach-App" initialEdit initialTheme="light-default"/>;
}
