/**
 * Post-session questionnaire (2026-10-01) — fixed (not admin-configurable) Q&A text, duplicated
 * here from Nasa-TLX-FullImplementation-AndrejKatin's own POST_SESSION.* i18n keys (same
 * "duplicated per app" convention as rei40-items-meta.ts/bigfive-items-meta.ts). Used only to
 * render PostSessionAnswersModalComponent's read-only Q&A view — nothing here is ever sent back
 * to any app, so staying in sync with the participant-facing wording exactly is a nice-to-have,
 * not a correctness requirement.
 *
 * Q4's wording depends on the session type (Sessions.Id: 1=Intro, 2=AI, 3=Report, 4=Hybrid).
 */

export interface PostSessionQuestionMeta {
  key: 'q1' | 'q2' | 'q3' | 'q4' | 'q5';
  textSr: string;
  textEn: string;
  /** Likert anchors — omitted for the free-text Q5. */
  lowSr?: string;
  lowEn?: string;
  highSr?: string;
  highEn?: string;
}

const Q4_BY_SESSION: Record<number, { textSr: string; textEn: string }> = {
  1: {
    textSr: 'Koliko Vam je uvodna sesija pomogla da se pripremite za dalje korake istraživanja?',
    textEn: 'How much did the introductory session help you prepare for the next steps of the study?',
  },
  2: {
    textSr: 'Koliko Vam je AI asistent pomogao da donesete odluku o Pull Request-u?',
    textEn: 'How much did the AI assistant help you make your decision about the Pull Request?',
  },
  3: {
    textSr: 'Koliko Vam je dokumentacija (izveštaj) pomogla da donesete odluku o Pull Request-u?',
    textEn: 'How much did the documentation/report help you make your decision about the Pull Request?',
  },
  4: {
    textSr: 'Koliko Vam je kombinacija dokumentacije i AI chat-a pomogla da donesete odluku o Pull Request-u?',
    textEn: 'How much did the combination of documentation and AI chat help you make your decision about the Pull Request?',
  },
};

export function postSessionQuestions(sessionId: number): PostSessionQuestionMeta[] {
  const q4 = Q4_BY_SESSION[sessionId] ?? Q4_BY_SESSION[2];
  return [
    {
      key: 'q1',
      textSr: 'Koliko Vam je bilo jasno šta je trebalo da uradite tokom ove sesije?',
      textEn: 'How clearly was it defined what you needed to do during this session?',
      lowSr: 'Nejasno', lowEn: 'Not clear at all',
      highSr: 'Potpuno jasno', highEn: 'Completely clear',
    },
    {
      key: 'q2',
      textSr: 'Koliko Vam je bilo lako da se snađete tokom ove sesije, bez obzira na eventualne poteškoće?',
      textEn: 'How easy was it to get through this session, regardless of any difficulties you may have had?',
      lowSr: 'Veoma teško', lowEn: 'Very difficult',
      highSr: 'Veoma lako', highEn: 'Very easy',
    },
    {
      key: 'q3',
      textSr: 'Koliko ste zadovoljni sopstvenim učinkom tokom ove sesije?',
      textEn: 'How satisfied are you with your own performance during this session?',
      lowSr: 'Nimalo zadovoljan/na', lowEn: 'Not satisfied at all',
      highSr: 'Izuzetno zadovoljan/na', highEn: 'Extremely satisfied',
    },
    {
      key: 'q4',
      textSr: q4.textSr,
      textEn: q4.textEn,
      lowSr: 'Nimalo', lowEn: 'Not at all',
      highSr: 'Izuzetno', highEn: 'Extremely',
    },
    {
      key: 'q5',
      textSr: 'Da li biste nešto izdvojili u vezi sa ovom sesijom — poteškoće, nejasnoće ili predlozi?',
      textEn: "Is there anything you'd like to flag about this session — difficulties, unclear parts, or suggestions?",
    },
  ];
}
