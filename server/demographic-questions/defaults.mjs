// Default question set — same 12 questions seeded directly for research 1 in
// code-review-ai/backend/CodeReviewAI.Api/Sql/030_demographic_questionnaire.sql, duplicated here
// (per this project's established per-purpose duplication convention) so any OTHER research that
// turns UsesDemographics on with zero authored questions gets the same lazy-seed fallback the
// Consent Form feature already established (server/consent-sections/defaults.mjs). Adapted from a
// researcher-supplied Google Form, with name/surname/participant-ID fields removed (the magic
// link already identifies the participant).
export const DEFAULT_DEMOGRAPHIC_QUESTIONS = [
  {
    type: 'SINGLE_CHOICE', promptSr: 'Pol', promptEn: 'Gender',
    options: [
      { labelSr: 'Muški', labelEn: 'Male', isOtherSpecify: false },
      { labelSr: 'Ženski', labelEn: 'Female', isOtherSpecify: false },
      { labelSr: 'Ne želim da se izjasnim', labelEn: 'Prefer not to say', isOtherSpecify: false },
    ],
  },
  {
    type: 'SINGLE_CHOICE', promptSr: 'Trenutni radni angažman', promptEn: 'Current employment status',
    options: [
      { labelSr: 'Zaposlen', labelEn: 'Employed', isOtherSpecify: false },
      { labelSr: 'Student', labelEn: 'Student', isOtherSpecify: false },
      { labelSr: 'Nezaposlen', labelEn: 'Unemployed', isOtherSpecify: false },
    ],
  },
  {
    type: 'SINGLE_CHOICE', promptSr: 'Starosna kategorija', promptEn: 'Age bracket',
    options: [
      { labelSr: '18-24', labelEn: '18-24', isOtherSpecify: false },
      { labelSr: '25-34', labelEn: '25-34', isOtherSpecify: false },
      { labelSr: '35-44', labelEn: '35-44', isOtherSpecify: false },
      { labelSr: 'Više od 44', labelEn: 'Over 44', isOtherSpecify: false },
    ],
  },
  {
    type: 'SINGLE_CHOICE', promptSr: 'Najviši završeni stepen obrazovanja', promptEn: 'Highest completed level of education',
    options: [
      { labelSr: 'Srednja škola', labelEn: 'High school', isOtherSpecify: false },
      { labelSr: 'Akademske studije', labelEn: "Bachelor's studies", isOtherSpecify: false },
      { labelSr: 'Master studije', labelEn: "Master's studies", isOtherSpecify: false },
      { labelSr: 'Doktorske studije', labelEn: 'Doctoral studies', isOtherSpecify: false },
    ],
  },
  {
    type: 'SINGLE_CHOICE', promptSr: 'Primarna oblast studija/rada', promptEn: 'Primary field of study or work',
    options: [
      { labelSr: 'Računarstvo', labelEn: 'Computer Science', isOtherSpecify: false },
      { labelSr: 'Informacioni sistemi', labelEn: 'Information Systems', isOtherSpecify: false },
      { labelSr: 'Elektrotehnika', labelEn: 'Electrical Engineering', isOtherSpecify: false },
      { labelSr: 'Matematika', labelEn: 'Mathematics', isOtherSpecify: false },
      { labelSr: 'Drugo (navedite)', labelEn: 'Other (please specify)', isOtherSpecify: true },
    ],
  },
  {
    type: 'SINGLE_CHOICE', promptSr: 'Trenutna primarna uloga (ukoliko ste zaposleni)', promptEn: 'Current primary role (if employed)',
    options: [
      { labelSr: 'Backend Developer', labelEn: 'Backend Developer', isOtherSpecify: false },
      { labelSr: 'Frontend Developer', labelEn: 'Frontend Developer', isOtherSpecify: false },
      { labelSr: 'DevOps', labelEn: 'DevOps', isOtherSpecify: false },
      { labelSr: 'QA Engineer', labelEn: 'QA Engineer', isOtherSpecify: false },
      { labelSr: 'Software Architect', labelEn: 'Software Architect', isOtherSpecify: false },
      { labelSr: 'Data Scientist', labelEn: 'Data Scientist', isOtherSpecify: false },
      { labelSr: 'Business Analyst', labelEn: 'Business Analyst', isOtherSpecify: false },
      { labelSr: 'Project Manager', labelEn: 'Project Manager', isOtherSpecify: false },
      { labelSr: 'Drugo', labelEn: 'Other', isOtherSpecify: true },
    ],
  },
  {
    type: 'SINGLE_CHOICE', promptSr: 'Godine iskustva u programiranju (uključujući studije)', promptEn: 'Years of programming experience (including studies)',
    options: [
      { labelSr: 'Manje od 3 godine', labelEn: 'Less than 3 years', isOtherSpecify: false },
      { labelSr: '3-5 godina', labelEn: '3-5 years', isOtherSpecify: false },
      { labelSr: '6-8 godina', labelEn: '6-8 years', isOtherSpecify: false },
      { labelSr: '9-11 godina', labelEn: '9-11 years', isOtherSpecify: false },
      { labelSr: 'Više od 11 godina', labelEn: 'More than 11 years', isOtherSpecify: false },
    ],
  },
  {
    type: 'SINGLE_CHOICE', promptSr: 'Godine profesionalnog (industrijskog) iskustva', promptEn: 'Years of professional (industry) experience',
    options: [
      { labelSr: 'Manje od 3 godine', labelEn: 'Less than 3 years', isOtherSpecify: false },
      { labelSr: '3-5 godina', labelEn: '3-5 years', isOtherSpecify: false },
      { labelSr: '6-9 godina', labelEn: '6-9 years', isOtherSpecify: false },
      { labelSr: 'Više od 9 godina', labelEn: 'More than 9 years', isOtherSpecify: false },
    ],
  },
  {
    type: 'SINGLE_CHOICE', promptSr: 'Dominantan programski jezik', promptEn: 'Dominant programming language',
    options: [
      { labelSr: 'C#', labelEn: 'C#', isOtherSpecify: false },
      { labelSr: 'Java', labelEn: 'Java', isOtherSpecify: false },
      { labelSr: 'Python', labelEn: 'Python', isOtherSpecify: false },
      { labelSr: 'JavaScript', labelEn: 'JavaScript', isOtherSpecify: false },
      { labelSr: 'TypeScript', labelEn: 'TypeScript', isOtherSpecify: false },
      { labelSr: 'C++', labelEn: 'C++', isOtherSpecify: false },
      { labelSr: 'Drugo', labelEn: 'Other', isOtherSpecify: true },
    ],
  },
  {
    type: 'SINGLE_CHOICE', promptSr: 'Učestalost korišćenja AI alata u radu', promptEn: 'Frequency of using AI tools at work',
    options: [
      { labelSr: 'Nikada', labelEn: 'Never', isOtherSpecify: false },
      { labelSr: 'Retko (par puta mesečno)', labelEn: 'Rarely (a few times a month)', isOtherSpecify: false },
      { labelSr: 'Povremeno (par puta nedeljno)', labelEn: 'Occasionally (a few times a week)', isOtherSpecify: false },
      { labelSr: 'Svakodnevno', labelEn: 'Daily', isOtherSpecify: false },
    ],
  },
  {
    type: 'SINGLE_CHOICE', promptSr: 'Stav prema upotrebi AI alata u programiranju', promptEn: 'Attitude toward using AI tools in programming',
    options: [
      { labelSr: 'AI alati su odlična podrška programerima.', labelEn: 'AI tools are an excellent support for programmers.', isOtherSpecify: false },
      { labelSr: 'AI alati mogu biti od pomoći programerima, ali uz obaveznu kontrolu.', labelEn: 'AI tools can help programmers, but require mandatory oversight.', isOtherSpecify: false },
      { labelSr: 'Koliko pomažu, toliko i otežavaju programiranje.', labelEn: 'They help as much as they hinder programming.', isOtherSpecify: false },
      { labelSr: 'AI alati retko kada pomažu programerima.', labelEn: 'AI tools rarely help programmers.', isOtherSpecify: false },
      { labelSr: 'AI alati ne pružaju nikakvu podršku i olakšanje programerima.', labelEn: 'AI tools provide no support or relief for programmers.', isOtherSpecify: false },
    ],
  },
  {
    type: 'TEXT',
    promptSr: 'Ukratko obrazložite Vaš stav o upotrebi AI alata u programiranju.',
    promptEn: 'Briefly explain your attitude toward the use of AI tools in programming.',
    options: [],
  },
];
