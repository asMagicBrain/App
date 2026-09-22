/** Storybook course model and synthetic defaults; reference data is loaded separately. */
export type TeachStudySection = {id: string; title: string; path: string; source: string};
export type TeachStudyReference = {
  sourceCommit:string;
  home:{title:string;path:string;source:string;kind:'composed'|'document'};
  pages:readonly TeachStudySection[];
  assets?:Readonly<Record<string,string>>;
};
export type TeachStudyCourse = {
  id: string;
  code: string;
  title: string;
  year: string;
  season: string;
  description: string;
  repository: string;
  sections: readonly TeachStudySection[];
  sample?: boolean;
  readOnly?:boolean;
  reference?:TeachStudyReference;
};

export const teachSeasons = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;
export const teachTermFolder = (year: string, season: string) => `${year}-${season.toLowerCase().replace(/\s+/g, '-')}`;
function termSections(sections: readonly TeachStudySection[], year: string, season: string): TeachStudySection[] {
  return sections.map(section => ({...section, path: `${teachTermFolder(year, season)}/Teacher/${section.path}`}));
}

const section = (id: string, title: string, prose: string): TeachStudySection => ({
  id, title, path: `.gitbook/includes/${id}.md`, source: `# ${title}\n\n${prose}\n`,
});

export const teachStudySections: readonly TeachStudySection[] = [
  section('course-description', 'Course Description', 'Explore how thoughtful design begins with observation. Work through small, practical challenges to connect people, materials and ideas.\n\n## How we work\n\nEach week combines a short discussion, a studio activity and time to reflect. Keep a simple record of your process, including ideas that did not work.'),
  section('teaching-goals', 'Teaching Goals', 'Develop a curious, reflective approach to design. Learn to explain decisions and improve an idea through useful feedback.\n\n- Notice the needs and constraints in a situation.\n- Make ideas tangible with simple prototypes.\n- Discuss design choices with care and clarity.'),
  section('learning-outcomes', 'Learning Outcomes', 'By the end of this sample course, you should be able to:\n\n1. Describe a design opportunity using observations.\n2. Compare alternative responses to a brief.\n3. Build and evaluate a small prototype.\n4. Explain how feedback informed a revision.'),
  section('content-summary', 'Content Summary', 'The course moves from noticing a situation to testing an idea.\n\n## Main themes\n\nObservation, framing, sketching, prototyping and reflection. Each theme returns in the studio project so that you can practice it in context.'),
  section('assumed-knowledge', 'Assumed Knowledge', 'No specialist software knowledge is assumed in this illustrative course. Bring a willingness to sketch, ask questions and explain your thinking.\n\n## Before you begin\n\nChoose a familiar everyday object and note one small way it could work better.'),
  section('co-requisite-courses', 'Co-Requisite Courses', 'No co-requisite courses are specified for this sample. A real course would list any companion modules and explain how their activities connect.'),
  section('teaching-team', 'Course Instructor & Teaching Team', 'The teaching team supports studio discussions, practical work and feedback.\n\n## Getting help\n\nUse this section to explain where learners can ask questions and how to arrange a conversation. Names and contact details are intentionally omitted from this sample.'),
  section('grading-policy', 'Grading Policy', 'This sample outlines an assessment approach without assigning real grades or weights.\n\n## Evidence of learning\n\nA process journal shows your exploration. A small prototype makes your proposal tangible. A short reflection explains what changed and why.\n\nA real course should publish its approved assessment criteria and submission requirements here.'),
  section('academic-integrity', 'Academic Integrity', 'Acknowledge the people, sources and tools that contribute to your work. Explain your own decisions and retain evidence of your process.\n\n## Working with others\n\nDistinguish shared exploration from individually submitted work. The approved course policy would define collaboration and AI-use boundaries.'),
  section('university-calendar', 'University Calendar', 'Consult the institution’s official calendar for teaching periods and closures. This illustrative course contains no real calendar dates.\n\n## Planning your time\n\nLeave room for iteration, feedback and documenting your process.'),
  section('recommended-textbooks', 'Recommended Textbook(s)', 'No required textbook is specified in this sample.\n\n## Reading for discussion\n\nA real course could list verified readings here, explain why each is useful and provide accessible routes to the material.'),
  section('teaching-schedule', 'Teaching Schedule', '| Stage | Studio focus | Preparation |\n| --- | --- | --- |\n| Observe | Notice a small everyday problem | Bring observation notes |\n| Explore | Compare possible responses | Make several sketches |\n| Make | Test a simple prototype | Gather suitable materials |\n| Reflect | Share evidence and next steps | Review your process journal |\n\nThis sequence is illustrative; it is not a dated timetable.'),
  section('important-deadlines', 'Important Deadlines', 'Submission dates have not been assigned in this sample.\n\n## Course milestones\n\n- Share an initial observation.\n- Discuss a prototype in progress.\n- Present the revised proposal and reflection.\n\nA real course should give each milestone a confirmed date, time and submission location.'),
];

export const teachStudyCourse: TeachStudyCourse = {
  id: 'des101', code: 'DES101', title: 'Design foundations', year: '2026', season: 'Autumn',
  description: 'An illustrative course for exploring how asTeach could work in asMagicBrain.',
  repository: 'DES101', sections: termSections(teachStudySections, '2026', 'Autumn'), sample: true,
};

const interactionDesignSections: readonly TeachStudySection[] = [
  section('course-description', 'Course Description', 'Investigate how people understand and use interactive products. This illustrative course focuses on interfaces, feedback and small usability studies.\n\n## Studio approach\n\nMap a task, build an interactive prototype and observe how a participant completes it.'),
  section('teaching-goals', 'Teaching Goals', 'Connect interaction design choices to observed user behavior.\n\n- Make system status and next steps understandable.\n- Explore alternative interaction patterns.\n- Use research observations to guide revisions.'),
  section('learning-outcomes', 'Learning Outcomes', 'By the end of this sample course, you should be able to:\n\n1. Map the steps in a familiar digital task.\n2. Prototype an interaction with clear feedback.\n3. Plan a small usability observation.\n4. Explain a revision using evidence from a test.'),
  section('content-summary', 'Content Summary', 'The studio follows a digital service from task analysis to an evaluated prototype.\n\n## Main themes\n\nUser journeys, navigation, interface states, accessibility and usability observation.'),
  section('assumed-knowledge', 'Assumed Knowledge', 'This illustrative course assumes experience with basic design exploration and explaining a design decision.\n\n## Before you begin\n\nRecord the steps required to complete a familiar task in an app.'),
  section('co-requisite-courses', 'Co-Requisite Courses', 'No companion module is assigned in this interaction design sample. Any actual co-requisite would need confirmation before publication.'),
  section('teaching-team', 'Course Instructor & Teaching Team', 'An interaction design teaching team would support interface critiques and research planning.\n\n## Studio support\n\nUse this section to add confirmed consultation arrangements. This synthetic sample includes no personal contact details.'),
  section('grading-policy', 'Grading Policy', 'Illustrative evidence includes a task map, an interactive prototype and a usability reflection.\n\n## Assessment details\n\nNo real weights or grades are assigned. Approved criteria and submission requirements would be added by the course team.'),
  section('academic-integrity', 'Academic Integrity', 'Identify reused interface assets, external sources and tools in your process record.\n\n## Research records\n\nDistinguish observations from your interpretations. A real course would supply approved collaboration, participant-consent and AI-use requirements.'),
  section('university-calendar', 'University Calendar', 'No actual term dates are included in this sample. Consult the institution’s official calendar before arranging studio reviews.\n\n## Planning sessions\n\nAllow time to prepare the prototype and revise it after each observation.'),
  section('recommended-textbooks', 'Recommended Textbook(s)', 'This sample does not prescribe an interaction design textbook.\n\n## Reading topics\n\nA course team could add verified, accessible readings on interface feedback, navigation and usability methods.'),
  section('teaching-schedule', 'Teaching Schedule', '| Stage | Interaction focus | Preparation |\n| --- | --- | --- |\n| Map | Trace a digital task | Bring a task walkthrough |\n| Prototype | Explore interface states | Sketch alternative flows |\n| Observe | Try a usability session | Prepare a short task script |\n| Revise | Improve feedback and navigation | Summarize observations |\n\nThis synthetic sequence has no scheduled dates.'),
  section('important-deadlines', 'Important Deadlines', 'No submission dates have been set for this interaction design sample.\n\n## Studio milestones\n\n- Discuss a task map.\n- Try an interactive prototype.\n- Share a usability reflection and revised flow.\n\nThe course team would supply confirmed dates and submission locations.'),
];

export const teachStudyCourses: readonly TeachStudyCourse[] = [
  teachStudyCourse,
  {
    id: 'des202', code: 'DES202', title: 'Interaction design', year: '2026', season: 'Spring',
    description: 'A second illustrative course about digital tasks, interface feedback and usability.',
    repository: 'DES202', sections: termSections(interactionDesignSections, '2026', 'Spring'), sample: true,
  },
];

/** Preserve the display code; only repository names replace slashes. */
export const teachCourseRepositoryName = (code: string) => `${code.replaceAll('/', '_')}_asTeach`;

/** Builds only the course structure. New courses contain no sample syllabus text. */
export function createEmptyTeachCourse(input: {
  id: string; code: string; title: string; year: string; season: string; description?: string; repository?: string;
}): TeachStudyCourse {
  return {
    id: input.id, code: input.code, title: input.title, year: input.year, season: input.season,
    description: input.description ?? '', repository: input.repository ?? teachCourseRepositoryName(input.code),
    sections: teachStudySections.map(section => ({...section, path:`${teachTermFolder(input.year,input.season)}/sections/${section.id}.md`, source: ''})),
    sample: false,
  };
}
