/**
 * Big Five (OCEAN) item metadata for the raw-answer drill-down (results-bigfive/participant-
 * detail pages). Duplicated from bigfive-andrejkatin/src/app/data/bigfive-items.ts (scoring
 * metadata) + its assets/i18n/{sr,en}.json BIGFIVE.ITEM.<id> text, per this project's
 * established per-app duplication convention. No variant concept for Big Five (out of scope).
 */

export type BigFiveFactor = 'O' | 'C' | 'E' | 'A' | 'N';

export interface BigFiveItemMeta {
  id: number;
  factor: BigFiveFactor;
  textSr: string;
  textEn: string;
}

export const BIGFIVE_FACTOR_ORDER: BigFiveFactor[] = ['O', 'C', 'E', 'A', 'N'];

export const BIGFIVE_ITEMS_META: BigFiveItemMeta[] = [
  { id: 1, factor: 'O', textSr: 'Uživam u istraživanju novih ideja i koncepata.', textEn: 'I enjoy exploring new ideas and concepts.' },
  { id: 2, factor: 'O', textSr: 'Lako prihvatam nepoznate situacije.', textEn: 'I easily adapt to unfamiliar situations.' },
  { id: 3, factor: 'O', textSr: 'Uživam u umetnosti i kreativnim aktivnostima.', textEn: 'I enjoy art and creative activities.' },
  { id: 4, factor: 'O', textSr: 'Uvek tražim nove načine za obavljanje stvari.', textEn: 'I always look for new ways of doing things.' },
  { id: 5, factor: 'O', textSr: 'Volim da čitam knjige koje me podstiču na razmišljanje.', textEn: 'I like reading books that make me think.' },
  { id: 6, factor: 'O', textSr: 'Uživam u diskusijama o apstraktnim temama.', textEn: 'I enjoy discussing abstract topics.' },
  { id: 7, factor: 'C', textSr: 'Završavam zadatke na vreme, čak i kada su složeni.', textEn: 'I complete tasks on time, even when they are complex.' },
  { id: 8, factor: 'C', textSr: 'Veoma sam organizovan/a u svakodnevnim obavezama.', textEn: 'I am very organized in my daily responsibilities.' },
  { id: 9, factor: 'C', textSr: 'Obraćam pažnju na detalje prilikom izvršavanja zadataka.', textEn: 'I pay attention to detail when carrying out tasks.' },
  { id: 10, factor: 'C', textSr: 'Postavljam sebi visoke ciljeve i naporno radim da ih ostvarim.', textEn: 'I set high goals for myself and work hard to achieve them.' },
  { id: 11, factor: 'C', textSr: 'Retko odlažem zadatke za kasnije.', textEn: 'I rarely put off tasks for later.' },
  { id: 12, factor: 'E', textSr: 'Uživam u druženju sa velikim grupama ljudi.', textEn: 'I enjoy socializing with large groups of people.' },
  { id: 13, factor: 'E', textSr: 'Lako započinjem razgovor sa nepoznatim osobama.', textEn: 'I easily start conversations with strangers.' },
  { id: 14, factor: 'E', textSr: 'Uživam u tome da budem u centru pažnje.', textEn: 'I enjoy being the center of attention.' },
  { id: 15, factor: 'E', textSr: 'Često iniciram društvene aktivnosti.', textEn: 'I often initiate social activities.' },
  { id: 16, factor: 'E', textSr: 'Uživam u upoznavanju novih ljudi.', textEn: 'I enjoy meeting new people.' },
  { id: 17, factor: 'E', textSr: 'Uživam u aktivnostima koje podrazumevaju timski rad.', textEn: 'I enjoy activities that involve teamwork.' },
  { id: 18, factor: 'A', textSr: 'Trudim se da izbegavam konflikte sa drugima.', textEn: 'I try to avoid conflicts with others.' },
  { id: 19, factor: 'A', textSr: 'Često pomažem drugima, čak i kada to nije moja obaveza.', textEn: "I often help others, even when it's not my responsibility." },
  { id: 20, factor: 'A', textSr: 'Verujem da je važno biti ljubazan prema svima.', textEn: "I believe it's important to be kind to everyone." },
  { id: 21, factor: 'A', textSr: 'Lako opraštam drugima kada me povrede.', textEn: 'I easily forgive others when they hurt me.' },
  { id: 22, factor: 'A', textSr: 'Uživam u radu u harmoničnom okruženju.', textEn: 'I enjoy working in a harmonious environment.' },
  { id: 23, factor: 'A', textSr: 'Trudim se da razumem osećanja drugih ljudi.', textEn: "I try to understand other people's feelings." },
  { id: 24, factor: 'N', textSr: 'Često brinem o stvarima koje se možda neće ni desiti.', textEn: 'I often worry about things that might not even happen.' },
  { id: 25, factor: 'N', textSr: 'Teško mi je da se smirim nakon stresnih situacija.', textEn: 'I find it hard to calm down after stressful situations.' },
  { id: 26, factor: 'N', textSr: 'Često se osećam napeto i anksiozno.', textEn: 'I often feel tense and anxious.' },
  { id: 27, factor: 'N', textSr: 'Lako se uzrujam kada stvari ne idu po planu.', textEn: "I get upset easily when things don't go according to plan." },
  { id: 28, factor: 'N', textSr: 'Ponekad se osećam preopterećeno čak i jednostavnim zadacima.', textEn: 'I sometimes feel overwhelmed even by simple tasks.' },
  { id: 29, factor: 'N', textSr: 'Sklon/a sam preteranoj analizi negativnih situacija.', textEn: 'I tend to overanalyze negative situations.' },
];
