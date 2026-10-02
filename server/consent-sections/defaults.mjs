// Default Consent Form content — used to lazily seed a research's ConsentSection rows + the
// Research.ConsentCheckboxText*/columns the first time either gets read with nothing configured
// yet (a brand-new research, or a pre-existing one from before Phase C shipped). Text copied
// verbatim from consent-andrejkatin's original fixed CONSENT.* i18n keys — same content the
// Sql/017_consent_sections.sql migration seeded directly for research Id=1. Duplicated in
// consent-andrejkatin/server/consent-defaults.mjs (that app has no shared package with this
// one, same "duplicated per this project's established convention" pattern used elsewhere,
// e.g. regenerateLinksEmail.mjs vs consentEmail.mjs) — keep both in sync if this ever changes.
export const DEFAULT_CONSENT_SECTIONS = [
  {
    titleSr: 'Cilj istraživanja', titleEn: 'Research Objective',
    bodySr: 'Cilj ovog eksperimenta je da se ispita kako korišćenje alata podržanih veštačkom inteligencijom utiče na kognitivno opterećenje, stil razmišljanja i procenu profesionalnih zadataka kod programera. Vaše učešće nam pomaže u razumevanju interakcije između čoveka i AI sistema u domenu softverskog inženjerstva.',
    bodyEn: 'The aim of this experiment is to examine how the use of AI-assisted tools affects cognitive load, thinking style, and the evaluation of professional tasks among software developers. Your participation helps us understand the interaction between humans and AI systems in the domain of software engineering.',
  },
  {
    titleSr: 'Opis procedure', titleEn: 'Procedure Description',
    bodySr: 'Učešće u istraživanju podrazumeva jednu eksperimentalnu sesiju koja traje 45 do 60 minuta. Sesija će se odvijati u kontrolisanoj laboratoriji na Fakultetu tehničkih nauka u Novom Sadu.',
    bodyEn: 'Participation in the research involves a single experimental session lasting 45 to 60 minutes. The session will take place in a controlled laboratory at the Faculty of Technical Sciences in Novi Sad.',
  },
  {
    titleSr: 'Zadatak', titleEn: 'Task',
    bodySr: 'Biće Vam predstavljeni profesionalni zadaci u vezi sa procenom legacy koda (npr. provera ispravnosti Pull Request-ova), koje ćete rešavati uz korišćenje simuliranog AI asistenta.',
    bodyEn: 'You will be presented with professional tasks related to evaluating legacy code (e.g. reviewing Pull Requests), which you will solve using a simulated AI assistant.',
  },
  {
    titleSr: 'Merenja', titleEn: 'Measurements',
    bodySr: 'U toku rešavanja zadataka, biće korišćen EEG uređaj (Elektroencefalograf) za snimanje električne aktivnosti Vašeg mozga (moždanih talasa). Pored toga, bićete zamoljeni da popunite kratke upitnike za samoprocenu.',
    bodyEn: 'While completing the tasks, an EEG device (electroencephalograph) will be used to record the electrical activity of your brain (brainwaves). In addition, you will be asked to fill out short self-assessment questionnaires.',
  },
  {
    titleSr: 'Korišćenje EEG-a', titleEn: 'Use of EEG',
    bodySr: 'EEG je neinvazivan i potpuno bezbedan metod. Postavlja se na kožu glave i ne izaziva nikakvu bol.',
    bodyEn: 'EEG is a non-invasive and completely safe method. It is placed on the scalp and causes no pain.',
  },
  {
    titleSr: 'Dobrovoljnost učešća i pravo na odustajanje', titleEn: 'Voluntary Participation and Right to Withdraw',
    bodySr: 'Vaše učešće je potpuno dobrovoljno.',
    bodyEn: 'Your participation is entirely voluntary.',
  },
  {
    titleSr: null, titleEn: null,
    bodySr: 'Imate puno pravo da u svakom trenutku prekinete eksperiment, bez ikakvog objašnjenja, i bez ikakvih negativnih posledica po Vas.',
    bodyEn: 'You have the full right to stop the experiment at any time, without any explanation, and without any negative consequences for you.',
  },
  {
    titleSr: null, titleEn: null,
    bodySr: 'U slučaju odustajanja, svi podaci prikupljeni do tog trenutka biće izbrisani.',
    bodyEn: 'If you withdraw, all data collected up to that point will be deleted.',
  },
  {
    titleSr: 'Poverljivost i anonimnost podataka', titleEn: 'Confidentiality and Anonymity of Data',
    bodySr: 'Svi podaci prikupljeni tokom istraživanja biće tretirani kao strogo poverljivi i korišćeni isključivo u akademske i istraživačke svrhe.',
    bodyEn: 'All data collected during the research will be treated as strictly confidential and used exclusively for academic and research purposes.',
  },
  {
    titleSr: null, titleEn: null,
    bodySr: 'Vaše ime, prezime i kontakt informacije biće odvojene od eksperimentalnih podataka.',
    bodyEn: 'Your first name, last name, and contact information will be kept separate from the experimental data.',
  },
  {
    titleSr: null, titleEn: null,
    bodySr: 'Vaši individualni rezultati neće biti objavljivani; u publikacijama će biti korišćeni isključivo grupni i anonimizovani podaci.',
    bodyEn: 'Your individual results will not be published; only group-level, anonymized data will be used in publications.',
  },
  {
    titleSr: 'Kontakt', titleEn: 'Contact',
    bodySr: 'Za sva pitanja i nedoumice u vezi sa istraživanjem, možete nas kontaktirati putem mejl adrese: beyondai.researchgroup@gmail.com',
    bodyEn: 'For any questions or concerns regarding the research, you may contact us at: beyondai.researchgroup@gmail.com',
  },
];

export const DEFAULT_CHECKBOX_TEXT_SR =
  'Pročitao/la sam i razumeo/la sam gore navedene informacije i dobrovoljno pristajem da učestvujem u ovom istraživanju.';
export const DEFAULT_CHECKBOX_TEXT_EN =
  'I have read and understood the information provided above, and I voluntarily agree to participate in this research.';
