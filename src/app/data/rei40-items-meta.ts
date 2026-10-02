/**
 * REI-40 item metadata for the raw-answer drill-down (results-rei40/participant-detail pages).
 * Duplicated from rei40-andrejkatin/src/app/data/rei40-items.ts (scoring metadata) + its
 * assets/i18n/{sr,en}.json REI40.ITEM.<id> text, per this project's established per-app
 * duplication convention (GlobalHeaderComponent, ThemeService, email templates are all
 * duplicated the same way rather than shared).
 *
 * Two variants exist here: 'v1' (the full 40-item set) and 'short' (a 10-item subset of the same
 * pool — see rei40-andrejkatin's data/rei40-short-items.ts for why it's a transparent subset
 * rather than the official unpublished Norris/Pacini/Epstein REI-10; the ids/order below must
 * match REI_SHORT_RATIONALITY_IDS/REI_SHORT_EXPERIENTIALITY_IDS there exactly). A Rei40Result row
 * recording any other variant with no matching entry falls back to a generic "item text not
 * available" display (answer-detail-modal.component.ts).
 */

export type Rei40Subscale = 'RA' | 'RE' | 'EA' | 'EE';

export interface Rei40ItemMeta {
  id: number;
  subscale: Rei40Subscale;
  reverse: boolean;
  textSr: string;
  textEn: string;
}

export const REI40_SUBSCALE_ORDER: Rei40Subscale[] = ['RA', 'RE', 'EA', 'EE'];

export const REI40_ITEMS_META: Record<string, Rei40ItemMeta[]> = {
  v1: [
    { id: 1, subscale: 'RA', reverse: false, textSr: 'Imam logičan način razmišljanja.', textEn: 'I have a logical mind.' },
    { id: 2, subscale: 'RA', reverse: true, textSr: 'Nisam naročito dobar/ra u rešavanju komplikovanih problema.', textEn: 'I am not that good at figuring out complicated problems.' },
    { id: 3, subscale: 'RA', reverse: true, textSr: 'Pažljivo razmišljanje o stvarima nije jedna od mojih jačih strana.', textEn: 'Reasoning things out carefully is not one of my strong points.' },
    { id: 4, subscale: 'RA', reverse: true, textSr: 'Nisam naročito dobar/ra u rešavanju problema koji zahtevaju pažljivu logičku analizu.', textEn: 'I am not that good at solving problems that require careful logical analysis.' },
    { id: 5, subscale: 'RA', reverse: true, textSr: 'Ne razmišljam dobro pod pritiskom.', textEn: "I don't reason well under pressure." },
    { id: 6, subscale: 'RA', reverse: false, textSr: 'Mnogo sam bolji/a u logičkom rešavanju stvari nego većina ljudi.', textEn: 'I am much better at figuring things out logically than most people.' },
    { id: 7, subscale: 'RA', reverse: false, textSr: 'Obično imam jasne i objašnjive razloge za svoje odluke.', textEn: 'I usually have clear, explicable reasons for my decisions.' },
    { id: 8, subscale: 'RA', reverse: false, textSr: 'Nemam problem da pažljivo promislim o stvarima.', textEn: 'I have no problem thinking things through carefully.' },
    { id: 9, subscale: 'RA', reverse: false, textSr: 'Korišćenje logike mi obično dobro pomaže u rešavanju životnih problema.', textEn: 'Using logic usually works well for me in figuring out problems in my life.' },
    { id: 10, subscale: 'RA', reverse: true, textSr: 'Ne smatram sebe naročito analitičnim misliocem.', textEn: 'I am not a very analytical thinker.' },
    { id: 11, subscale: 'RE', reverse: true, textSr: 'Trudim se da izbegavam situacije koje zahtevaju duboko razmišljanje o nečemu.', textEn: 'I try to avoid situations that require thinking in depth about something.' },
    { id: 12, subscale: 'RE', reverse: false, textSr: 'Uživam u intelektualnim izazovima.', textEn: 'I enjoy intellectual challenges.' },
    { id: 13, subscale: 'RE', reverse: true, textSr: 'Ne volim kada moram mnogo da razmišljam.', textEn: "I don't like to have to do a lot of thinking." },
    { id: 14, subscale: 'RE', reverse: false, textSr: 'Uživam u rešavanju problema koji zahtevaju naporno razmišljanje.', textEn: 'I enjoy solving problems that require hard thinking.' },
    { id: 15, subscale: 'RE', reverse: true, textSr: 'Razmišljanje za mene nije pojam zabavne aktivnosti.', textEn: 'Thinking is not my idea of an enjoyable activity.' },
    { id: 16, subscale: 'RE', reverse: false, textSr: 'Više volim složene nego jednostavne probleme.', textEn: 'I prefer complex problems to simple problems.' },
    { id: 17, subscale: 'RE', reverse: true, textSr: 'Dugotrajno i naporno razmišljanje o nečemu mi pričinjava malo zadovoljstva.', textEn: 'Thinking hard and for a long time about something gives me little satisfaction.' },
    { id: 18, subscale: 'RE', reverse: false, textSr: 'Uživam u razmišljanju o apstraktnim pojmovima.', textEn: 'I enjoy thinking in abstract terms.' },
    { id: 19, subscale: 'RE', reverse: true, textSr: 'Dovoljno mi je da znam odgovor, a da ne moram da razumem logiku koja stoji iza njega.', textEn: 'Knowing the answer without understanding the reasoning behind it is good enough for me.' },
    { id: 20, subscale: 'RE', reverse: false, textSr: 'Učenje novih načina razmišljanja mi je veoma privlačno.', textEn: 'Learning new ways to think would be very appealing to me.' },
    { id: 21, subscale: 'EA', reverse: true, textSr: 'Nemam naročito dobar osećaj za intuiciju.', textEn: "I don't have a very good sense of intuition." },
    { id: 22, subscale: 'EA', reverse: false, textSr: 'Oslanjanje na unutrašnji osećaj mi obično pomaže u rešavanju životnih problema.', textEn: 'Relying on my gut feelings usually works well for me in figuring out problems in my life.' },
    { id: 23, subscale: 'EA', reverse: false, textSr: 'Verujem da treba verovati predosećajima.', textEn: 'I believe in trusting my hunches.' },
    { id: 24, subscale: 'EA', reverse: false, textSr: 'Verujem svojim prvim utiscima o ljudima.', textEn: 'I trust my initial feelings about people.' },
    { id: 25, subscale: 'EA', reverse: false, textSr: 'Kada je u pitanju poverenje u ljude, obično se mogu osloniti na svoj unutrašnji osećaj.', textEn: 'When it comes to trusting people, I can usually rely on my gut feelings.' },
    { id: 26, subscale: 'EA', reverse: true, textSr: 'Kada bih se oslanjao/la na svoje unutrašnje osećaje, često bih grešio/la.', textEn: 'If I were to rely on my gut feelings, I would often be wrong.' },
    { id: 27, subscale: 'EA', reverse: false, textSr: 'Retko kada pogrešim kada slušam svoje najdublje unutrašnje osećaje da bih pronašao/la odgovor.', textEn: 'I rarely make mistakes when I listen to my deepest gut feelings to find an answer.' },
    { id: 28, subscale: 'EA', reverse: true, textSr: 'Moje brzoplete procene verovatno nisu tako dobre kao kod većine ljudi.', textEn: "My snap judgments are probably not as good as most people's." },
    { id: 29, subscale: 'EA', reverse: false, textSr: 'Obično mogu da osetim da li je osoba u pravu ili ne, čak i ako ne mogu da objasnim kako to znam.', textEn: "I can usually feel when a person is right or wrong, even if I can't explain how I know." },
    { id: 30, subscale: 'EA', reverse: true, textSr: 'Sumnjam da su moji predosećaji podjednako često netačni koliko i tačni.', textEn: 'I suspect my hunches are inaccurate as often as they are accurate.' },
    { id: 31, subscale: 'EE', reverse: false, textSr: 'Volim da se oslanjam na svoje intuitivne utiske.', textEn: 'I like to rely on my intuitive impressions.' },
    { id: 32, subscale: 'EE', reverse: false, textSr: 'Intuicija može biti veoma koristan način za rešavanje problema.', textEn: 'Intuition can be a very useful way to solve problems.' },
    { id: 33, subscale: 'EE', reverse: false, textSr: 'Često se vodim instinktima kada odlučujem o daljim koracima.', textEn: 'I often go by my instincts when deciding on a course of action.' },
    { id: 34, subscale: 'EE', reverse: true, textSr: 'Ne volim situacije u kojima moram da se oslonim na intuiciju.', textEn: "I don't like situations in which I have to rely on intuition." },
    { id: 35, subscale: 'EE', reverse: false, textSr: 'Mislim da postoje situacije kada se treba osloniti na intuiciju.', textEn: 'I think there are times when one should rely on one\'s intuition.' },
    { id: 36, subscale: 'EE', reverse: true, textSr: 'Smatram da je glupo donositi važne odluke na osnovu osećanja.', textEn: 'I think it is foolish to make important decisions based on feelings.' },
    { id: 37, subscale: 'EE', reverse: true, textSr: 'Mislim da nije dobra ideja oslanjati se na intuiciju kod važnih odluka.', textEn: "I don't think it is a good idea to rely on one's intuition for important decisions." },
    { id: 38, subscale: 'EE', reverse: true, textSr: 'Generalno ne zavisim od svojih osećanja pri donošenju odluka.', textEn: "I generally don't depend on my feelings to help me make decisions." },
    { id: 39, subscale: 'EE', reverse: true, textSr: 'Ne bih želeo/la da zavisim od bilo koga ko sebe opisuje kao intuitivnu osobu.', textEn: 'I would not want to depend on anyone who described himself or herself as intuitive.' },
    { id: 40, subscale: 'EE', reverse: false, textSr: 'Sklon/a sam tome da koristim srce kao vodič za svoje postupke.', textEn: 'I tend to use my heart as a guide for my actions.' },
  ],
};

// Short-form ids: RA {1,2,6} + RE {11,12} (rationality side), EA {21,22,26} + EE {31,34}
// (experientiality side) — kept in this exact order to match rei40-short-items.ts.
const REI_SHORT_IDS = [1, 2, 6, 11, 12, 21, 22, 26, 31, 34];
REI40_ITEMS_META['short'] = REI40_ITEMS_META['v1'].filter((item) => REI_SHORT_IDS.includes(item.id));
