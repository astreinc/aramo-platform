// ATS-QA-1 I-3 — deterministic mapping corpus: 5 ANONYMISED résumé layouts.
// Every name, employer, school and place below is fictional. Each fixture is
// the résumé TEXT (one source block per non-empty line, exactly as
// buildResumeSourceMap numbers them: B001, B002, …) plus the structured output
// a v4-prompted model returns for it (`model`, referencing blocks by line
// number). No live model is involved: the spec feeds `model` through the real
// grounding + orchestrator mapping and pins the result.

export interface LayoutExpectation {
  readonly listedSkills: readonly string[];
  readonly keySkills: string;
  readonly roles: ReadonlyArray<{ employer: string; title: string; start?: string; end?: string }>;
  readonly education: number;
  readonly warning?: RegExp;
}

export interface ResumeLayoutFixture {
  readonly name: string;
  readonly lines: readonly string[];
  readonly model: (b: (line: number) => string) => Record<string, unknown>;
  readonly expect: LayoutExpectation;
}

// A model work-history entry (transport shape: every property present).
function role(
  employer: string,
  title: string,
  start: string,
  end: string,
  refs: string[],
  skillUsage: Array<{ surface_form: string; refs: string[] }> = [],
): Record<string, unknown> {
  return {
    employer_name: employer,
    role_title: title,
    start_date: start,
    end_date: end,
    employment_type: '',
    location: '',
    experience_summary: '',
    source_refs: refs,
    skill_usage: skillUsage.map((s) => ({
      surface_form: s.surface_form,
      version: '',
      activity: 'DEVELOP',
      usage_start: '',
      usage_end: '',
      usage_period_basis: 'WORK_EXPERIENCE_CONTEXT',
      source_refs: s.refs,
    })),
    projects: [],
    assertions: [],
  };
}

function skill(surface_form: string, refs: string[]): Record<string, unknown> {
  return { surface_form, source_refs: refs };
}

function identity(first: string, last: string, ref: string): Record<string, unknown> {
  return { first_name: first, last_name: last, source_refs: [ref] };
}

const NO_LOCATION = { address: '', city: '', state: '', zip: '', country: '', source_refs: [] };
const NO_PROFESSIONAL = { current_employer: '', title: '', source_refs: [] };

export const RESUME_LAYOUTS: readonly ResumeLayoutFixture[] = [
  // 1 — skills stated ONLY in a Technical Summary paragraph (no Skills section);
  //     one more skill appears only in role text.
  {
    name: 'skills in a technical summary',
    lines: [
      'Priya Raman',
      'Data Engineer',
      'Technical Summary',
      'Eight years building data pipelines with Python, Apache Spark and Snowflake on AWS.',
      'Experience',
      'Bluefin Logistics — Senior Data Engineer, 2019-03 to Present',
      'Orchestrated nightly loads with Airflow and Python.',
      'Education',
      'Lakeside Institute of Technology, BSc Computer Science, 2014',
    ],
    model: (b) => ({
      identity: identity('Priya', 'Raman', b(1)),
      location: NO_LOCATION,
      professional: { current_employer: 'Bluefin Logistics', title: 'Senior Data Engineer', source_refs: [b(6)] },
      skills: [
        skill('Python', [b(4), b(7)]),
        skill('Apache Spark', [b(4)]),
        skill('Snowflake', [b(4)]),
        skill('AWS', [b(4)]),
        skill('Airflow', [b(7)]),
      ],
      work_history: [
        role('Bluefin Logistics', 'Senior Data Engineer', '2019-03', 'Present', [b(6), b(7)], [
          { surface_form: 'Airflow', refs: [b(7)] },
          { surface_form: 'Python', refs: [b(7)] },
        ]),
      ],
      education: [
        {
          institution_name: 'Lakeside Institute of Technology',
          degree_name: 'BSc',
          field_of_study: 'Computer Science',
          conferred_date: '2014',
          source_refs: [b(9)],
        },
      ],
      certifications: [],
    }),
    expect: {
      listedSkills: ['Python', 'Apache Spark', 'Snowflake', 'AWS', 'Airflow'],
      keySkills: 'Python, Apache Spark, Snowflake, AWS, Airflow',
      roles: [{ employer: 'Bluefin Logistics', title: 'Senior Data Engineer', start: '2019-03', end: 'Present' }],
      education: 1,
    },
  },

  // 2 — a separate, categorised Technical Skills section; role text repeats a
  //     listed skill (different case) and adds one the section does not list.
  {
    name: 'separate technical skills section',
    lines: [
      'Marcus Oyelaran',
      'Technical Skills',
      'Languages: Java, Kotlin',
      'Cloud & Platforms: Azure, Kubernetes',
      'Professional Experience',
      'Harborview Insurance | Backend Developer | Jan 2020 - Present',
      'Built claims services in Java; deployed on kubernetes with Terraform.',
    ],
    model: (b) => ({
      identity: identity('Marcus', 'Oyelaran', b(1)),
      location: NO_LOCATION,
      professional: NO_PROFESSIONAL,
      skills: [
        skill('Java', [b(3), b(7)]),
        skill('Kotlin', [b(3)]),
        skill('Azure', [b(4)]),
        skill('Kubernetes', [b(4)]),
        skill('Terraform', [b(7)]),
      ],
      work_history: [
        role('Harborview Insurance', 'Backend Developer', 'Jan 2020', 'Present', [b(6), b(7)], [
          { surface_form: 'Java', refs: [b(7)] },
          { surface_form: 'kubernetes', refs: [b(7)] },
          { surface_form: 'Terraform', refs: [b(7)] },
        ]),
      ],
      education: [],
      certifications: [],
    }),
    expect: {
      listedSkills: ['Java', 'Kotlin', 'Azure', 'Kubernetes', 'Terraform'],
      keySkills: 'Java, Kotlin, Azure, Kubernetes, Terraform',
      roles: [{ employer: 'Harborview Insurance', title: 'Backend Developer', start: 'Jan 2020', end: 'Present' }],
      education: 0,
    },
  },

  // 3 — abbreviated titles in the résumé, written out by the model; plus one
  //     title the résumé does not state and one employer it does not name
  //     (both rejected and REPORTED, not dropped silently).
  {
    name: 'abbreviated titles',
    lines: [
      'Elena Vasquez-Moreau',
      'Northwind Traders — Sr. Software Engr. (2021 - Present)',
      'Maintained the order platform in Go.',
      'Contoso Retail — VP, Engineering & Ops (2017 - 2021)',
      'Kestrel Media — Head of Platform (2014 - 2017)',
    ],
    model: (b) => ({
      identity: identity('Elena', 'Vasquez-Moreau', b(1)),
      location: NO_LOCATION,
      professional: NO_PROFESSIONAL,
      skills: [skill('Go', [b(3)])],
      work_history: [
        role('Northwind Traders', 'Senior Software Engineer', '2021', 'Present', [b(2), b(3)], [
          { surface_form: 'Go', refs: [b(3)] },
        ]),
        role('Contoso Retail', 'Vice President, Engineering and Operations', '2017', '2021', [b(4)]),
        role('Kestrel Media', 'Chief Technology Officer', '2014', '2017', [b(5)]),
        role('Fabrikam Studios', 'Engineer', '2012', '2014', [b(5)]),
      ],
      education: [],
      certifications: [],
    }),
    expect: {
      listedSkills: ['Go'],
      keySkills: 'Go',
      roles: [
        { employer: 'Northwind Traders', title: 'Senior Software Engineer', start: '2021', end: 'Present' },
        {
          employer: 'Contoso Retail',
          title: 'Vice President, Engineering and Operations',
          start: '2017',
          end: '2021',
        },
      ],
      education: 0,
      warning:
        /^2 work history entries couldn’t be matched to the resume text and were left out \(Kestrel Media\)\. Check the resume and add them below if needed\.$/,
    },
  },

  // 4 — year-only dates throughout.
  {
    name: 'year-only dates',
    lines: [
      'Tomasz Wierzbicki',
      'Work History',
      'Acme Analytics, Data Analyst, 2016 – 2019',
      'Built reporting in SQL and Tableau.',
      'Pinecrest Health, Analytics Lead, 2019 – 2023',
      'Education',
      'Riverside College, MSc Statistics, 2015',
    ],
    model: (b) => ({
      identity: identity('Tomasz', 'Wierzbicki', b(1)),
      location: NO_LOCATION,
      professional: NO_PROFESSIONAL,
      skills: [skill('SQL', [b(4)]), skill('Tableau', [b(4)])],
      work_history: [
        role('Acme Analytics', 'Data Analyst', '2016', '2019', [b(3), b(4)], [
          { surface_form: 'SQL', refs: [b(4)] },
        ]),
        role('Pinecrest Health', 'Analytics Lead', '2019', '2023', [b(5)]),
      ],
      education: [
        {
          institution_name: 'Riverside College',
          degree_name: 'MSc',
          field_of_study: 'Statistics',
          conferred_date: '2015',
          source_refs: [b(7)],
        },
      ],
      certifications: [],
    }),
    expect: {
      listedSkills: ['SQL', 'Tableau'],
      keySkills: 'SQL, Tableau',
      roles: [
        { employer: 'Acme Analytics', title: 'Data Analyst', start: '2016', end: '2019' },
        { employer: 'Pinecrest Health', title: 'Analytics Lead', start: '2019', end: '2023' },
      ],
      education: 1,
    },
  },

  // 5 — a long career: 7 roles, a flat Skills line, skills also in role text.
  {
    name: 'six-plus roles',
    lines: [
      'Grace Achterberg',
      'Skills: C#, .NET, SQL Server, React',
      'Experience',
      'Oakridge Bank | Principal Engineer | 2022-01 | Present',
      'Tidewater Energy | Staff Engineer | 2019-06 | 2021-12',
      'Silverline Telecom | Senior Developer | 2017-02 | 2019-05',
      'Maplewood Retail | Developer | 2015-01 | 2017-01',
      'Quarry Labs | Junior Developer | 2013-07 | 2014-12',
      'Brightwater Studio | Web Developer | 2012-01 | 2013-06',
      'Ironbridge Systems | Intern | 2011-06 | 2011-12',
      'Built trading screens in React and TypeScript at Oakridge Bank.',
    ],
    model: (b) => ({
      identity: identity('Grace', 'Achterberg', b(1)),
      location: NO_LOCATION,
      professional: NO_PROFESSIONAL,
      skills: [
        skill('C#', [b(2)]),
        skill('.NET', [b(2)]),
        skill('SQL Server', [b(2)]),
        skill('React', [b(2), b(11)]),
      ],
      work_history: [
        role('Oakridge Bank', 'Principal Engineer', '2022-01', 'Present', [b(4), b(11)], [
          { surface_form: 'React', refs: [b(11)] },
          { surface_form: 'TypeScript', refs: [b(11)] },
        ]),
        role('Tidewater Energy', 'Staff Engineer', '2019-06', '2021-12', [b(5)]),
        role('Silverline Telecom', 'Senior Developer', '2017-02', '2019-05', [b(6)]),
        role('Maplewood Retail', 'Developer', '2015-01', '2017-01', [b(7)]),
        role('Quarry Labs', 'Junior Developer', '2013-07', '2014-12', [b(8)]),
        role('Brightwater Studio', 'Web Developer', '2012-01', '2013-06', [b(9)]),
        role('Ironbridge Systems', 'Intern', '2011-06', '2011-12', [b(10)]),
      ],
      education: [],
      certifications: [],
    }),
    expect: {
      listedSkills: ['C#', '.NET', 'SQL Server', 'React'],
      keySkills: 'C#, .NET, SQL Server, React, TypeScript',
      roles: [
        { employer: 'Oakridge Bank', title: 'Principal Engineer', start: '2022-01', end: 'Present' },
        { employer: 'Tidewater Energy', title: 'Staff Engineer', start: '2019-06', end: '2021-12' },
        { employer: 'Silverline Telecom', title: 'Senior Developer', start: '2017-02', end: '2019-05' },
        { employer: 'Maplewood Retail', title: 'Developer', start: '2015-01', end: '2017-01' },
        { employer: 'Quarry Labs', title: 'Junior Developer', start: '2013-07', end: '2014-12' },
        { employer: 'Brightwater Studio', title: 'Web Developer', start: '2012-01', end: '2013-06' },
        { employer: 'Ironbridge Systems', title: 'Intern', start: '2011-06', end: '2011-12' },
      ],
      education: 0,
    },
  },
];
