import { Injectable } from '@angular/core';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';

export interface ParsedParticipantRow {
  participantId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  language: 'sr' | 'en' | null;
  /** Generic Task's title (matched against the research's own GenericTask rows), only meaningful
   *  when taskType==='GENERIC' — null means unassigned. Same "brand-new participants only, never
   *  reassigns an existing one" rule as Email/Language, applied server-side. */
  genericTask: string | null;
  /** Participant group's name (matched against the research's groups, case-insensitively), only meaningful
   *  for a research that defines groups — null means "no group yet". Brand-new participants only. */
  group: string | null;
  /** Label of the PR the participant reviews (Code Review protocol), matched against the research's PR tasks. */
  prTask: string | null;
  /** Study task (A / B ...), matched against the research's tasks case-insensitively. Empty = drawn automatically. */
  researchTask: string | null;
}

export interface ParsedTaskRow {
  participantId: string;
  session: 'AI' | 'REPORT';
  taskLabel: string;
}

export interface ParseIssue {
  sheet: string;
  row: number; // 1-based data row (1 = first row under the header)
  message: string;
}

export interface ParsedImportFile {
  participants: ParsedParticipantRow[];
  tasks: ParsedTaskRow[];
  issues: ParseIssue[];
  sheetsFound: string[];
}

const MAX_ROWS_PER_SHEET = 500;
const MAX_ID_LENGTH = 50;
const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 255;

// Kept as a local literal union (rather than importing AdminApiService's `TaskType`) so this
// service doesn't need a dependency on admin-api.service.ts just for a type.
export type ImportTaskType = 'PR_REVIEW' | 'GOOGLE_FORMS' | 'GENERIC';

/**
 * Client-side Excel template generation + parsing for the participant import flow. Parsing
 * happens entirely in the browser so the backend keeps its simple JSON contract — the parsed,
 * validated arrays are what actually get POSTed to /import.
 *
 * Two libraries, deliberately: template *generation* uses exceljs (the free `xlsx` package
 * can't write cell data-validation dropdowns — that's an XLSX feature exceljs supports and xlsx
 * doesn't in its open-source build); *parsing* an uploaded file keeps using `xlsx`/SheetJS, which
 * already handles that side fine and predates this rewrite — no reason to touch working, tested
 * code just to use one library everywhere.
 */
@Injectable({ providedIn: 'root' })
export class ExcelImportService {
  /**
   * taskType: the selected research's Task Configuration type. Only `PR_REVIEW` (the classic
   * BeyondAI review flow) has anything for the Tasks sheet to assign (an AI/Report session with a
   * PR to review) — for any other type there's no PR-review concept at all, so the template drops
   * the Tasks sheet entirely and becomes a plain participants-only template. `parseFile()` already
   * treats a missing Tasks sheet as "zero tasks", not an error, so this needs no backend change.
   *
   * taskLabels: the labels of this research's PR tasks EXCLUDING the Intro task (see
   * AdminApiService.getPrConfigs — filter out the one with isIntro===true before passing here) —
   * becomes a real dropdown on the Tasks sheet's Task column. Pass an empty array for "no
   * non-Intro tasks added yet" (validation is simply skipped in that case, rather than generating
   * a dropdown with nothing in it). Ignored entirely when taskType isn't PR_REVIEW, since there's
   * no Tasks sheet to put it on.
   */
  async downloadTemplate(
    lang: 'sr' | 'en',
    taskType: ImportTaskType,
    taskLabels: string[] = [],
    genericTaskTitles: string[] = [],
    groupNames: string[] = [],
    prTaskLabels: string[] = [],
    researchTaskNames: string[] = []
  ): Promise<void> {
    const wb = new ExcelJS.Workbook();
    const isPrReview = taskType === 'PR_REVIEW';
    const isGeneric = taskType === 'GENERIC';

    this.buildInstructionsSheet(wb, lang, taskType, taskLabels.length > 0, genericTaskTitles.length > 0, groupNames.length > 0, prTaskLabels.length > 0);
    this.buildParticipantsSheet(wb, lang, isGeneric ? genericTaskTitles : [], groupNames, prTaskLabels, researchTaskNames);
    if (isPrReview) this.buildTasksSheet(wb, lang, taskLabels);

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = lang === 'sr' ? 'uvoz-ucesnika-template.xlsx' : 'participant-import-template.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  }

  private buildInstructionsSheet(
    wb: ExcelJS.Workbook,
    lang: 'sr' | 'en',
    taskType: ImportTaskType,
    hasPrConfigs: boolean,
    hasGenericTasks: boolean,
    hasGroups = false,
    hasPrTasks = false
  ): void {
    const sheet = wb.addWorksheet(lang === 'sr' ? 'Uputstvo' : 'Instructions');
    sheet.columns = [{ width: 100 }];
    const isPrReview = taskType === 'PR_REVIEW';
    const isGeneric = taskType === 'GENERIC';

    if (!isPrReview) {
      // The GenericTask bullet (and its "no tasks yet" note) only apply to the GENERIC task
      // type — GOOGLE_FORMS gets the exact same plain instructions as before this feature existed.
      const genericTaskLines: { text: string; bold?: boolean }[] = !isGeneric
        ? []
        : lang === 'sr'
          ? [
              { text: '  • GenericTask — opciono. Naziv jednog od zadataka definisanih na stranici "Konfiguracija' },
              { text: '    zadatka" (padajuća lista) — dodeljuje taj zadatak ovom ispitaniku. Isto kao Email/Language,' },
              { text: '    postavlja se SAMO za potpuno nove učesnike; za postojećeg učesnika se menja preko dropdown-a' },
              { text: '    na samoj stranici sa zadacima, ne preko ovog uvoza.' },
            ]
          : [
              { text: '  • GenericTask — optional. The title of one of the tasks defined on the "Task configuration"' },
              { text: '    page (dropdown) — assigns that task to this participant. Same as Email/Language, only set' },
              { text: '    for brand-new participants; an existing participant\'s assignment is changed via the' },
              { text: '    dropdown on the tasks page itself, not through this import.' },
            ];
      const noGenericTasksNote: { text: string; bold?: boolean }[] =
        isGeneric && !hasGenericTasks
          ? lang === 'sr'
            ? [
                { text: '' },
                { text: 'NAPOMENA: ovo istraživanje još uvek nema nijedan definisan zadatak, pa kolona GenericTask', bold: true },
                { text: 'nema padajuću listu. Dodajte bar jedan zadatak na stranici "Konfiguracija zadatka", pa preuzmite template ponovo.' },
              ]
            : [
                { text: '' },
                { text: 'NOTE: this research has no task defined yet, so the GenericTask column has no dropdown', bold: true },
                { text: 'list. Add at least one task on the "Task configuration" page, then download the template again.' },
              ]
          : [];

      const groupLines: { text: string; bold?: boolean }[] = !hasGroups
        ? []
        : lang === 'sr'
          ? [
              { text: '  • Group — opciono. Naziv jedne od grupa definisanih na stranici "Nacrt istraživanja" (padajuća' },
              { text: '    lista, npr. Kontrola ili Tretman). Postavlja se SAMO za potpuno nove učesnike. Prazno polje = učesnik' },
              { text: '    još nema grupu: rasporedite ga ručno na stranici sa učesnicima ili ga platforma nasumično' },
              { text: '    rasporedi (dugme "Rasporedi nasumično"). Protokol se ne može pokrenuti učesniku bez grupe.' },
            ]
          : [
              { text: '  • Group — optional. The name of one of the groups defined on the "Research design" page (dropdown,' },
              { text: '    e.g. Control or Treatment). Only set for brand-new participants. An empty cell = the participant has' },
              { text: '    no group yet: assign them by hand on the participants page or let the platform assign them at' },
              { text: '    random ("Assign at random" button). The protocol cannot be started for a participant without a group.' },
            ];

      const prTaskLines: { text: string; bold?: boolean }[] = !hasPrTasks
        ? []
        : lang === 'sr'
          ? [
              { text: '  • Task — naziv PR zadatka koji ovaj učesnik pregleda (padajuća lista zadataka sa stranice "Konfiguracija' },
              { text: '    zadatka"). Postavlja se SAMO za potpuno nove učesnike; kasnije se menja u listi učesnika. Bez zadatka se' },
              { text: '    korak Code Review ne može poslati učesniku.' },
            ]
          : [
              { text: '  • Task — the name of the PR task this participant reviews (dropdown of the tasks from the "Task' },
              { text: '    configuration" page). Only set for brand-new participants; change it later in the participant list.' },
              { text: '    Without a task the Code Review step cannot be sent to the participant.' },
            ];

      const simpleLines: { text: string; bold?: boolean }[] =
        lang === 'sr'
          ? [
              { text: 'Uputstvo za uvoz učesnika', bold: true },
              { text: '' },
              { text: 'Ovo istraživanje ne koristi PR pregled (Task type nije "Pull Request Review"),' },
              { text: 'pa ovaj template sadrži samo listu učesnika — nema liste "Tasks" niti dodele sesija/PR-ova.' },
              { text: '' },
              { text: 'List "Participants" — ispitanici', bold: true },
              { text: 'Svaki red je jedan ispitanik koji treba da postoji (ili već postoji) u sistemu.' },
              { text: '  • ParticipantId — obavezno. Jedinstveni identifikator (do 50 karaktera), npr. "001".' },
              { text: '  • FirstName, LastName — opciono.' },
              { text: '  • Email — opciono. Koristi se za slanje pozivnica (Google Calendar, REI-40/Big Five linkovi).' },
              { text: '  • Language — opciono, "sr" ili "en". Ako je već postavljen za postojećeg učesnika (npr. preko' },
              { text: '    Consent aplikacije), ovaj uvoz ga NE menja — samo se postavlja za potpuno nove učesnike.' },
              ...genericTaskLines,
              ...groupLines,
              ...prTaskLines,
              { text: '  • Postojeći učesnik (isti ParticipantId) se preskače u potpunosti — ovaj list ga ne ažurira.' },
              ...noGenericTasksNote,
              { text: '' },
              { text: 'VAŽNO: kolona ParticipantId mora ostati formatirana kao Tekst da bi se sačuvale vodeće nule' },
              { text: '(npr. "001") — primer u susednom listu je već tako formatiran; kada dodajete nove redove,' },
              { text: 'kopirajte format iz postojeće ćelije ili unesite vrednost sa apostrofom ispred, npr. \'001.' },
            ]
          : [
              { text: 'Participant import instructions', bold: true },
              { text: '' },
              { text: 'This research doesn\'t use PR review (Task type isn\'t "Pull Request Review"), so this' },
              { text: 'template only has a participant list — no "Tasks" sheet or session/PR assignment.' },
              { text: '' },
              { text: '"Participants" sheet — participants', bold: true },
              { text: 'Each row is one participant who should exist (or already exists) in the system.' },
              { text: '  • ParticipantId — required. Unique identifier (up to 50 characters), e.g. "001".' },
              { text: '  • FirstName, LastName — optional.' },
              { text: '  • Email — optional. Used to send invites (Google Calendar, REI-40/Big Five links).' },
              { text: '  • Language — optional, "sr" or "en". If already set for an existing participant (e.g. via' },
              { text: '    the Consent app), this import does NOT change it — only set for brand-new participants.' },
              ...genericTaskLines,
              ...groupLines,
              ...prTaskLines,
              { text: '  • An existing participant (same ParticipantId) is skipped entirely — this sheet never updates one.' },
              ...noGenericTasksNote,
              { text: '' },
              { text: 'IMPORTANT: keep the ParticipantId column formatted as Text to preserve leading zeros' },
              { text: '(e.g. "001") — the example in the other sheet is already formatted that way; when adding' },
              { text: 'new rows, copy the format from an existing cell, or prefix the value with an apostrophe, e.g. \'001.' },
            ];

      simpleLines.forEach((line, i) => {
        const row = sheet.getRow(i + 1);
        row.getCell(1).value = line.text;
        if (line.bold) row.getCell(1).font = { bold: true, size: line.text.length < 40 ? 13 : 11 };
        row.getCell(1).alignment = { wrapText: false };
      });
      return;
    }

    const lines: { text: string; bold?: boolean }[] =
      lang === 'sr'
        ? [
            { text: 'Uputstvo za uvoz učesnika', bold: true },
            { text: '' },
            { text: 'List "Participants" — ispitanici', bold: true },
            { text: 'Svaki red je jedan ispitanik koji treba da postoji (ili već postoji) u sistemu.' },
            { text: '  • ParticipantId — obavezno. Jedinstveni identifikator (do 50 karaktera), npr. "001".' },
            { text: '  • FirstName, LastName — opciono.' },
            { text: '  • Email — opciono. Koristi se za slanje pozivnica (Google Calendar, REI-40/Big Five linkovi).' },
            { text: '  • Language — opciono, "sr" ili "en". Ako je već postavljen za postojećeg učesnika (npr. preko' },
            { text: '    Consent aplikacije), ovaj uvoz ga NE menja — samo se postavlja za potpuno nove učesnike.' },
            { text: '  • Postojeći učesnik (isti ParticipantId) se preskače u potpunosti — ovaj list ga ne ažurira.' },
            { text: '' },
            { text: 'List "Tasks" — dodela sesija i zadataka', bold: true },
            { text: 'Svaki red dodeljuje JEDNU AI ili Report sesiju jednom ispitaniku, sa zadatkom (PR-om) koji treba da pregleda.' },
            { text: '  • ParticipantId — obavezno; ispitanik mora postojati (ovde u listu "Participants" ili već u sistemu).' },
            { text: '  • Session — obavezno, "AI" ili "REPORT" (padajuća lista u koloni B).' },
            { text: '  • Task — obavezno, LABELA zadatka definisanog na stranici "Konfiguracija zadatka" (ne broj PR-a)' },
            { text: '    (padajuća lista u koloni C — vidi napomenu ispod ako je lista prazna).' },
            { text: '' },
            { text: 'VAŽNO — uvodna (Intro) sesija se NE navodi u ovom listu:', bold: true },
            { text: 'sistem je automatski dodaje kao prvu sesiju svakog ispitanika. Ako je na stranici "Konfiguracija' },
            { text: 'zadatka" neki zadatak označen kao Intro, baš taj PR se otvara u Intro sesiji — u suprotnom Intro' },
            { text: 'sesija nema PR pregled. Intro zadatak se nikad ne bira u ovom listu, niti se nudi u padajućoj listi' },
            { text: 'kolone Task — vi birate samo redosled AI/Report koji dolaze POSLE Intro-a.' },
            { text: '' },
            { text: 'Redosled AI/Report se određuje REDOSLEDOM REDOVA u ovom listu, po ispitaniku:', bold: true },
            { text: 'koji god od (AI, REPORT) red se prvi pojavi za datog ispitanika, ta sesija će mu se otvoriti' },
            { text: 'druga po redu (posle Intro-a), a druga će biti treća. Ovo omogućava da istraživač sam' },
            { text: 'nasumično bira kombinacije redosleda po ispitaniku (counterbalancing) — vidi primer ispod:' },
            { text: '  001, AI, Task-A       → ispitanik 001 ide Intro → AI → Report' },
            { text: '  001, REPORT, Task-B' },
            { text: '  002, REPORT, Task-B   → ispitanik 002 ide Intro → Report → AI' },
            { text: '  002, AI, Task-A' },
            { text: '' },
            { text: 'Možete uneti samo jedan od dva reda po ispitaniku (npr. samo AI) — Report se može dodati' },
            { text: 'kasnijim uvozom; redosled se svejedno ispravno određuje u odnosu na ono što ispitanik već ima.' },
            { text: '' },
            { text: 'VAŽNO: kolona ParticipantId mora ostati formatirana kao Tekst da bi se sačuvale vodeće nule' },
            { text: '(npr. "001") — primeri u susednim listovima su već tako formatirani; kada dodajete nove redove,' },
            { text: 'kopirajte format iz postojeće ćelije ili unesite vrednost sa apostrofom ispred, npr. \'001.' },
          ]
            .concat(
              hasPrConfigs
                ? []
                : [
                    { text: '' },
                    {
                      text: 'NAPOMENA: ovo istraživanje još uvek nema nijedan ne-Intro zadatak, pa kolona Task u listu "Tasks"',
                      bold: true,
                    },
                    { text: 'nema padajuću listu. Dodajte bar jedan zadatak na stranici "PR Configuration", pa preuzmite template ponovo.' },
                  ]
            )
        : [
            { text: 'Participant import instructions', bold: true },
            { text: '' },
            { text: '"Participants" sheet — participants', bold: true },
            { text: 'Each row is one participant who should exist (or already exists) in the system.' },
            { text: '  • ParticipantId — required. Unique identifier (up to 50 characters), e.g. "001".' },
            { text: '  • FirstName, LastName — optional.' },
            { text: '  • Email — optional. Used to send invites (Google Calendar, REI-40/Big Five links).' },
            { text: '  • Language — optional, "sr" or "en". If already set for an existing participant (e.g. via' },
            { text: '    the Consent app), this import does NOT change it — only set for brand-new participants.' },
            { text: '  • An existing participant (same ParticipantId) is skipped entirely — this sheet never updates one.' },
            { text: '' },
            { text: '"Tasks" sheet — session + task assignment', bold: true },
            { text: 'Each row assigns ONE AI or Report session to one participant, with the task (PR) they should review.' },
            { text: '  • ParticipantId — required; the participant must exist (here in "Participants", or already in the system).' },
            { text: '  • Session — required, "AI" or "REPORT" (dropdown in column B).' },
            { text: '  • Task — required, the LABEL of a task defined on the "Task configuration" page (not a PR number)' },
            { text: '    (dropdown in column C — see the note below if the list is empty).' },
            { text: '' },
            { text: 'IMPORTANT — the Intro session is NOT listed in this sheet:', bold: true },
            { text: 'the system adds it automatically as every participant\'s first session. If a task is flagged as' },
            { text: 'the Intro task on "Task configuration", that PR is what opens in the Intro session — otherwise' },
            { text: 'Intro has no PR review at all. The Intro task is never picked here, nor offered in the Task' },
            { text: 'column\'s dropdown — you only choose the order of AI/Report that come AFTER Intro.' },
            { text: '' },
            { text: 'AI/Report order is determined by ROW ORDER in this sheet, per participant:', bold: true },
            { text: 'whichever of (AI, REPORT) appears first for a given participant becomes their second session' },
            { text: '(right after Intro), and the other becomes their third. This lets a researcher freely pick a' },
            { text: 'random order per participant (counterbalancing) — see the example below:' },
            { text: '  001, AI, Task-A       → participant 001 goes Intro → AI → Report' },
            { text: '  001, REPORT, Task-B' },
            { text: '  002, REPORT, Task-B   → participant 002 goes Intro → Report → AI' },
            { text: '  002, AI, Task-A' },
            { text: '' },
            { text: 'You can enter just one of the two rows per participant (e.g. only AI) — Report can be added in' },
            { text: 'a later import; the order is still resolved correctly against what the participant already has.' },
            { text: '' },
            { text: 'IMPORTANT: keep the ParticipantId column formatted as Text to preserve leading zeros' },
            { text: '(e.g. "001") — the examples in the other sheets are already formatted that way; when adding' },
            { text: 'new rows, copy the format from an existing cell, or prefix the value with an apostrophe, e.g. \'001.' },
          ]
            .concat(
              hasPrConfigs
                ? []
                : [
                    { text: '' },
                    {
                      text: 'NOTE: this research has no non-Intro task added yet, so the Tasks sheet\'s Task column has no',
                      bold: true,
                    },
                    { text: 'dropdown list. Add at least one task on the "PR Configuration" page, then download the template again.' },
                  ]
            );

    lines.forEach((line, i) => {
      const row = sheet.getRow(i + 1);
      row.getCell(1).value = line.text;
      if (line.bold) row.getCell(1).font = { bold: true, size: line.text.length < 40 ? 13 : 11 };
      row.getCell(1).alignment = { wrapText: false };
    });
  }

  private buildParticipantsSheet(wb: ExcelJS.Workbook, lang: 'sr' | 'en', genericTaskTitles: string[], groupNames: string[] = [], prTaskLabels: string[] = [], researchTaskNames: string[] = []): void {
    const sheet = wb.addWorksheet('Participants');
    const hasResearchTasks = researchTaskNames.length > 0;
    const hasGenericTasks = genericTaskTitles.length > 0;
    const hasGroups = groupNames.length > 0;
    const hasPrTasks = prTaskLabels.length > 0;
    sheet.columns = [
      { header: 'ParticipantId', key: 'participantId', width: 16 },
      { header: 'FirstName', key: 'firstName', width: 18 },
      { header: 'LastName', key: 'lastName', width: 18 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Language', key: 'language', width: 12 },
      ...(hasGenericTasks ? [{ header: 'GenericTask', key: 'genericTask', width: 28 }] : []),
      ...(hasGroups ? [{ header: 'Group', key: 'group', width: 20 }] : []),
      ...(hasPrTasks ? [{ header: 'Task', key: 'prTask', width: 24 }] : []),
      ...(hasResearchTasks ? [{ header: 'ResearchTask', key: 'researchTask', width: 22 }] : []),
    ];
    sheet.getColumn('participantId').numFmt = '@';
    sheet.addRow({
      participantId: '001',
      firstName: 'Marko',
      lastName: 'Marković',
      email: 'marko@example.com',
      language: lang,
      ...(hasGenericTasks ? { genericTask: genericTaskTitles[0] } : {}),
      ...(hasGroups ? { group: groupNames[0] } : {}),
      ...(hasPrTasks ? { prTask: prTaskLabels[0] } : {}),
      ...(hasResearchTasks ? { researchTask: researchTaskNames[0] } : {}),
    });
    sheet.addRow({ participantId: '002', firstName: '', lastName: '', email: '', language: '', genericTask: '', group: hasGroups ? (groupNames[1] ?? groupNames[0]) : '', prTask: hasPrTasks ? (prTaskLabels[1] ?? prTaskLabels[0]) : '', researchTask: hasResearchTasks ? (researchTaskNames[1] ?? researchTaskNames[0]) : '' });

    // GenericTask dropdown (mirrors buildTasksSheet's own _PrNumbers hidden-reference-sheet
    // pattern) — sourced from this research's real task titles, hidden reference sheet rather
    // than an inline formula list since titles can be long and there's no cap on task count.
    if (hasGenericTasks) {
      const refSheet = wb.addWorksheet('_GenericTasks');
      refSheet.state = 'veryHidden';
      genericTaskTitles.forEach((title, i) => {
        refSheet.getCell(`A${i + 1}`).value = title;
      });
      const errorMessage =
        lang === 'sr'
          ? 'Taj naziv zadatka ne postoji u ovom istraživanju.'
          : 'That task title does not exist in this research.';
      for (let r = 2; r <= MAX_ROWS_PER_SHEET + 1; r++) {
        sheet.getCell(`F${r}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [`_GenericTasks!$A$1:$A$${genericTaskTitles.length}`],
          showErrorMessage: true,
          errorStyle: 'error',
          error: errorMessage,
        };
      }
    }
    if (hasGroups) this.addGroupDropdown(wb, sheet, lang, groupNames, hasGenericTasks ? 'G' : 'F');
    if (hasResearchTasks) {
      const col = String.fromCharCode('F'.charCodeAt(0) + (hasGenericTasks ? 1 : 0) + (hasGroups ? 1 : 0) + (hasPrTasks ? 1 : 0));
      this.addResearchTaskDropdown(wb, sheet, lang, researchTaskNames, col);
    }
    if (hasPrTasks) {
      // Same hidden-reference-sheet dropdown as the groups: only this research's PR task labels are accepted.
      const col = String.fromCharCode('F'.charCodeAt(0) + (hasGenericTasks ? 1 : 0) + (hasGroups ? 1 : 0));
      const ref = wb.addWorksheet('_PrTasks');
      ref.state = 'veryHidden';
      prTaskLabels.forEach((label, i) => { ref.getCell(`A${i + 1}`).value = label; });
      const error = lang === 'sr' ? 'Taj PR zadatak ne postoji u ovom istraživanju.' : 'That PR task does not exist in this research.';
      for (let r = 2; r <= MAX_ROWS_PER_SHEET + 1; r++) {
        sheet.getCell(`${col}${r}`).dataValidation = {
          type: 'list', allowBlank: true, formulae: [`_PrTasks!$A$1:$A$${prTaskLabels.length}`],
          showErrorMessage: true, errorStyle: 'error', error,
        };
      }
    }
  }

  /** Study-task dropdown for the Participants sheet (a hidden reference sheet feeding a list validation, like the groups). */
  private addResearchTaskDropdown(wb: ExcelJS.Workbook, sheet: ExcelJS.Worksheet, lang: 'sr' | 'en', names: string[], column: string): void {
    const refSheet = wb.addWorksheet('_ResearchTasks');
    refSheet.state = 'veryHidden';
    names.forEach((name, i) => { refSheet.getCell(`A${i + 1}`).value = name; });
    const error = lang === 'sr' ? 'Taj zadatak ne postoji u ovom istraživanju.' : 'That task does not exist in this research.';
    for (let r = 2; r <= MAX_ROWS_PER_SHEET + 1; r++) {
      sheet.getCell(`${column}${r}`).dataValidation = {
        type: 'list', allowBlank: true, formulae: [`_ResearchTasks!$A$1:$A$${names.length}`],
        showErrorMessage: true, errorStyle: 'error', error,
      };
    }
  }

  /** Group dropdown for the Participants sheet: a hidden reference sheet (like _GenericTasks) feeding a list validation. */
  private addGroupDropdown(wb: ExcelJS.Workbook, sheet: ExcelJS.Worksheet, lang: 'sr' | 'en', groupNames: string[], column: string): void {
    const refSheet = wb.addWorksheet('_Groups');
    refSheet.state = 'veryHidden';
    groupNames.forEach((name, i) => {
      refSheet.getCell(`A${i + 1}`).value = name;
    });
    const errorMessage =
      lang === 'sr' ? 'Ta grupa ne postoji u ovom istraživanju.' : 'That group does not exist in this research.';
    for (let r = 2; r <= MAX_ROWS_PER_SHEET + 1; r++) {
      sheet.getCell(`${column}${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`_Groups!$A$1:$A$${groupNames.length}`],
        showErrorMessage: true,
        errorStyle: 'error',
        error: errorMessage,
      };
    }
  }

  private buildTasksSheet(wb: ExcelJS.Workbook, lang: 'sr' | 'en', taskLabels: string[]): void {
    const sheet = wb.addWorksheet('Tasks');
    sheet.columns = [
      { header: 'ParticipantId', key: 'participantId', width: 16 },
      { header: 'Session', key: 'session', width: 14 },
      { header: 'Task', key: 'taskLabel', width: 20 },
    ];
    sheet.getColumn('participantId').numFmt = '@';

    const uniqueLabels = [...new Set(taskLabels)];
    const exampleTask1 = uniqueLabels[0] ?? 'Task-A';
    const exampleTask2 = uniqueLabels[1] ?? exampleTask1;
    sheet.addRow({ participantId: '001', session: 'AI', taskLabel: exampleTask1 });
    sheet.addRow({ participantId: '001', session: 'REPORT', taskLabel: exampleTask2 });
    sheet.addRow({ participantId: '002', session: 'REPORT', taskLabel: exampleTask2 });
    sheet.addRow({ participantId: '002', session: 'AI', taskLabel: exampleTask1 });

    // Dropdown restricting Session (column B) to exactly AI/REPORT — the whole reason this sheet
    // is built with exceljs instead of xlsx (SheetJS's free build can't write dataValidations).
    for (let r = 2; r <= MAX_ROWS_PER_SHEET + 1; r++) {
      sheet.getCell(`B${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"AI,REPORT"'],
        showErrorMessage: true,
        errorStyle: 'error',
        error:
          lang === 'sr' ? 'Vrednost mora biti "AI" ili "REPORT".' : 'Value must be "AI" or "REPORT".',
      };
    }

    // Task dropdown (column C), sourced from this specific research's real PR task labels
    // (Intro task already excluded by the caller). A hidden reference sheet + range reference
    // avoids Excel's ~255-char inline-formula limit once a research has many tasks (deliberately
    // unbounded — no cap anywhere in this app). Skipped entirely if the research has no non-Intro
    // task yet (see the Instructions-sheet note in that case).
    if (uniqueLabels.length > 0) {
      const refSheet = wb.addWorksheet('_TaskLabels');
      refSheet.state = 'veryHidden'; // not just "hidden" (unhide via right-click) — not meant to be seen/edited at all
      uniqueLabels.forEach((label, i) => {
        refSheet.getCell(`A${i + 1}`).value = label;
      });

      const errorMessage =
        lang === 'sr'
          ? 'Ta labela ne postoji među zadacima ovog istraživanja.'
          : 'That label does not exist among this research\'s tasks.';
      for (let r = 2; r <= MAX_ROWS_PER_SHEET + 1; r++) {
        sheet.getCell(`C${r}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [`_TaskLabels!$A$1:$A$${uniqueLabels.length}`],
          showErrorMessage: true,
          errorStyle: 'error',
          error: errorMessage,
        };
      }
    }
  }

  /**
   * validTaskLabels: the research's real, non-Intro task labels, when the caller has them on hand
   * (see ParticipantImportComponent.loadFile). When provided, a Tasks row whose Task label isn't
   * in the set (including the Intro task's own label, which is deliberately never a valid Tasks-
   * sheet value) is flagged here too — client-side defense in depth on top of the template's own
   * Excel dropdown (which someone could still bypass by hand-typing a label, or by uploading an
   * old template downloaded before a task was added/renamed/removed).
   */
  async parseFile(
    file: File,
    validTaskLabels?: Set<string>,
    validGenericTaskTitles?: Set<string>,
    validGroupNames?: Set<string>,
    validPrTaskLabels?: Set<string>,
    validResearchTaskNames?: Set<string>
  ): Promise<ParsedImportFile> {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });

    const issues: ParseIssue[] = [];
    const participants: ParsedParticipantRow[] = [];
    const tasks: ParsedTaskRow[] = [];

    const participantsSheetName = this.findSheet(workbook, 'Participants');
    const tasksSheetName = this.findSheet(workbook, 'Tasks');

    if (!participantsSheetName && !tasksSheetName) {
      issues.push({
        sheet: '-',
        row: 0,
        message: 'Fajl mora sadržati bar jedan od listova "Participants" ili "Tasks".',
      });
      return { participants, tasks, issues, sheetsFound: workbook.SheetNames };
    }

    if (participantsSheetName) {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[participantsSheetName], {
        defval: null,
      });
      if (rows.length > MAX_ROWS_PER_SHEET) {
        issues.push({ sheet: 'Participants', row: 0, message: `Previše redova (maksimum ${MAX_ROWS_PER_SHEET}).` });
      }
      rows.slice(0, MAX_ROWS_PER_SHEET).forEach((row, i) => {
        const participantId = this.normalizeId(row['ParticipantId']);
        if (!participantId) {
          issues.push({ sheet: 'Participants', row: i + 1, message: 'ParticipantId je obavezan.' });
          return;
        }
        if (participantId.length > MAX_ID_LENGTH) {
          issues.push({ sheet: 'Participants', row: i + 1, message: `ParticipantId je predugačak (maks. ${MAX_ID_LENGTH}).` });
          return;
        }
        const email = this.normalizeText(row['Email'], MAX_EMAIL_LENGTH);
        const rawLanguage = this.normalizeText(row['Language'], 2)?.toLowerCase() ?? null;
        if (rawLanguage !== null && rawLanguage !== 'sr' && rawLanguage !== 'en') {
          issues.push({ sheet: 'Participants', row: i + 1, message: 'Language mora biti "sr", "en" ili prazno.' });
          return;
        }
        const genericTask = this.normalizeText(row['GenericTask'], MAX_NAME_LENGTH);
        if (genericTask !== null && validGenericTaskTitles && !validGenericTaskTitles.has(genericTask)) {
          issues.push({
            sheet: 'Participants',
            row: i + 1,
            message: `Zadatak "${genericTask}" ne postoji u ovom istraživanju — proverite naziv na stranici "Konfiguracija zadatka".`,
          });
          return;
        }
        const group = this.normalizeText(row['Group'], MAX_NAME_LENGTH);
        if (group !== null && validGroupNames && !validGroupNames.has(group.toLowerCase())) {
          issues.push({
            sheet: 'Participants',
            row: i + 1,
            message: `Grupa "${group}" ne postoji u ovom istraživanju — proverite naziv na stranici "Nacrt istraživanja".`,
          });
          return;
        }
        const prTask = this.normalizeText(row['Task'], MAX_NAME_LENGTH);
        if (prTask !== null && validPrTaskLabels && !validPrTaskLabels.has(prTask)) {
          issues.push({
            sheet: 'Participants',
            row: i + 1,
            message: `PR zadatak "${prTask}" ne postoji u ovom istraživanju — proverite naziv na stranici "Konfiguracija zadatka".`,
          });
          return;
        }
        const researchTask = this.normalizeText(row['ResearchTask'], MAX_NAME_LENGTH);
        if (researchTask !== null && validResearchTaskNames && !validResearchTaskNames.has(researchTask.toLowerCase())) {
          issues.push({
            sheet: 'Participants',
            row: i + 1,
            message: `Zadatak "${researchTask}" ne postoji u ovom istraživanju — proverite naziv na stranici "Nacrt istraživanja".`,
          });
          return;
        }
        participants.push({
          participantId,
          firstName: this.normalizeText(row['FirstName'], MAX_NAME_LENGTH),
          lastName: this.normalizeText(row['LastName'], MAX_NAME_LENGTH),
          email,
          language: rawLanguage,
          genericTask,
          group,
          prTask,
          researchTask,
        });
      });
    }

    if (tasksSheetName) {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[tasksSheetName], {
        defval: null,
      });
      if (rows.length > MAX_ROWS_PER_SHEET) {
        issues.push({ sheet: 'Tasks', row: 0, message: `Previše redova (maksimum ${MAX_ROWS_PER_SHEET}).` });
      }
      rows.slice(0, MAX_ROWS_PER_SHEET).forEach((row, i) => {
        const participantId = this.normalizeId(row['ParticipantId']);
        if (!participantId) {
          issues.push({ sheet: 'Tasks', row: i + 1, message: 'ParticipantId je obavezan.' });
          return;
        }
        const rawSession = this.normalizeText(row['Session'], 10)?.toUpperCase().trim() ?? null;
        if (rawSession !== 'AI' && rawSession !== 'REPORT') {
          issues.push({
            sheet: 'Tasks',
            row: i + 1,
            message: `Session mora biti "AI" ili "REPORT" (unešeno: "${row['Session'] ?? ''}").`,
          });
          return;
        }
        const taskLabel = this.normalizeText(row['Task'], MAX_NAME_LENGTH);
        if (!taskLabel) {
          issues.push({ sheet: 'Tasks', row: i + 1, message: 'Task je obavezan (Intro sesija se ne navodi ovde — dodaje se automatski).' });
          return;
        }
        if (validTaskLabels && !validTaskLabels.has(taskLabel)) {
          issues.push({
            sheet: 'Tasks',
            row: i + 1,
            message: `Labela "${taskLabel}" nije dodata među zadacima ovog istraživanja (ili je to Intro zadatak, koji se ne navodi ovde) — proverite na stranici "PR Configuration".`,
          });
          return;
        }
        tasks.push({ participantId, session: rawSession, taskLabel });
      });
    }

    return {
      participants: this.dedupeBy(participants, (p) => p.participantId),
      tasks: this.dedupeBy(tasks, (t) => `${t.participantId}:${t.session}`),
      issues,
      sheetsFound: workbook.SheetNames,
    };
  }

  private findSheet(workbook: XLSX.WorkBook, name: string): string | null {
    return workbook.SheetNames.find((n) => n.trim().toLowerCase() === name.toLowerCase()) ?? null;
  }

  private normalizeId(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    return str.length ? str : null;
  }

  private normalizeText(value: unknown, maxLength: number): string | null {
    if (value === null || value === undefined) return null;
    const str = String(value).trim().slice(0, maxLength);
    return str.length ? str : null;
  }

  // Preserves each key's FIRST-occurrence position (JS Map semantics: re-`set`-ing an existing
  // key updates its value but does not move it) while keeping its LAST value — this matters here
  // because the backend infers per-participant AI/Report order from row order, so a duplicate row
  // must not reshuffle where a participant's first Tasks entry sits relative to others.
  private dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
    const map = new Map<string, T>();
    for (const item of items) map.set(keyFn(item), item);
    return [...map.values()];
  }
}
