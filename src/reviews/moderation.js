/**
 * Which written reviews the public review page may show, and why the others are held.
 *
 * The page is advertising in BPOM's sense (PerBPOM 34/2022 counts a static online display
 * as an advertisement), so a buyer's sentence there is held to the advertising rules:
 * no disease or recovery claims (Lampiran I.17, III.22), no vitality or anti-ageing
 * impressions (I.5, I.6), no "guaranteed". The rule is about the words, never about the
 * stars - a five-star review that says "my diabetes is gone" is held exactly like a
 * two-star one that says "did nothing for my cholesterol", and every held review's rating
 * still counts in the summary. That symmetry is what the FTC's review rule (16 CFR 465)
 * and the EU Omnibus directive ask of any moderation.
 *
 * Contact details are held too: a phone number or address typed into a marketplace
 * review was written for that marketplace, not for the open web.
 *
 * The list errs towards holding. A held review costs one card; a shown claim can cost
 * the product's registration.
 */

export const MODERATION_POLICY_VERSION = '2026-10-30';

const HEALTH = [
  // diseases and conditions
  'sembuh', 'menyembuhkan', 'penyembuh', 'obat', 'penyakit', 'diabetes', 'diabet', 'gula darah', 'kolesterol', 'hipertensi',
  'darah tinggi', 'tensi', 'asam urat', 'kanker', 'tumor', 'maag', 'gerd', 'lambung', 'asma', 'stroke', 'jantung', 'ginjal',
  'liver', 'hati berlemak', 'anemia', 'kista', 'miom', 'autoimun', 'tiroid', 'radang', 'infeksi', 'alergi', 'eksim', 'eczema',
  'psoriasis', 'jerawat', 'acne', 'ruam', 'gatal',
  // symptoms and body functions
  'nyeri', 'sakit', 'pegal', 'linu', 'sendi', 'kaku', 'kram', 'pusing', 'migrain', 'migraine', 'sembelit', 'konstipasi', 'kembung',
  'pencernaan', 'bab', 'diare', 'insomnia', 'tidur', 'nyenyak', 'menopause', 'menopouse', 'premenopause', 'menopose', 'haid',
  'menstruasi', 'hormon', 'hormone', 'asi', 'menyusui', 'kesuburan', 'promil', 'hamil', 'imun', 'imunitas', 'daya tahan',
  'kebal', 'berat badan', 'turun berat', 'diet', 'langsing', 'kurus', 'gemuk', 'detox', 'detoks', 'rambut rontok',
  'hair fall', 'hair loss', 'trigger finger',
  // vitality, youth, guarantees
  'energi', 'berenergi', 'stamina', 'bugar', 'vitalitas', 'awet muda', 'anti aging', 'anti-aging', 'antiaging', 'kerutan',
  'dijamin', 'keluhan', 'multivitamin', 'pasti ampuh', 'ampuh', 'manjur', 'mujarab', 'khasiat', 'berkhasiat',
  // English
  'cure', 'cured', 'heal', 'healed', 'healing', 'disease', 'pain', 'joint', 'arthritis', 'inflammation', 'blood sugar',
  'blood pressure', 'cholesterol', 'diabetes', 'cancer', 'sleep', 'menopause', 'menopausal', 'period', 'hormonal', 'fertility',
  'breast milk', 'immune', 'immunity', 'digestion', 'bloating', 'constipation', 'weight loss', 'lose weight', 'energy',
  'energized', 'energised', 'stamina', 'fatigue', 'brain fog', 'anti-ageing', 'wrinkle', 'wrinkles', 'eczema', 'rash',
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole words only: "bab" must not hold "abab", "asi" must not hold "biasa" or "sesuai".
// Indonesian clitics still count: "khasiatnya", "sakitku" are the same claim.
const HEALTH_RE = new RegExp(`(^|[^\\p{L}\\p{N}])(${HEALTH.map(escape).join('|')})(?:nya|ku|mu|lah)?(?=$|[^\\p{L}\\p{N}])`, 'iu');
const CONTACT_RE = /(\+?62|\b0)8\d[\d\s-]{7,}|\b[\w.+-]+@[\w-]+\.[\w.]+\b|\bwa\.me\/|\bjl\.?\s/i;

/** @returns {{show: true} | {show: false, reason: 'health_claim' | 'contact', match?: string}} */
export function moderate(text) {
  const body = String(text ?? '');
  const health = body.match(HEALTH_RE);
  if (health) return { show: false, reason: 'health_claim', match: health[2].toLowerCase() };
  if (CONTACT_RE.test(body)) return { show: false, reason: 'contact' };
  return { show: true };
}
